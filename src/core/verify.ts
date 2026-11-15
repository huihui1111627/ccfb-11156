import type { AppRepo } from '../db/appRepo.js';
import type { Warehouse } from '../db/warehouse.js';
import { hashPhone } from './hash.js';
import { normalizePhone } from './phone.js';
import { businessDate as businessDateShanghai } from './time.js';

export interface PlatformAudienceSnapshot {
  audienceId: string;
  count: number;
  members: Array<{ userId: string; phoneHash: string }>;
}

export interface MockSnapshot {
  platform: string;
  audiences: PlatformAudienceSnapshot[];
  usage: Array<{ date: string; used: number }>;
  texts: Array<{ date: string; phone: string; audienceId: string; userId: string }>;
  stats: {
    requests: number;
    acceptedRequests: number;
    maxBatchSizeSeen: number;
    maxRequestsPerSecond: number;
    rateLimitedResponses: number;
    rejectedForBatchSize: number;
  };
  config: {
    dailyQuota: number;
    maxBatchSize: number;
    rpsLimit: number;
    hash: { algorithm: string; salt: string; uppercase: boolean };
  };
}

export interface TaskCheck {
  taskId: string;
  taskName: string;
  audienceId: string;
  destinationId: string;
  platform: string;
  expectedCount: number;
  actualCount: number;
  missing: string[]; // in expected, not on platform, not explained by a deferral
  deferredMissing: string[]; // in expected, not on platform, but logged as quota-deferred
  extra: string[]; // on platform, not expected
  duplicatePhone: number;
  wrongHash: number;
  blockedLeaked: string[];
  ok: boolean;
  notes: string[];
}

export interface DestinationCheck {
  destinationId: string;
  destinationName: string;
  platform: string;
  tasks: TaskCheck[];
  hashFormatOk: boolean;
  quotaOk: boolean;
  batchSizeOk: boolean;
  rateLimitOk: boolean;
  quotaUsed: number;
  quotaLimit: number;
  batchLimit: number;
  maxBatchSeen: number;
  rpsLimit: number;
  maxRpsSeen: number;
  rateLimitedResponses: number;
  smsDedupeOk: boolean;
  duplicateTexts: number;
  ok: boolean;
}

export interface VerifyReport {
  generatedAt: string;
  destinations: DestinationCheck[];
  smsDailyDedupe: { checkedDays: number; duplicateTexts: number; ok: boolean };
  ok: boolean;
  failures: string[];
}

/**
 * Independent oracle: recompute what each audience *should* contain straight
 * from the warehouse + task definitions + suppression rules, and compare with
 * what the mock platforms actually hold.
 *
 * Deliberately does NOT read task_members: if the sync engine's bookkeeping and
 * the platform disagree, that is exactly what we want to catch.
 */
export function verifyPlatforms(
  repo: AppRepo,
  warehouse: Warehouse,
  snapshots: Partial<Record<'sms' | 'wecom' | 'ads', MockSnapshot>>,
  businessDate: string = businessDateShanghai(),
): VerifyReport {
  const destinations = repo.listDestinations();
  const tasks = repo.listTasks();
  const checks: DestinationCheck[] = [];
  const failures: string[] = [];

  for (const destination of destinations) {
    const snapshot = snapshots[destination.platform];
    if (!snapshot) {
      // A destination we could not read is NOT verified. Saying nothing here
      // would let `ok: true` hide a completely unreachable platform.
      if (tasks.some((t) => t.destinationId === destination.id)) {
        failures.push(`[${destination.name}] 无法读取平台状态, 该目的地未能核对`);
      }
      continue;
    }
    const platformAudiences = new Map(snapshot.audiences.map((a) => [a.audienceId, a]));
    const taskChecks: TaskCheck[] = [];

    for (const task of tasks.filter((t) => t.destinationId === destination.id)) {
      const noted: string[] = [];
      const expectedIds = expectedAudience(warehouse, task.segmentId, destination.platform);
      const actual = platformAudiences.get(task.audienceId);
      const actualIds = new Set((actual?.members ?? []).map((m) => m.userId));

      // Items the engine explicitly deferred for quota reasons are legitimately
      // not on the platform yet AND must show up in tomorrow's diff. Anything
      // else missing is an unexplained gap.
      const deferredIds = deferredUserIds(repo, destination.id, task.id, businessDate);
      const missing = [...expectedIds].filter((id) => !actualIds.has(id) && !deferredIds.has(id));
      const deferredMissing = [...expectedIds].filter((id) => !actualIds.has(id) && deferredIds.has(id));
      const extra = [...actualIds].filter((id) => !expectedIds.has(id));
      if (deferredMissing.length) {
        noted.push(`${deferredMissing.length} 人因配额顺延, 未在本次推送 (已记录 deferred)`);
      }

      // Suppression leak check: a suppressed user must never be present.
      const suppressed = warehouse.listSuppressed();
      const blockedLeaked = [...actualIds].filter((id) => suppressed.userIds.has(id));

      // Hash correctness per platform: recompute from the warehouse phone.
      let wrongHash = 0;
      const users = warehouse.getUsers((actual?.members ?? []).map((m) => m.userId));
      for (const member of actual?.members ?? []) {
        const user = users.get(member.userId);
        if (!user) {
          wrongHash += 1;
          continue;
        }
        if (member.phoneHash !== hashPhone(user.phone, destination.config.hash)) wrongHash += 1;
      }

      // Same phone twice inside one audience means dedupe/sync bookkeeping broke.
      const phones = new Map<string, number>();
      for (const member of actual?.members ?? []) {
        const user = users.get(member.userId);
        if (!user) continue;
        const phone = normalizePhone(user.phone);
        phones.set(phone, (phones.get(phone) ?? 0) + 1);
      }
      const duplicatePhone = [...phones.values()].filter((n) => n > 1).length;

      if (missing.length) noted.push(`缺少 ${missing.length} 人 (未推送到平台)`);
      if (extra.length) noted.push(`多出 ${extra.length} 人 (应已移出或本不该推送)`);
      if (blockedLeaked.length) noted.push(`退订/黑名单泄漏 ${blockedLeaked.length} 人`);
      if (wrongHash) noted.push(`${wrongHash} 人手机号哈希与目的地约定不一致`);
      if (duplicatePhone) noted.push(`${duplicatePhone} 个手机号在同一受众内重复`);

      const ok =
        missing.length === 0 &&
        extra.length === 0 &&
        blockedLeaked.length === 0 &&
        wrongHash === 0 &&
        duplicatePhone === 0;

      if (!ok) {
        failures.push(
          `[${destination.name}/${task.name}] ${noted.join('; ')}` +
            (missing.length ? ` | missing=${missing.slice(0, 5).join(',')}` : '') +
            (extra.length ? ` | extra=${extra.slice(0, 5).join(',')}` : ''),
        );
      }
      taskChecks.push({
        taskId: task.id,
        taskName: task.name,
        audienceId: task.audienceId,
        destinationId: destination.id,
        platform: destination.platform,
        expectedCount: expectedIds.size,
        actualCount: actualIds.size,
        missing,
        deferredMissing,
        extra,
        duplicatePhone,
        wrongHash,
        blockedLeaked,
        ok,
        notes: noted,
      });
    }

    const usageByDate = new Map(snapshot.usage.map((u) => [u.date, u.used]));
    const maxQuotaUsed = Math.max(0, ...usageByDate.values());
    const quotaOk = maxQuotaUsed <= snapshot.config.dailyQuota;
    const batchSizeOk = snapshot.stats.maxBatchSizeSeen <= snapshot.config.maxBatchSize;
    // A 429 means the engine exceeded the platform's per-second limit; the
    // client rate limiter should have kept us under it. Any 429 is a finding.
    const rateLimitOk = snapshot.stats.rateLimitedResponses === 0;

    // SMS texts per phone per day must be unique.
    const textCounts = new Map<string, number>();
    for (const text of snapshot.texts) {
      const key = `${text.date}|${text.phone}`;
      textCounts.set(key, (textCounts.get(key) ?? 0) + 1);
    }
    const duplicateTexts = [...textCounts.values()].filter((n) => n > 1).length;
    const smsDedupeOk = destination.platform !== 'sms' || duplicateTexts === 0;

    if (!quotaOk) failures.push(`[${destination.name}] 配额超限: ${maxQuotaUsed}/${snapshot.config.dailyQuota}`);
    if (!batchSizeOk) {
      failures.push(
        `[${destination.name}] 批次大小超限: ${snapshot.stats.maxBatchSizeSeen}/${snapshot.config.maxBatchSize}`,
      );
    }
    if (!smsDedupeOk) failures.push(`[${destination.name}] 同一手机号同日收到 ${duplicateTexts} 条重复短信`);
    if (!rateLimitOk) {
      failures.push(
        `[${destination.name}] 出现 ${snapshot.stats.rateLimitedResponses} 次 429 限速, ` +
          `客户端限速未生效 (观测峰值 ${snapshot.stats.maxRequestsPerSecond}/s, 上限 ${snapshot.config.rpsLimit}/s)`,
      );
    }

    const ok =
      taskChecks.every((t) => t.ok) &&
      quotaOk &&
      batchSizeOk &&
      rateLimitOk &&
      wrongHashCount(taskChecks) === 0 &&
      blockedLeakCount(taskChecks) === 0 &&
      smsDedupeOk;

    checks.push({
      destinationId: destination.id,
      destinationName: destination.name,
      platform: destination.platform,
      tasks: taskChecks,
      hashFormatOk: wrongHashCount(taskChecks) === 0,
      quotaOk,
      batchSizeOk,
      rateLimitOk,
      quotaUsed: maxQuotaUsed,
      quotaLimit: snapshot.config.dailyQuota,
      batchLimit: snapshot.config.maxBatchSize,
      maxBatchSeen: snapshot.stats.maxBatchSizeSeen,
      rpsLimit: snapshot.config.rpsLimit,
      maxRpsSeen: snapshot.stats.maxRequestsPerSecond,
      rateLimitedResponses: snapshot.stats.rateLimitedResponses,
      smsDedupeOk,
      duplicateTexts,
      ok,
    });
  }

  const smsSnapshot = snapshots.sms;
  let smsDuplicateTexts = 0;
  let smsCheckedDays = 0;
  if (smsSnapshot) {
    const byDay = new Map<string, Map<string, number>>();
    for (const text of smsSnapshot.texts) {
      const day = byDay.get(text.date) ?? new Map<string, number>();
      day.set(text.phone, (day.get(text.phone) ?? 0) + 1);
      byDay.set(text.date, day);
    }
    smsCheckedDays = byDay.size;
    for (const day of byDay.values()) {
      smsDuplicateTexts += [...day.values()].filter((n) => n > 1).length;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    destinations: checks,
    smsDailyDedupe: {
      checkedDays: smsCheckedDays,
      duplicateTexts: smsDuplicateTexts,
      ok: smsDuplicateTexts === 0,
    },
    ok:
      failures.length === 0 &&
      checks.every((c) => c.ok) &&
      smsDuplicateTexts === 0,
    failures,
  };
}

function deferredUserIds(
  repo: AppRepo,
  destinationId: string,
  taskId: string,
  businessDate: string,
): Set<string> {
  // Scope to the business date being verified: a deferral from an earlier day
  // must not excuse a genuine missing push today.
  const rows = repo.db
    .prepare(
      `SELECT DISTINCT user_id AS userId FROM send_logs
       WHERE destination_id = ? AND task_id = ? AND status = 'deferred' AND business_date = ?`,
    )
    .all(destinationId, taskId, businessDate) as { userId: string }[];
  return new Set(rows.map((r) => r.userId));
}

function wrongHashCount(checks: TaskCheck[]): number {
  return checks.reduce((n, c) => n + c.wrongHash, 0);
}

function blockedLeakCount(checks: TaskCheck[]): number {
  return checks.reduce((n, c) => n + c.blockedLeaked.length, 0);
}

/**
 * Expected audience = current segment members minus suppressed users.
 *
 * SMS audiences are a special case: a user who already received a text today
 * from another audience is still *added* to this audience on the platform (the
 * membership is real), they just do not receive a second text. So membership is
 * the same as other platforms; the dedupe dimension is checked on `texts`.
 */
export function expectedAudience(
  warehouse: Warehouse,
  segmentId: string,
  _platform: string,
): Set<string> {
  const members = warehouse.listMembers(segmentId);
  const suppressed = warehouse.listSuppressed();
  const result = new Set<string>();
  for (const member of members) {
    if (member.suppressed) continue;
    if (suppressed.userIds.has(member.userId)) continue;
    if (suppressed.phones.has(normalizePhone(member.phone))) continue;
    result.add(member.userId);
  }
  return result;
}
