import { createHash } from 'node:crypto';
import type {
  Destination,
  RunPreview,
  SyncTask,
  TaskDiff,
} from '../types.js';
import type { AppRepo } from '../db/appRepo.js';
import type { Warehouse } from '../db/warehouse.js';
import { hashPhone } from './hash.js';
import { businessDate as defaultBusinessDate, nowIso } from './time.js';
export interface BuildPreviewOptions {
  businessDate?: string;
  taskIds?: string[];
  /** When true, suppressed members are still counted so the UI can show them. */
  includeBlockedDetail?: boolean;
  /**
   * Platform-reported remaining quota per destination id. When present it is
   * authoritative (min of local budget and platform), so the preview shows the
   * same deferrals the run will actually hit.
   */
  platformRemaining?: Map<string, number>;
}

export interface PreviewEngineDeps {
  repo: AppRepo;
  warehouse: Warehouse;
  now?: () => Date;
}

/**
 * Computes the incremental add/remove set for each task by comparing the
 * warehouse segment against what we last successfully synced (task_members).
 *
 * Rules encoded here:
 *  - only adds/removes, never a full retransmit
 *  - opted-out / blacklisted users never enter `adds`
 *  - quota remaining constrains how many adds can happen today
 *  - SMS dedupe across audiences is predicted so the preview is honest
 */
export class PreviewEngine {
  constructor(private readonly deps: PreviewEngineDeps) {}

  build(options: BuildPreviewOptions = {}): RunPreview {
    const bdate = options.businessDate ?? defaultBusinessDate(this.deps.now?.() ?? new Date());
    const repo = this.deps.repo;
    const warehouse = this.deps.warehouse;
    const allTasks = repo.listTasks();
    const selected = options.taskIds?.length
      ? allTasks.filter((t) => options.taskIds!.includes(t.id))
      : allTasks;
    const tasks = selected.filter((t) => t.enabled);
    const skipped = selected.filter((t) => !t.enabled).map((t) => t.name);

    const destinations = new Map(repo.listDestinations().map((d) => [d.id, d]));
    const allocated = new Map<string, number>();
    // SMS dedupe is per phone per business day across ALL sms destinations, so
    // this set is shared, not keyed by destination.
    const smsPhonesPlanned = new Set<string>();
    const diffs: TaskDiff[] = [];

    for (const task of tasks) {
      const destination = destinations.get(task.destinationId);
      if (!destination) {
        diffs.push(this.emptyDiff(task, bdate, '目的地不存在'));
        continue;
      }
      diffs.push(
        this.diffTask(task, destination, bdate, allocated, smsPhonesPlanned, options.platformRemaining),
      );
    }

    if (skipped.length) {
      for (const diff of diffs) diff.warnings.unshift(`已跳过的停用任务: ${skipped.join('、')}`);
    }

    const totals = diffs.reduce(
      (acc, d) => {
        acc.adds += d.adds.length;
        acc.removes += d.removes.length;
        acc.blocked += d.blocked.length;
        acc.smsDeduped += d.smsDeduped.length;
        acc.deferred += d.deferred.length;
        acc.affected += d.affected;
        return acc;
      },
      { adds: 0, removes: 0, blocked: 0, smsDeduped: 0, deferred: 0, affected: 0 },
    );

    const requiresConfirmation = diffs.some(
      (d) => d.requiresConfirmation || d.warnings.some((w) => w.includes('未找到')),
    );
    const fingerprint = fingerprintOf(bdate, diffs);

    return {
      runId: `run_${bdate.replace(/-/g, '')}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      businessDate: bdate,
      createdAt: nowIso(),
      tasks: diffs,
      totals,
      requiresConfirmation,
      fingerprint,
      status: requiresConfirmation ? 'awaiting_confirmation' : 'previewed',
    };
  }

  private emptyDiff(task: SyncTask, bdate: string, warning: string): TaskDiff {
    return {
      taskId: task.id,
      taskName: task.name,
      destinationId: task.destinationId,
      destinationName: '(missing)',
      platform: 'sms',
      segmentId: task.segmentId,
      segmentName: '',
      audienceId: task.audienceId,
      adds: [],
      removes: [],
      blocked: [],
      smsDeduped: [],
      deferred: [],
      unchanged: 0,
      totalMembers: 0,
      quotaRemaining: 0,
      threshold: task.confirmThreshold,
      affected: 0,
      requiresConfirmation: false,
      warnings: [warning],
    };
  }

  private diffTask(
    task: SyncTask,
    destination: Destination,
    bdate: string,
    allocated: Map<string, number>,
    smsPhonesPlanned: Set<string>,
    platformRemaining?: Map<string, number>,
  ): TaskDiff {
    const repo = this.deps.repo;
    const warehouse = this.deps.warehouse;
    const warnings: string[] = [];
    const segment = warehouse.getSegment(task.segmentId);
    if (!segment) warnings.push(`数据仓库中未找到分群 ${task.segmentId}`);

    const members = warehouse.listMembers(task.segmentId);
    const current = new Map(members.map((m) => [m.userId, m]));
    const synced = repo.syncedMembers(task.id);

    const adds: string[] = [];
    const removes: string[] = [];
    const blocked: string[] = [];

    for (const member of members) {
      if (member.suppressed) {
        // Removing a previously-synced suppressed user is allowed and required.
        if (synced.has(member.userId)) removes.push(member.userId);
        if (!synced.has(member.userId)) blocked.push(member.userId);
        continue;
      }
      const hash = hashPhone(member.phone, destination.config.hash);
      const previous = synced.get(member.userId);
      if (previous === undefined) adds.push(member.userId);
      else if (previous !== hash) adds.push(member.userId); // phone changed -> re-push
    }
    for (const userId of synced.keys()) {
      if (!current.has(userId)) removes.push(userId);
    }

    // Quota: subtract what other tasks already earmarked for this destination
    // today. When the platform reports its own remaining quota, that wins —
    // the preview should show the deferrals the run will really hit.
    // `reserved` is deliberately ignored: it only reflects in-flight work, and
    // a crashed run can leave it stale. Real usage comes from the success log.
    repo.ensureUsageRow(destination.id, bdate);
    const usage = repo.getUsage(destination.id, bdate);
    const alreadyAllocated = allocated.get(destination.id) ?? 0;
    let quotaRemaining = Math.max(
      0,
      destination.config.dailyQuota - usage.used - alreadyAllocated,
    );
    const platformLeft = platformRemaining?.get(destination.id);
    if (platformLeft !== undefined) {
      quotaRemaining = Math.min(quotaRemaining, Math.max(0, platformLeft - alreadyAllocated));
    }
    const deferred = adds.slice(quotaRemaining);
    const allowedAdds = adds.slice(0, quotaRemaining);
    allocated.set(destination.id, alreadyAllocated + allowedAdds.length);

    // SMS cross-audience daily dedupe prediction.
    const smsDeduped: string[] = [];
    if (destination.platform === 'sms' && destination.config.smsDailyDedupe) {
      const alreadyTexted = repo.phonesAlreadyTexted(bdate);
      for (const userId of allowedAdds) {
        const member = current.get(userId)!;
        const phone = member.phone;
        if (alreadyTexted.has(phone) || smsPhonesPlanned.has(phone)) smsDeduped.push(userId);
        else smsPhonesPlanned.add(phone);
      }
    }

    if (deferred.length > 0) {
      warnings.push(
        `配额不足: 今日剩余 ${quotaRemaining} 条, ${deferred.length} 人延后到明天的预览`,
      );
    }
    if (blocked.length > 0) {
      warnings.push(`${blocked.length} 人处于退订/黑名单, 不会被推送`);
    }
    if (!destination.enabled) {
      warnings.push('目的地已停用, 该任务不会执行');
    }

    const affected = adds.length + removes.length;
    const requiresConfirmation =
      task.confirmThreshold > 0 && affected > task.confirmThreshold ? true : false;

    return {
      taskId: task.id,
      taskName: task.name,
      destinationId: destination.id,
      destinationName: destination.name,
      platform: destination.platform,
      segmentId: task.segmentId,
      segmentName: segment?.name ?? task.segmentId,
      audienceId: task.audienceId,
      adds,
      removes,
      blocked,
      smsDeduped,
      deferred,
      // Truly unchanged = current members that are neither added nor part of
      // the blocked set nor being removed (a suppressed-but-synced user is a
      // remove, not "unchanged").
      unchanged: members.length - adds.length - blocked.length - removes.length,
      totalMembers: members.length,
      quotaRemaining,
      threshold: task.confirmThreshold,
      affected,
      requiresConfirmation,
      warnings,
    };
  }
}

function fingerprintOf(bdate: string, diffs: TaskDiff[]): string {
  const payload = JSON.stringify({
    bdate,
    tasks: diffs.map((d) => ({
      id: d.taskId,
      // Bind the routing identity too, so a tampered preview cannot redirect a
      // confirmed diff to a different destination/audience.
      destinationId: d.destinationId,
      segmentId: d.segmentId,
      audienceId: d.audienceId,
      adds: [...d.adds].sort(),
      removes: [...d.removes].sort(),
      deduped: [...d.smsDeduped].sort(),
      deferred: [...d.deferred].sort(),
    })),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
