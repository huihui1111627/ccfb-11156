import type {
  BatchRequest,
  Destination,
  ItemResult,
  PlatformAdapter,
  RunPreview,
  RunStatus,
  RunSummary,
  SyncAction,
  TaskDiff,
  TaskRunStats,
} from '../types.js';
import type { AppRepo } from '../db/appRepo.js';
import type { Warehouse } from '../db/warehouse.js';
import { PlatformHttpError } from '../platform/adapter.js';
import { hashPhone } from './hash.js';
import { normalizePhone } from './phone.js';
import { RateLimiterRegistry, backoff } from './rateLimiter.js';
import { nowIso } from './time.js';

export interface SyncEngineDeps {
  repo: AppRepo;
  warehouse: Warehouse;
  adapter: PlatformAdapter;
  now?: () => Date;
  onEvent?: (event: SyncEvent) => void;
}

export type SyncEvent =
  | { type: 'run_started'; runId: string }
  | { type: 'task_started'; runId: string; taskId: string; adds: number; removes: number }
  | {
      type: 'batch';
      runId: string;
      taskId: string;
      batchId: string;
      action: SyncAction;
      size: number;
      ok: number;
      failed: number;
    }
  | { type: 'task_finished'; runId: string; taskId: string; stats: TaskRunStats }
  | { type: 'run_finished'; runId: string; status: RunStatus; summary: RunSummary };

interface WorkItem {
  userId: string;
  phone: string;
}

interface RetryItem {
  userId: string;
  phone: string;
  sendSms: boolean;
  deduped: boolean;
  error: ItemResult;
}

interface TaskExecution {
  diff: TaskDiff;
  destination: Destination;
}

interface ProcessResult {
  /** Items the platform accepted (includes idempotent re-adds). */
  succeeded: number;
  /** Accepted adds that consumed platform quota. */
  billed: number;
  failed: number;
  deduped: number;
  requests: number;
  smsRecorded: Array<{ phone: string }>;
}

const MAX_BATCH_LIMIT = 500;

/**
 * Pushes one preview's diffs to their destinations.
 *
 * Guarantees:
 *  - only adds/removes from the preview are sent (never a full retransmit)
 *  - suppression is re-checked at execution time
 *  - quota is reserved before sending and settled with actual accepted adds
 *  - SMS text dedupe is cross-audience and per business day
 *  - per-item failures are retried, remaining ones land in `failures`
 */
export class SyncEngine {
  private readonly limiters: RateLimiterRegistry;

  /** Shared with RetryService so retries and runs obey one rate budget. */
  get rateLimiters(): RateLimiterRegistry {
    return this.limiters;
  }
  private running = false;

  constructor(private readonly deps: SyncEngineDeps) {
    this.limiters = new RateLimiterRegistry((destinationId) => {
      const destination = deps.repo.getDestination(destinationId);
      return destination?.config.requestsPerSecond ?? 5;
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  async execute(preview: RunPreview, options: { confirmed?: boolean } = {}): Promise<RunSummary> {
    if (this.running) throw new Error('已有同步任务在执行, 请稍后再试');
    if (preview.requiresConfirmation && !options.confirmed) {
      throw new Error('影响人数超过阈值, 需要人工确认后才能执行');
    }
    this.running = true;
    const repo = this.deps.repo;
    // Clear any reservation a previously crashed run left behind, and resync
    // used counts from the success log, before computing this run's budget.
    repo.reconcileUsage(preview.businessDate);
    repo.insertRun(preview);
    repo.markRunStarted(preview.runId);
    if (options.confirmed) repo.markRunConfirmed(preview.runId);
    this.emit({ type: 'run_started', runId: preview.runId });

    const stats: TaskRunStats[] = [];
    let requests = 0;
    try {
      for (const diff of preview.tasks) {
        const destination = repo.getDestination(diff.destinationId);
        if (!destination) {
          stats.push(failedStats(diff, '目的地已删除'));
          continue;
        }
        if (!destination.enabled) {
          stats.push(failedStats(diff, '目的地已停用'));
          continue;
        }
        const result = await this.executeTask(preview, { diff, destination });
        requests += result.requests;
        stats.push(result.stats);
        this.emit({
          type: 'task_finished',
          runId: preview.runId,
          taskId: diff.taskId,
          stats: result.stats,
        });
      }

      const summary = buildSummary(preview, stats, requests);
      repo.finishRun(preview.runId, summary.status, summary);
      this.emit({ type: 'run_finished', runId: preview.runId, status: summary.status, summary });
      return summary;
    } catch (error) {
      const summary = buildSummary(preview, stats, requests, (error as Error).message);
      repo.finishRun(preview.runId, 'failed', summary);
      this.emit({ type: 'run_finished', runId: preview.runId, status: 'failed', summary });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async executeTask(
    preview: RunPreview,
    exec: TaskExecution,
  ): Promise<{ stats: TaskRunStats; requests: number }> {
    const { repo, warehouse } = this.deps;
    const { diff, destination } = exec;
    const taskId = diff.taskId;
    const bdate = preview.businessDate;
    let requests = 0;

    this.emit({
      type: 'task_started',
      runId: preview.runId,
      taskId,
      adds: diff.adds.length,
      removes: diff.removes.length,
    });

    // Re-validate against live warehouse suppression state: someone may have
    // opted out between preview and execution.
    const memberIds = [...new Set([...diff.adds, ...diff.removes])];
    const members = warehouse.getUsers(memberIds);
    const liveAdds: WorkItem[] = [];
    const liveRemoves: WorkItem[] = [];
    const blockedNow: string[] = [];
    for (const userId of diff.adds) {
      const member = members.get(userId);
      if (!member || member.suppressed) {
        blockedNow.push(userId);
        continue;
      }
      liveAdds.push({ userId, phone: normalizePhone(member.phone) });
    }
    for (const userId of diff.removes) {
      const member = members.get(userId);
      // The user may have been hard-deleted from the warehouse. The remove
      // still must happen on the platform, otherwise the stale membership and
      // our task_members row linger forever and every later diff repeats it.
      liveRemoves.push({ userId, phone: member ? normalizePhone(member.phone) : '' });
    }
    for (const userId of blockedNow) {
      repo.insertLog({
        runId: preview.runId,
        taskId,
        destinationId: destination.id,
        segmentId: diff.segmentId,
        userId,
        action: 'add',
        phoneHash: null,
        status: 'failed',
        deduped: 0,
        errorCode: 'suppressed',
        errorMessage: '用户在预览后进入退订/黑名单, 已拦截',
        attemptNo: 0,
        batchId: 'preflight',
        latencyMs: 0,
        businessDate: bdate,
        createdAt: nowIso(),
      });
    }

    // ---- quota reservation ----
    // Local budget comes from config; the platform's own remaining quota is
    // authoritative. Use whichever is smaller so we never send into a 429/超额.
    repo.ensureUsageRow(destination.id, bdate);
    const usage = repo.getUsage(destination.id, bdate);
    let quotaRemaining = Math.max(0, destination.config.dailyQuota - usage.used - usage.reserved);
    try {
      const platformUsage = await this.deps.adapter.getUsage(destination, bdate);
      quotaRemaining = Math.min(quotaRemaining, Math.max(0, platformUsage.remaining));
    } catch {
      // Platform unreachable: fall back to the local budget and let the send fail.
    }
    const available = quotaRemaining;
    const toSend = liveAdds.slice(0, available);
    const deferred = liveAdds.slice(available);
    repo.reserveQuota(destination.id, bdate, toSend.length);

    // ---- SMS cross-audience daily dedupe ----
    const alreadyTexted = destination.platform === 'sms' ? repo.phonesAlreadyTexted(bdate) : new Set<string>();
    const plannedPhones = new Set<string>();
    const sendPlan: Array<{ item: WorkItem; sendSms: boolean; deduped: boolean }> = [];
    for (const item of toSend) {
      let sendSms = true;
      if (destination.platform === 'sms' && destination.config.smsDailyDedupe) {
        if (alreadyTexted.has(item.phone) || plannedPhones.has(item.phone)) {
          sendSms = false;
        } else {
          plannedPhones.add(item.phone);
        }
      }
      sendPlan.push({ item, sendSms, deduped: !sendSms });
    }

    let addStats: Awaited<ReturnType<SyncEngine['processItems']>> | null = null;
    let removeStats: Awaited<ReturnType<SyncEngine['processItems']>> | null = null;
    try {
      addStats = await this.processItems(preview, diff, destination, 'add', sendPlan, true);
      requests += addStats.requests;

      // Removes are never quota-limited and never deduped.
      removeStats = await this.processItems(
        preview,
        diff,
        destination,
        'remove',
        liveRemoves.map((item) => ({ item, sendSms: false, deduped: false })),
        true,
      );
      requests += removeStats.requests;
    } finally {
      // Always settle the reservation, even if a send threw partway through.
      // Otherwise a crashed task leaves the day's budget permanently reserved
      // and starves every later run of this destination. The platform enforces
      // its own hard quota, so a slight local undercount after a crash is safe.
      repo.settleQuota(destination.id, bdate, toSend.length, addStats?.billed ?? 0);
    }
    if (!addStats) throw new Error('add 批次未完成');
    if (!removeStats) throw new Error('remove 批次未完成');

    if (destination.platform === 'sms') {
      for (const record of addStats.smsRecorded) {
        repo.recordSmsSend(bdate, record.phone, taskId, preview.runId);
      }
    }

    for (const item of deferred) {
      repo.insertLog({
        runId: preview.runId,
        taskId,
        destinationId: destination.id,
        segmentId: diff.segmentId,
        userId: item.userId,
        action: 'add',
        phoneHash: hashPhone(item.phone, destination.config.hash),
        status: 'deferred',
        deduped: 0,
        errorCode: 'quota_exhausted',
        errorMessage: '目的地今日配额已用尽, 顺延到次日',
        attemptNo: 0,
        batchId: 'quota',
        latencyMs: 0,
        businessDate: bdate,
        createdAt: nowIso(),
      });
    }

    const stats: TaskRunStats = {
      taskId,
      adds: diff.adds.length,
      removes: diff.removes.length,
      addSuccess: addStats.succeeded,
      removeSuccess: removeStats.succeeded,
      failed: addStats.failed + removeStats.failed + blockedNow.length,
      deferred: deferred.length,
      deduped: addStats.deduped,
    };
    return { stats, requests };
  }

  private buildBatchRequest(
    diff: TaskDiff,
    destination: Destination,
    action: SyncAction,
    businessDate: string,
    batchId: string,
    slice: Array<{ item: WorkItem; sendSms: boolean; deduped: boolean }>,
  ): BatchRequest {
    return {
      audienceId: diff.audienceId,
      action,
      businessDate,
      batchId,
      contacts: slice.map(({ item, sendSms }) => ({
        userId: item.userId,
        ...(action === 'add' ? { phoneHash: hashPhone(item.phone, destination.config.hash) } : {}),
        ...(action === 'add' && destination.platform === 'sms' ? { sendSms } : {}),
      })),
    };
  }

  private async processItems(
    preview: RunPreview,
    diff: TaskDiff,
    destination: Destination,
    action: SyncAction,
    plan: Array<{ item: WorkItem; sendSms: boolean; deduped: boolean }>,
    autoRetry: boolean,
  ): Promise<ProcessResult> {
    const batchSize = Math.min(destination.config.batchSize, MAX_BATCH_LIMIT);
    const totals: ProcessResult = {
      succeeded: 0,
      billed: 0,
      failed: 0,
      deduped: 0,
      requests: 0,
      smsRecorded: [],
    };
    for (let offset = 0; offset < plan.length; offset += batchSize) {
      const slice = plan.slice(offset, offset + batchSize);
      const batchId = `${preview.runId}:${diff.taskId}:${action}:${offset / batchSize}`;
      const result = await this.sendSlice(
        preview,
        diff,
        destination,
        action,
        slice,
        batchId,
        autoRetry,
        0,
      );
      totals.succeeded += result.succeeded;
      totals.billed += result.billed;
      totals.failed += result.failed;
      totals.deduped += result.deduped;
      totals.requests += result.requests;
      totals.smsRecorded.push(...result.smsRecorded);
    }
    return totals;
  }

  /**
   * Sends one batch. If the platform answers 413 (batch larger than its
   * limit), splits in half and resends both halves, recursively.
   */
  private async sendSlice(
    preview: RunPreview,
    diff: TaskDiff,
    destination: Destination,
    action: SyncAction,
    slice: Array<{ item: WorkItem; sendSms: boolean; deduped: boolean }>,
    batchId: string,
    autoRetry: boolean,
    depth: number,
  ): Promise<ProcessResult> {
    const bdate = preview.businessDate;
    const outcome = await this.sendWithHttpRetry(
      destination,
      this.buildBatchRequest(diff, destination, action, bdate, batchId, slice),
    );

    if (outcome.tooLarge && slice.length > 1 && depth < 10) {
      const mid = Math.ceil(slice.length / 2);
      const halves = [slice.slice(0, mid), slice.slice(mid)];
      const merged: ProcessResult = {
        succeeded: 0,
        billed: 0,
        failed: 0,
        deduped: 0,
        requests: outcome.requests,
        smsRecorded: [],
      };
      for (const [index, half] of halves.entries()) {
        const result = await this.sendSlice(
          preview,
          diff,
          destination,
          action,
          half,
          `${batchId}.s${depth + 1}_${index}`,
          autoRetry,
          depth + 1,
        );
        merged.succeeded += result.succeeded;
        merged.billed += result.billed;
        merged.failed += result.failed;
        merged.deduped += result.deduped;
        merged.requests += result.requests;
        merged.smsRecorded.push(...result.smsRecorded);
      }
      return merged;
    }

    if (!outcome.response) {
      for (const { item, deduped: isDeduped } of slice) {
        this.recordFailure(
          preview,
          diff,
          destination,
          action,
          item,
          {
            userId: item.userId,
            ok: false,
            errorCode: outcome.error?.code,
            errorMessage: outcome.error?.message,
          },
          batchId,
          outcome.latencyMs,
          1,
        );
      }
      this.emit({
        type: 'batch',
        runId: preview.runId,
        taskId: diff.taskId,
        batchId,
        action,
        size: slice.length,
        ok: 0,
        failed: slice.length,
      });
      return {
        succeeded: 0,
        billed: 0,
        failed: slice.length,
        deduped: slice.filter((s) => s.deduped).length,
        requests: outcome.requests,
        smsRecorded: [],
      };
    }

    return this.applyBatchResult(
      preview,
      diff,
      destination,
      action,
      slice,
      outcome.response,
      batchId,
      autoRetry,
      outcome.requests,
    );
  }

  private async applyBatchResult(
    preview: RunPreview,
    diff: TaskDiff,
    destination: Destination,
    action: SyncAction,
    slice: Array<{ item: WorkItem; sendSms: boolean; deduped: boolean }>,
    response: NonNullable<Awaited<ReturnType<PlatformAdapter['sendBatch']>>>,
    batchId: string,
    autoRetry: boolean,
    requests: number,
  ): Promise<ProcessResult> {
    const { repo } = this.deps;
    const bdate = preview.businessDate;
    let succeeded = 0;
    let billed = 0;
    let failed = 0;
    let deduped = 0;
    let retryRequests = 0;
    const smsRecorded: Array<{ phone: string }> = [];

    const byUser = new Map(response.results.map((r) => [r.userId, r]));
    const failedItems: RetryItem[] = [];
    for (const { item, sendSms, deduped: isDeduped } of slice) {
      const result = byUser.get(item.userId);
      if (!result) {
        failedItems.push({
          userId: item.userId,
          phone: item.phone,
          sendSms,
          deduped: isDeduped,
          error: {
            userId: item.userId,
            ok: false,
            errorCode: 'missing_result',
            errorMessage: '平台未返回该项结果',
          },
        });
        continue;
      }
      if (result.ok) {
        succeeded += 1;
        if (action === 'add' && result.billed !== false) billed += 1;
        if (isDeduped) deduped += 1;
        if (action === 'add') {
          repo.upsertSyncedMembers(diff.taskId, [
            { userId: item.userId, phoneHash: hashPhone(item.phone, destination.config.hash) },
          ]);
          // Only count a text the platform says it really sent; a re-add of an
          // existing member sends none and must not poison the daily ledger.
          if (destination.platform === 'sms' && !isDeduped && result.texted !== false) {
            smsRecorded.push({ phone: item.phone });
          }
          // A later successful add clears any stale open failure from a prior run.
          const openAdd = repo.findOpenFailure(destination.id, diff.taskId, item.userId, 'add');
          if (openAdd) repo.resolveFailure(openAdd.id, '后续同步已成功');
        } else {
          repo.deleteSyncedMembers(diff.taskId, [item.userId]);
          const open = repo.findOpenFailure(destination.id, diff.taskId, item.userId, action);
          if (open) repo.resolveFailure(open.id, '后续同步已成功');
        }
        repo.insertLog({
          runId: preview.runId,
          taskId: diff.taskId,
          destinationId: destination.id,
          segmentId: diff.segmentId,
          userId: item.userId,
          action,
          phoneHash: action === 'add' ? hashPhone(item.phone, destination.config.hash) : null,
          status: 'success',
          deduped: isDeduped ? 1 : 0,
          errorCode: null,
          errorMessage: null,
          attemptNo: 1,
          batchId,
          latencyMs: response.latencyMs,
          businessDate: bdate,
          createdAt: nowIso(),
        });
      } else {
        failedItems.push({ userId: item.userId, phone: item.phone, sendSms, deduped: isDeduped, error: result });
      }
    }

    if (autoRetry && failedItems.length && destination.config.maxRetries > 0) {
      const retried = await this.retryFailedItems(preview, diff, destination, action, failedItems, batchId);
      succeeded += retried.succeeded;
      billed += retried.billed;
      failed += retried.failed;
      deduped += retried.deduped;
      retryRequests += retried.requests;
      smsRecorded.push(...retried.smsRecorded);
    } else {
      failed += failedItems.length;
      for (const item of failedItems) {
        this.recordFailure(
          preview,
          diff,
          destination,
          action,
          item,
          item.error,
          batchId,
          response.latencyMs,
          1,
        );
        if (item.deduped) deduped += 1;
      }
    }

    this.emit({
      type: 'batch',
      runId: preview.runId,
      taskId: diff.taskId,
      batchId,
      action,
      size: slice.length,
      ok: slice.length - failedItems.length,
      failed: failedItems.length,
    });

    return {
      succeeded,
      billed,
      failed,
      deduped,
      requests: requests + retryRequests,
      smsRecorded,
    };
  }

  private async retryFailedItems(
    preview: RunPreview,
    diff: TaskDiff,
    destination: Destination,
    action: SyncAction,
    items: RetryItem[],
    batchId: string,
  ): Promise<ProcessResult> {
    const { repo } = this.deps;
    let pending = items;
    let succeeded = 0;
    let billed = 0;
    let failed = 0;
    let deduped = 0;
    let requests = 0;
    let lastLatencyMs = 0;
    const smsRecorded: Array<{ phone: string }> = [];

    for (let attempt = 1; attempt <= destination.config.maxRetries && pending.length; attempt++) {
      await backoff(attempt, destination.config.retryBackoffMs);
      const retryBatchId = `${batchId}:retry${attempt}`;
      const outcome = await this.sendWithHttpRetry(destination, {
        audienceId: diff.audienceId,
        action,
        businessDate: preview.businessDate,
        batchId: retryBatchId,
        contacts: pending.map((p) => ({
          userId: p.userId,
          ...(action === 'add' ? { phoneHash: hashPhone(p.phone, destination.config.hash) } : {}),
          ...(action === 'add' && destination.platform === 'sms' ? { sendSms: p.sendSms } : {}),
        })),
      });
      requests += outcome.requests;
      lastLatencyMs = outcome.latencyMs;
      if (!outcome.response) {
        failed += pending.length;
        for (const item of pending) {
          this.recordFailure(
            preview,
            diff,
            destination,
            action,
            item,
            { userId: item.userId, ok: false, errorCode: outcome.error?.code, errorMessage: outcome.error?.message },
            retryBatchId,
            outcome.latencyMs,
            attempt + 1,
          );
          if (item.deduped) deduped += 1;
        }
        pending = [];
        break;
      }
      const byUser = new Map(outcome.response.results.map((r) => [r.userId, r]));
      const next: RetryItem[] = [];
      for (const item of pending) {
        const result = byUser.get(item.userId);
        if (result?.ok) {
          succeeded += 1;
          if (item.deduped) deduped += 1;
          if (action === 'add') {
            repo.upsertSyncedMembers(diff.taskId, [
              { userId: item.userId, phoneHash: hashPhone(item.phone, destination.config.hash) },
            ]);
            if (destination.platform === 'sms' && !item.deduped) smsRecorded.push({ phone: item.phone });
          } else {
            repo.deleteSyncedMembers(diff.taskId, [item.userId]);
          }
          repo.insertLog({
            runId: preview.runId,
            taskId: diff.taskId,
            destinationId: destination.id,
            segmentId: diff.segmentId,
            userId: item.userId,
            action,
            phoneHash: action === 'add' ? hashPhone(item.phone, destination.config.hash) : null,
            status: 'success',
            deduped: item.deduped ? 1 : 0,
            errorCode: null,
            errorMessage: null,
            attemptNo: attempt + 1,
            batchId: retryBatchId,
            latencyMs: outcome.response.latencyMs,
            businessDate: preview.businessDate,
            createdAt: nowIso(),
          });
        } else {
          next.push({ ...item, error: result ?? item.error });
        }
      }
      pending = next;
    }

    for (const item of pending) {
      failed += 1;
      if (item.deduped) deduped += 1;
      this.recordFailure(
        preview,
        diff,
        destination,
        action,
        item,
        item.error,
        batchId,
        lastLatencyMs,
        destination.config.maxRetries + 1,
      );
    }
    return { succeeded, billed, failed, deduped, requests, smsRecorded };
  }

  private async sendWithHttpRetry(
    destination: Destination,
    request: BatchRequest,
  ): Promise<{
    response: Awaited<ReturnType<PlatformAdapter['sendBatch']>> | null;
    requests: number;
    latencyMs: number;
    error: { code: string; message: string } | null;
    /** Platform rejected the batch size; caller should split and resend. */
    tooLarge: boolean;
  }> {
    let attempts = 0;
    let lastError: { code: string; message: string } | null = null;
    let latencyMs = 0;
    const maxHttpRetries = Math.max(1, destination.config.maxHttpRetries);
    while (attempts < maxHttpRetries) {
      attempts += 1;
      await this.limiters.get(destination.id).acquire();
      const started = Date.now();
      try {
        const response = await this.deps.adapter.sendBatch(destination, request);
        return { response, requests: attempts, latencyMs: response.latencyMs, error: null, tooLarge: false };
      } catch (error) {
        latencyMs = Date.now() - started;
        if (error instanceof PlatformHttpError) {
          lastError = { code: `http_${error.status}`, message: error.message };
          if (error.status === 413) {
            return { response: null, requests: attempts, latencyMs, error: lastError, tooLarge: true };
          }
          if (error.retryable && attempts < maxHttpRetries) {
            const wait =
              error.status === 429 ? error.retryAfterMs : destination.config.retryBackoffMs;
            await backoff(attempts, Math.max(wait, destination.config.retryBackoffMs));
            continue;
          }
          return { response: null, requests: attempts, latencyMs, error: lastError, tooLarge: false };
        }
        lastError = { code: 'network_error', message: (error as Error).message };
        if (attempts < maxHttpRetries) {
          await backoff(attempts, destination.config.retryBackoffMs);
          continue;
        }
      }
    }
    return { response: null, requests: attempts, latencyMs, error: lastError, tooLarge: false };
  }

  private recordFailure(
    preview: RunPreview,
    diff: TaskDiff,
    destination: Destination,
    action: SyncAction,
    item: { userId: string; phone: string },
    error: ItemResult,
    batchId: string,
    latencyMs: number,
    attempts: number,
  ): void {
    const { repo } = this.deps;
    repo.insertLog({
      runId: preview.runId,
      taskId: diff.taskId,
      destinationId: destination.id,
      segmentId: diff.segmentId,
      userId: item.userId,
      action,
      phoneHash: action === 'add' && item.phone ? hashPhone(item.phone, destination.config.hash) : null,
      status: 'failed',
      deduped: 0,
      errorCode: error.errorCode ?? 'unknown',
      errorMessage: error.errorMessage ?? null,
      attemptNo: attempts,
      batchId,
      latencyMs,
      businessDate: preview.businessDate,
      createdAt: nowIso(),
    });
    const existing = repo.findOpenFailure(destination.id, diff.taskId, item.userId, action);
    if (existing) {
      repo.bumpFailure(existing.id, error.errorCode ?? null, error.errorMessage ?? null, preview.runId);
    } else {
      repo.insertFailure({
        destinationId: destination.id,
        taskId: diff.taskId,
        segmentId: diff.segmentId,
        userId: item.userId,
        action,
        errorCode: error.errorCode ?? null,
        errorMessage: error.errorMessage ?? null,
        attempts,
        status: 'open',
        runId: preview.runId,
        lastAttemptAt: nowIso(),
        resolvedAt: null,
        resolveNote: null,
      });
    }
  }

  private emit(event: SyncEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      // listener errors must never break a run
    }
  }
}

function failedStats(diff: TaskDiff, error: string): TaskRunStats {
  return {
    taskId: diff.taskId,
    adds: diff.adds.length,
    removes: diff.removes.length,
    addSuccess: 0,
    removeSuccess: 0,
    failed: diff.adds.length + diff.removes.length,
    deferred: 0,
    deduped: 0,
    error,
  };
}

function buildSummary(
  preview: RunPreview,
  tasks: TaskRunStats[],
  requests: number,
  error?: string,
): RunSummary {
  const finishedAt = nowIso();
  const totals = tasks.reduce(
    (acc, t) => {
      acc.addSuccess += t.addSuccess;
      acc.removeSuccess += t.removeSuccess;
      acc.failed += t.failed;
      acc.deferred += t.deferred;
      acc.deduped += t.deduped;
      return acc;
    },
    { addSuccess: 0, removeSuccess: 0, failed: 0, deferred: 0, deduped: 0 },
  );
  let status: RunStatus = 'completed';
  if (error) status = 'failed';
  else if (tasks.some((t) => t.error)) status = 'failed';
  else if (totals.failed > 0) status = 'partial';
  return {
    runId: preview.runId,
    businessDate: preview.businessDate,
    status,
    startedAt: preview.createdAt,
    finishedAt,
    tasks,
    totals: { ...totals, requests },
  };
}
