import type {
  DailyStatRow,
  Destination,
  DestinationConfig,
  FailureRow,
  LogStatus,
  RunPreview,
  RunStatus,
  RunSummary,
  SendLogRow,
  SyncAction,
  SyncTask,
} from '../types.js';
import { nowIso } from './sqlite.js';
import type { Db } from './sqlite.js';

const SEND_LOG_COLUMNS = `id, run_id AS runId, task_id AS taskId, destination_id AS destinationId,
  segment_id AS segmentId, user_id AS userId, action, phone_hash AS phoneHash, status, deduped,
  error_code AS errorCode, error_message AS errorMessage, attempt_no AS attemptNo, batch_id AS batchId,
  latency_ms AS latencyMs, business_date AS businessDate, created_at AS createdAt`;

const FAILURE_COLUMNS = `id, destination_id AS destinationId, task_id AS taskId, segment_id AS segmentId,
  user_id AS userId, action, error_code AS errorCode, error_message AS errorMessage, attempts, status,
  run_id AS runId, last_attempt_at AS lastAttemptAt, resolved_at AS resolvedAt, resolve_note AS resolveNote`;

export interface DestinationRow {
  id: string;
  name: string;
  platform: string;
  base_url: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  name: string;
  segment_id: string;
  destination_id: string;
  audience_id: string;
  enabled: number;
  confirm_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  business_date: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  preview_json: string;
  fingerprint: string;
  confirmed_at: string | null;
  summary_json: string | null;
}

function positiveInt(value: unknown, fallback: number, min = 1): number {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min ? n : fallback;
}

function parseConfig(raw: string): DestinationConfig {
  const cfg = JSON.parse(raw) as Partial<DestinationConfig>;
  return {
    // Never let a bad stored value become NaN: a NaN batchSize would make the
    // batching loop never advance.
    batchSize: positiveInt(cfg.batchSize, 100),
    requestsPerSecond: positiveInt(cfg.requestsPerSecond, 5),
    dailyQuota: positiveInt(cfg.dailyQuota, 10000, 0),
    maxRetries: positiveInt(cfg.maxRetries ?? 2, 2, 0),
    maxHttpRetries: positiveInt(cfg.maxHttpRetries ?? 3, 3),
    retryBackoffMs: positiveInt(cfg.retryBackoffMs ?? 120, 120, 0),
    requestTimeoutMs: positiveInt(cfg.requestTimeoutMs ?? 5000, 5000),
    hash: {
      algorithm: cfg.hash?.algorithm === 'md5' ? 'md5' : 'sha256',
      salt: String(cfg.hash?.salt ?? ''),
      uppercase: Boolean(cfg.hash?.uppercase),
    },
    smsDailyDedupe: cfg.smsDailyDedupe !== false,
  };
}

export function toDestination(row: DestinationRow): Destination {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as Destination['platform'],
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    config: parseConfig(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTask(row: TaskRow): SyncTask {
  return {
    id: row.id,
    name: row.name,
    segmentId: row.segment_id,
    destinationId: row.destination_id,
    audienceId: row.audience_id,
    enabled: Boolean(row.enabled),
    confirmThreshold: row.confirm_threshold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AppRepo {
  constructor(readonly db: Db) {}

  // ---------- destinations ----------
  listDestinations(): Destination[] {
    return (this.db.prepare('SELECT * FROM destinations ORDER BY id').all() as DestinationRow[]).map(
      toDestination,
    );
  }

  getDestination(id: string): Destination | undefined {
    const row = this.db.prepare('SELECT * FROM destinations WHERE id = ?').get(id) as
      | DestinationRow
      | undefined;
    return row ? toDestination(row) : undefined;
  }

  insertDestination(d: Destination): void {
    this.db
      .prepare(
        `INSERT INTO destinations (id, name, platform, base_url, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.name,
        d.platform,
        d.baseUrl,
        d.enabled ? 1 : 0,
        JSON.stringify(d.config),
        d.createdAt,
        d.updatedAt,
      );
  }

  updateDestination(d: Destination): void {
    this.db
      .prepare(
        `UPDATE destinations SET name=?, platform=?, base_url=?, enabled=?, config_json=?, updated_at=? WHERE id=?`,
      )
      .run(
        d.name,
        d.platform,
        d.baseUrl,
        d.enabled ? 1 : 0,
        JSON.stringify(d.config),
        d.updatedAt,
        d.id,
      );
  }

  deleteDestination(id: string): void {
    this.db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
  }

  // ---------- tasks ----------
  listTasks(): SyncTask[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as TaskRow[]).map(
      toTask,
    );
  }

  getTask(id: string): SyncTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  insertTask(t: SyncTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, name, segment_id, destination_id, audience_id, enabled, confirm_threshold, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.name,
        t.segmentId,
        t.destinationId,
        t.audienceId,
        t.enabled ? 1 : 0,
        t.confirmThreshold,
        t.createdAt,
        t.updatedAt,
      );
  }

  updateTask(t: SyncTask): void {
    this.db
      .prepare(
        `UPDATE tasks SET name=?, segment_id=?, destination_id=?, audience_id=?, enabled=?, confirm_threshold=?, updated_at=? WHERE id=?`,
      )
      .run(
        t.name,
        t.segmentId,
        t.destinationId,
        t.audienceId,
        t.enabled ? 1 : 0,
        t.confirmThreshold,
        t.updatedAt,
        t.id,
      );
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  findTaskByDestinationAudience(destinationId: string, audienceId: string, excludeId = ''): SyncTask | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE destination_id = ? AND audience_id = ? AND id != ?')
      .get(destinationId, audienceId, excludeId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  // ---------- synced membership ----------
  syncedMembers(taskId: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT user_id AS userId, phone_hash AS phoneHash FROM task_members WHERE task_id = ?')
      .all(taskId) as { userId: string; phoneHash: string }[];
    return new Map(rows.map((r) => [r.userId, r.phoneHash]));
  }

  upsertSyncedMembers(taskId: string, members: { userId: string; phoneHash: string }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO task_members (task_id, user_id, phone_hash, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, user_id) DO UPDATE SET phone_hash = excluded.phone_hash`,
    );
    const at = nowIso();
    for (const member of members) stmt.run(taskId, member.userId, member.phoneHash, at);
  }

  deleteSyncedMembers(taskId: string, userIds: string[]): void {
    const stmt = this.db.prepare('DELETE FROM task_members WHERE task_id = ? AND user_id = ?');
    for (const userId of userIds) stmt.run(taskId, userId);
  }

  // ---------- runs ----------
  /** Idempotent: a preview may be saved for approval and later executed. */
  insertRun(preview: RunPreview): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, business_date, status, created_at, preview_json, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           preview_json = excluded.preview_json,
           fingerprint = excluded.fingerprint,
           status = CASE WHEN runs.status IN ('running','completed','partial','failed')
                         THEN runs.status ELSE excluded.status END`,
      )
      .run(
        preview.runId,
        preview.businessDate,
        preview.status,
        preview.createdAt,
        JSON.stringify(preview),
        preview.fingerprint,
      );
  }

  getRun(runId: string): (RunPreview & { summary: RunSummary | null }) | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) return undefined;
    const preview = JSON.parse(row.preview_json) as RunPreview;
    preview.status = row.status as RunStatus;
    return {
      ...preview,
      status: row.status as RunStatus,
      summary: row.summary_json ? (JSON.parse(row.summary_json) as RunSummary) : null,
    };
  }

  listRuns(limit = 50): Array<RunPreview & { summary: RunSummary | null }> {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as RunRow[];
    return rows.map((row) => {
      const preview = JSON.parse(row.preview_json) as RunPreview;
      return {
        ...preview,
        status: row.status as RunStatus,
        summary: row.summary_json ? (JSON.parse(row.summary_json) as RunSummary) : null,
      };
    });
  }

  markRunStarted(runId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
      )
      .run(nowIso(), runId);
  }

  markRunConfirmed(runId: string): void {
    this.db.prepare('UPDATE runs SET confirmed_at = ? WHERE id = ?').run(nowIso(), runId);
  }

  finishRun(runId: string, status: RunStatus, summary: RunSummary): void {
    this.db
      .prepare('UPDATE runs SET status = ?, finished_at = ?, summary_json = ? WHERE id = ?')
      .run(status, nowIso(), JSON.stringify(summary), runId);
  }

  setRunStatus(runId: string, status: RunStatus): void {
    this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
  }

  // ---------- logs ----------
  insertLog(row: Omit<SendLogRow, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO send_logs (run_id, task_id, destination_id, segment_id, user_id, action, phone_hash,
                                status, deduped, error_code, error_message, attempt_no, batch_id, latency_ms,
                                business_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.taskId,
        row.destinationId,
        row.segmentId,
        row.userId,
        row.action,
        row.phoneHash,
        row.status,
        row.deduped,
        row.errorCode,
        row.errorMessage,
        row.attemptNo,
        row.batchId,
        row.latencyMs,
        row.businessDate,
        row.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  queryLogs(filter: {
    destinationId?: string;
    segmentId?: string;
    status?: LogStatus;
    action?: SyncAction;
    businessDate?: string;
    runId?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): { rows: SendLogRow[]; total: number } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.destinationId) {
      clauses.push('destination_id = ?');
      params.push(filter.destinationId);
    }
    if (filter.segmentId) {
      clauses.push('segment_id = ?');
      params.push(filter.segmentId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.action) {
      clauses.push('action = ?');
      params.push(filter.action);
    }
    if (filter.businessDate) {
      clauses.push('business_date = ?');
      params.push(filter.businessDate);
    }
    if (filter.runId) {
      clauses.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.userId) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM send_logs ${where}`).get(...params) as { c: number })
        .c,
    );
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(`SELECT ${SEND_LOG_COLUMNS} FROM send_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SendLogRow[];
    return {
      rows: rows.map((r) => ({ ...r, deduped: Number(r.deduped) })),
      total,
    };
  }

  // ---------- failures ----------
  insertFailure(f: Omit<FailureRow, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO failures (destination_id, task_id, segment_id, user_id, action, error_code, error_message,
                               attempts, status, run_id, last_attempt_at, resolved_at, resolve_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.destinationId,
        f.taskId,
        f.segmentId,
        f.userId,
        f.action,
        f.errorCode,
        f.errorMessage,
        f.attempts,
        f.status,
        f.runId,
        f.lastAttemptAt,
        f.resolvedAt,
        f.resolveNote,
      );
    return Number(result.lastInsertRowid);
  }

  /** Bump an existing open failure instead of piling up duplicates for the same item. */
  bumpFailure(failureId: number, errorCode: string | null, errorMessage: string | null, runId: string): void {
    this.db
      .prepare(
        `UPDATE failures SET attempts = attempts + 1, error_code = ?, error_message = ?, last_attempt_at = ?, run_id = ?
         WHERE id = ?`,
      )
      .run(errorCode, errorMessage, nowIso(), runId, failureId);
  }

  findOpenFailure(destinationId: string, taskId: string, userId: string, action: SyncAction): FailureRow | undefined {
    return this.db
      .prepare(
        `SELECT ${FAILURE_COLUMNS} FROM failures
         WHERE destination_id = ? AND task_id = ? AND user_id = ? AND action = ? AND status = 'open'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(destinationId, taskId, userId, action) as FailureRow | undefined;
  }

  getFailure(id: number): FailureRow | undefined {
    return this.db.prepare(`SELECT ${FAILURE_COLUMNS} FROM failures WHERE id = ?`).get(id) as
      | FailureRow
      | undefined;
  }

  listFailures(filter: {
    destinationId?: string;
    taskId?: string;
    status?: 'open' | 'resolved';
    limit?: number;
    offset?: number;
  }): { rows: FailureRow[]; total: number } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.destinationId) {
      clauses.push('destination_id = ?');
      params.push(filter.destinationId);
    }
    if (filter.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM failures ${where}`).get(...params) as { c: number }).c,
    );
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(`SELECT ${FAILURE_COLUMNS} FROM failures ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as FailureRow[];
    return { rows, total };
  }

  listOpenFailuresForRetry(destinationId: string, ids?: number[]): FailureRow[] {
    if (ids && ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      return this.db
        .prepare(
          `SELECT ${FAILURE_COLUMNS} FROM failures
           WHERE id IN (${placeholders}) AND status = 'open' AND destination_id = ? ORDER BY id`,
        )
        .all(...ids, destinationId) as FailureRow[];
    }
    return this.db
      .prepare(`SELECT ${FAILURE_COLUMNS} FROM failures WHERE destination_id = ? AND status = 'open' ORDER BY id`)
      .all(destinationId) as FailureRow[];
  }

  resolveFailure(id: number, note: string): void {
    this.db
      .prepare(`UPDATE failures SET status = 'resolved', resolved_at = ?, resolve_note = ? WHERE id = ?`)
      .run(nowIso(), note, id);
  }

  countOpenFailures(destinationId?: string): number {
    const row = destinationId
      ? (this.db
          .prepare(`SELECT COUNT(*) AS c FROM failures WHERE status = 'open' AND destination_id = ?`)
          .get(destinationId) as { c: number })
      : (this.db.prepare(`SELECT COUNT(*) AS c FROM failures WHERE status = 'open'`).get() as { c: number });
    return Number(row.c);
  }

  // ---------- quota ----------
  getUsage(destinationId: string, date: string): { used: number; reserved: number } {
    const row = this.db
      .prepare('SELECT used_adds AS used, reserved_adds AS reserved FROM daily_usage WHERE destination_id = ? AND business_date = ?')
      .get(destinationId, date) as { used: number; reserved: number } | undefined;
    return { used: row ? Number(row.used) : 0, reserved: row ? Number(row.reserved) : 0 };
  }

  ensureUsageRow(destinationId: string, date: string): void {
    this.db
      .prepare(
        `INSERT INTO daily_usage (destination_id, business_date, used_adds, reserved_adds, updated_at)
         VALUES (?, ?, 0, 0, ?) ON CONFLICT(destination_id, business_date) DO NOTHING`,
      )
      .run(destinationId, date, nowIso());
  }

  /**
   * Recompute real usage from the log of successful adds and clear any
   * reservation left behind by a process that died mid-run. Called at startup
   * and before a run, so a crash can never permanently shrink a day's budget.
   */
  reconcileUsage(date: string): void {
    const destinations = this.listDestinations();
    for (const destination of destinations) {
      this.ensureUsageRow(destination.id, date);
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM send_logs
           WHERE destination_id = ? AND business_date = ?
             AND action = 'add' AND status = 'success'`,
        )
        .get(destination.id, date) as { c: number };
      this.db
        .prepare(
          `UPDATE daily_usage SET used_adds = ?, reserved_adds = 0, updated_at = ?
           WHERE destination_id = ? AND business_date = ?`,
        )
        .run(Number(row.c), nowIso(), destination.id, date);
    }
  }

  reserveQuota(destinationId: string, date: string, count: number): void {
    this.db
      .prepare(
        `UPDATE daily_usage SET reserved_adds = reserved_adds + ?, updated_at = ? WHERE destination_id = ? AND business_date = ?`,
      )
      .run(count, nowIso(), destinationId, date);
  }

  settleQuota(destinationId: string, date: string, reserved: number, used: number): void {
    this.db
      .prepare(
        `UPDATE daily_usage
         SET reserved_adds = MAX(0, reserved_adds - ?), used_adds = used_adds + ?, updated_at = ?
         WHERE destination_id = ? AND business_date = ?`,
      )
      .run(reserved, used, nowIso(), destinationId, date);
  }

  // ---------- sms dedupe ----------
  /**
   * Phones that already received a real SMS today. Sourced from the engine's own
   * ledger, which is only written on a successful, non-deduped add, so a retried
   * or failed send never suppresses a legitimate later text.
   */
  phonesAlreadyTexted(date: string): Set<string> {
    const rows = this.db
      .prepare('SELECT phone FROM sms_daily_send WHERE business_date = ?')
      .all(date) as { phone: string }[];
    return new Set(rows.map((r) => r.phone));
  }

  recordSmsSend(date: string, phone: string, taskId: string, runId: string): void {
    this.db
      .prepare(
        `INSERT INTO sms_daily_send (business_date, phone, task_id, run_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(business_date, phone) DO NOTHING`,
      )
      .run(date, phone, taskId, runId, nowIso());
  }

  // ---------- stats ----------
  /**
   * Daily push stats per destination.
   *
   * `attempts` only counts items that actually reached the platform: a
   * quota-deferred, sms-deduped or preflight-blocked item was never sent, so
   * including it would understate the success rate. `deferred`, `deduped` and
   * `blocked` are reported as separate counters.
   */
  dailyStats(from: string, to: string, destinationId?: string): DailyStatRow[] {
    const params: (string | number)[] = [from, to];
    let destFilter = '';
    if (destinationId) {
      destFilter = 'AND l.destination_id = ?';
      params.push(destinationId);
    }
    const rows = this.db
      .prepare(
        `SELECT l.destination_id AS destinationId, d.name AS destinationName, d.platform AS platform,
                l.business_date AS businessDate,
                -- An "attempt" is a real send that reached the platform: not
                -- quota-deferred, not a deduped re-add, not a preflight block.
                SUM(CASE WHEN l.status IN ('success','failed')
                              AND l.deduped = 0
                              AND l.attempt_no >= 1
                              AND COALESCE(l.error_code,'') != 'suppressed'
                         THEN 1 ELSE 0 END) AS attempts,
                SUM(CASE WHEN l.status = 'success' AND l.deduped = 0
                              AND COALESCE(l.error_code,'') != 'suppressed'
                         THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN l.status = 'failed' AND l.deduped = 0
                              AND l.attempt_no >= 1
                              AND COALESCE(l.error_code,'') != 'suppressed'
                         THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN l.status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
                SUM(CASE WHEN l.deduped = 1 THEN 1 ELSE 0 END) AS deduped,
                SUM(CASE WHEN l.error_code = 'suppressed' THEN 1 ELSE 0 END) AS blocked,
                AVG(CASE WHEN l.status IN ('success','failed')
                              AND l.deduped = 0
                              AND l.attempt_no >= 1
                              AND COALESCE(l.error_code,'') != 'suppressed'
                              AND l.latency_ms > 0 THEN l.latency_ms END) AS avgLatencyMs
         FROM send_logs l
         JOIN destinations d ON d.id = l.destination_id
         WHERE l.business_date BETWEEN ? AND ? ${destFilter}
         GROUP BY l.destination_id, l.business_date
         ORDER BY l.business_date DESC, l.destination_id`,
      )
      .all(...params) as Array<Omit<DailyStatRow, 'successRate' | 'p95LatencyMs'>>;
    return rows.map((row) => {
      const latencies = (
        this.db
          .prepare(
            `SELECT latency_ms AS ms FROM send_logs
             WHERE destination_id = ? AND business_date = ?
               AND status IN ('success','failed') AND deduped = 0 AND attempt_no >= 1
               AND COALESCE(error_code,'') != 'suppressed'
               AND latency_ms > 0
             ORDER BY latency_ms`,
          )
          .all(row.destinationId, row.businessDate) as { ms: number }[]
      ).map((r) => Number(r.ms));
      return {
        ...row,
        attempts: Number(row.attempts),
        success: Number(row.success),
        failed: Number(row.failed),
        deferred: Number(row.deferred),
        deduped: Number(row.deduped),
        avgLatencyMs: Number(Number(row.avgLatencyMs ?? 0).toFixed(1)),
        p95LatencyMs: percentile(latencies, 0.95),
        latencySamples: latencies.length,
        successRate:
          Number(row.attempts) > 0 ? Number(((Number(row.success) / Number(row.attempts)) * 100).toFixed(2)) : 0,
      };
    });
  }

  // ---------- audit ----------
  audit(actor: string, action: string, target: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actor, action, target, JSON.stringify(detail ?? {}), nowIso());
  }
}

function percentile(sortedValues: number[], p: number): number {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1));
  return sortedValues[index] as number;
}
