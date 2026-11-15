import type {
  BatchRequest,
  Destination,
  FailureRow,
  ItemResult,
  PlatformAdapter,
  RunStatus,
  SyncAction,
} from '../types.js';
import type { AppRepo } from '../db/appRepo.js';
import type { Warehouse } from '../db/warehouse.js';
import { PlatformHttpError } from '../platform/adapter.js';
import { hashPhone } from './hash.js';
import { normalizePhone } from './phone.js';
import { RateLimiterRegistry } from './rateLimiter.js';
import { businessDate as todayBusinessDate, nowIso } from './time.js';
import { makeId } from '../db/sqlite.js';

export interface RetryResult {
  retryRunId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  resolvedFailureIds: number[];
  remainingFailureIds: number[];
  status: RunStatus;
  errors: string[];
}

const MAX_BATCH_LIMIT = 500;

/**
 * Re-sends only the items that previously failed. Successful items are never
 * retransmitted. Failures are grouped by destination + task + audience + action.
 */
export class RetryService {
  private readonly limiters: RateLimiterRegistry;

  constructor(
    private readonly repo: AppRepo,
    private readonly warehouse: Warehouse,
    private readonly adapter: PlatformAdapter,
    limiters?: RateLimiterRegistry,
  ) {
    // Reuse the engine's limiter registry when provided, so a retry and a live
    // run cannot together exceed the destination's per-second budget.
    this.limiters =
      limiters ??
      new RateLimiterRegistry((destinationId) => {
        return this.repo.getDestination(destinationId)?.config.requestsPerSecond ?? 5;
      });
  }

  async retry(
    destinationId: string,
    options: { failureIds?: number[]; actor?: string } = {},
  ): Promise<RetryResult> {
    const destination = this.repo.getDestination(destinationId);
    if (!destination) throw new Error('目的地不存在');
    if (!destination.enabled) throw new Error('目的地已停用, 无法重试');

    const failures = this.repo.listOpenFailuresForRetry(destinationId, options.failureIds);
    const retryRunId = makeId('retry');
    const bdate = todayBusinessDate();
    const result: RetryResult = {
      retryRunId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      resolvedFailureIds: [],
      remainingFailureIds: [],
      status: 'completed',
      errors: [],
    };
    if (!failures.length) {
      result.status = 'completed';
      return result;
    }

    // Resolve live suppression/phone state before retrying.
    const userIds = [...new Set(failures.map((f) => f.userId))];
    const users = this.warehouse.getUsers(userIds);

    // Remaining quota for today, taking the smaller of local and platform
    // budgets. Retried adds consume the same quota as fresh adds.
    this.repo.ensureUsageRow(destination.id, bdate);
    const usage = this.repo.getUsage(destination.id, bdate);
    let quotaLeft = Math.max(0, destination.config.dailyQuota - usage.used - usage.reserved);
    try {
      const platformUsage = await this.adapter.getUsage(destination, bdate);
      quotaLeft = Math.min(quotaLeft, Math.max(0, platformUsage.remaining));
    } catch {
      // fall back to local budget
    }

    const groups = new Map<string, FailureRow[]>();
    for (const failure of failures) {
      const key = [failure.taskId, failure.segmentId, failure.action].join('|');
      const list = groups.get(key) ?? [];
      list.push(failure);
      groups.set(key, list);
    }

    for (const [, group] of groups) {
      const action = group[0]!.action as SyncAction;
      const taskId = group[0]!.taskId;
      const task = this.repo.getTask(taskId);
      if (!task) {
        result.remainingFailureIds.push(...group.map((f) => f.id));
        result.failed += group.length;
        result.errors.push(`任务 ${taskId} 已删除, 无法重试`);
        continue;
      }

      const usable: FailureRow[] = [];
      const leftSegment: FailureRow[] = [];
      for (const failure of group) {
        const user = users.get(failure.userId);
        if (!user) {
          // User no longer exists in the warehouse. For a `remove` the platform
          // entry must still be cleared, so retry it. For an `add` there is
          // nothing legitimate to push: drop the failure.
          if (action === 'remove') {
            usable.push(failure);
          } else {
            this.repo.resolveFailure(failure.id, '用户已不在数仓, 放弃推送');
            result.resolvedFailureIds.push(failure.id);
            result.attempted += 1;
          }
          continue;
        }
        if (action === 'add' && user.suppressed) {
          this.repo.resolveFailure(failure.id, '用户已退订/拉黑, 不再推送');
          result.resolvedFailureIds.push(failure.id);
          result.attempted += 1;
          result.succeeded += 1;
          continue;
        }
        // A stale `add` failure whose user has since left the segment must not
        // be retried — that would put someone on the platform who should not be
        // there. Handled in bulk below (one platform snapshot per task).
        if (action === 'add' && !this.isSegmentMember(task.segmentId, failure.userId)) {
          leftSegment.push(failure);
          continue;
        }
        usable.push(failure);
      }

      if (leftSegment.length) {
        // Platform membership is tracked locally in task_members: a user who
        // failed to add was never recorded, so a stale failure simply resolves.
        const synced = this.repo.syncedMembers(taskId);
        for (const failure of leftSegment) {
          this.repo.resolveFailure(
            failure.id,
            synced.has(failure.userId)
              ? '用户已离开分群, 本次不再新增 (平台名单将由后续同步移出)'
              : '用户已离开分群, 放弃新增',
          );
          this.repo.deleteSyncedMembers(taskId, [failure.userId]);
          result.resolvedFailureIds.push(failure.id);
          result.attempted += 1;
        }
      }

      const batchSize = Math.min(destination.config.batchSize, MAX_BATCH_LIMIT);
      // Respect the cross-audience SMS daily ledger during retry too: a phone
      // that already received a text today must be re-added without another text.
      const alreadyTextedToday =
        destination.platform === 'sms' ? this.repo.phonesAlreadyTexted(bdate) : new Set<string>();
      // Retried adds consume today's quota. Anything beyond what is left stays
      // open for a later retry rather than being forced through.
      let batchUsable = usable;
      if (action === 'add' && usable.length > quotaLeft) {
        const over = usable.slice(quotaLeft);
        batchUsable = usable.slice(0, quotaLeft);
        for (const failure of over) result.remainingFailureIds.push(failure.id);
        quotaLeft = 0;
      } else if (action === 'add') {
        quotaLeft -= usable.length;
      }
      for (let offset = 0; offset < batchUsable.length; offset += batchSize) {
        const slice = batchUsable.slice(offset, offset + batchSize);
        await this.limiters.get(destination.id).acquire();
        const batchId = `${retryRunId}:${taskId}:${action}:${offset / batchSize}`;
        // Decide sendSms once per phone within this slice so two users sharing
        // a phone cannot both trigger a text.
        const plannedThisBatch = new Set<string>();
        const request: BatchRequest = {
          audienceId: task.audienceId,
          action,
          businessDate: bdate,
          batchId,
          contacts: slice.map((failure) => {
            const user = users.get(failure.userId);
            const phone = user ? normalizePhone(user.phone) : '';
            let sendSms: boolean | undefined;
            if (action === 'add' && destination.platform === 'sms') {
              sendSms = !alreadyTextedToday.has(phone) && !plannedThisBatch.has(phone);
              if (sendSms && phone) plannedThisBatch.add(phone);
            }
            return {
              userId: failure.userId,
              ...(action === 'add' && phone ? { phoneHash: hashPhone(phone, destination.config.hash) } : {}),
              ...(sendSms === undefined ? {} : { sendSms }),
            };
          }),
        };

        result.attempted += slice.length;
        let response: Awaited<ReturnType<PlatformAdapter['sendBatch']>> | null = null;
        let httpError: string | null = null;
        try {
          response = await this.adapter.sendBatch(destination, request);
        } catch (error) {
          httpError = error instanceof PlatformHttpError ? `HTTP ${error.status}` : (error as Error).message;
        }

        if (!response) {
          result.failed += slice.length;
          result.remainingFailureIds.push(...slice.map((f) => f.id));
          result.errors.push(`批次 ${batchId} 失败: ${httpError}`);
          for (const failure of slice) this.bump(failure, httpError ?? '未知错误');
          continue;
        }

        const byUser = new Map(response.results.map((r) => [r.userId, r]));
        for (const failure of slice) {
          const item: ItemResult | undefined = byUser.get(failure.userId);
          if (!item) {
            // No explicit result: re-issue one by one on the next retry.
            result.failed += 1;
            result.remainingFailureIds.push(failure.id);
            this.bump(failure, '平台未返回该项结果');
            continue;
          }
          if (item.ok) {
            result.succeeded += 1;
            result.resolvedFailureIds.push(failure.id);
            this.repo.resolveFailure(failure.id, `重试成功 (${retryRunId})`);
            const user = users.get(failure.userId);
            if (action === 'add' && user) {
              this.repo.upsertSyncedMembers(taskId, [
                { userId: failure.userId, phoneHash: hashPhone(user.phone, destination.config.hash) },
              ]);
              // Record the text so a later task the same day does not resend it.
              if (destination.platform === 'sms' && !alreadyTextedToday.has(normalizePhone(user.phone))) {
                this.repo.recordSmsSend(bdate, normalizePhone(user.phone), taskId, retryRunId);
                alreadyTextedToday.add(normalizePhone(user.phone));
              }
            } else if (action === 'remove') {
              this.repo.deleteSyncedMembers(taskId, [failure.userId]);
            }
            this.repo.insertLog({
              runId: retryRunId,
              taskId,
              destinationId: destination.id,
              segmentId: failure.segmentId,
              userId: failure.userId,
              action,
              phoneHash: action === 'add' && user ? hashPhone(user.phone, destination.config.hash) : null,
              status: 'success',
              deduped: 0,
              errorCode: null,
              errorMessage: null,
              attemptNo: failure.attempts + 1,
              batchId,
              latencyMs: response.latencyMs,
              businessDate: bdate,
              createdAt: nowIso(),
            });
          } else {
            result.failed += 1;
            result.remainingFailureIds.push(failure.id);
            this.bump(failure, item.errorMessage ?? item.errorCode ?? '重试失败', item.errorCode);
            this.repo.insertLog({
              runId: retryRunId,
              taskId,
              destinationId: destination.id,
              segmentId: failure.segmentId,
              userId: failure.userId,
              action,
              phoneHash: action === 'add' && users.get(failure.userId)
                ? hashPhone(users.get(failure.userId)!.phone, destination.config.hash)
                : null,
              status: 'failed',
              deduped: 0,
              errorCode: item.errorCode ?? 'unknown',
              errorMessage: item.errorMessage ?? null,
              attemptNo: failure.attempts + 1,
              batchId,
              latencyMs: response.latencyMs,
              businessDate: bdate,
              createdAt: nowIso(),
            });
          }
        }
      }
    }

    // Roll today's real usage forward from the success log so retried adds are
    // reflected in the shared daily budget.
    this.repo.reconcileUsage(bdate);

    result.status =
      result.failed === 0 ? 'completed' : result.succeeded > 0 ? 'partial' : 'failed';
    this.repo.audit(options.actor ?? 'operator', 'retry', destinationId, {
      retryRunId,
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
    });
    return result;
  }

  private isSegmentMember(segmentId: string, userId: string): boolean {
    return this.warehouse.isSegmentMember(segmentId, userId);
  }

  private bump(failure: FailureRow, message: string, errorCode?: string | null): void {
    // Keep the last observed error code, defaulting to the previous one when the
    // caller only has a message (e.g. an HTTP-level failure).
    this.repo.bumpFailure(failure.id, errorCode ?? failure.errorCode, message, failure.runId);
  }
}

