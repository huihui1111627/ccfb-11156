import type { AppConfig } from '../config.js';
import { AppRepo } from '../db/appRepo.js';
import { Warehouse } from '../db/warehouse.js';
import type { Db } from '../db/sqlite.js';
import { nowIso, makeId } from '../db/sqlite.js';
import { HttpPlatformAdapter } from '../platform/adapter.js';
import { SyncService } from '../core/syncService.js';
import { verifyPlatforms, type MockSnapshot } from '../core/verify.js';
import { businessDate, isValidBusinessDate } from '../core/time.js';
import type { Destination, DestinationConfig, RunPreview, SyncTask } from '../types.js';
import { ApiError, Router, json } from './http.js';

export interface ApiContext {
  config: AppConfig;
  repo: AppRepo;
  warehouse: Warehouse;
  adapter: HttpPlatformAdapter;
  sync: SyncService;
  appDb: Db;
}

const PLATFORM_DEFAULT_HASH: Record<string, DestinationConfig['hash']> = {
  sms: { algorithm: 'sha256', salt: 'sms-2024', uppercase: true },
  wecom: { algorithm: 'md5', salt: '', uppercase: false },
  ads: { algorithm: 'sha256', salt: 'ads_salt_v2', uppercase: false },
};

function intField(value: unknown, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, `${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return n;
}

function boolField(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : Boolean(value);
}

function validateDestinationConfig(raw: unknown, platform: string): DestinationConfig {
  const input = (raw ?? {}) as Partial<DestinationConfig>;
  const hash = input.hash ?? PLATFORM_DEFAULT_HASH[platform]!;
  if (hash.algorithm !== 'sha256' && hash.algorithm !== 'md5') {
    throw new ApiError(400, 'hash.algorithm 只能是 sha256 或 md5');
  }
  return {
    batchSize: intField(input.batchSize ?? 100, 'batchSize', 1, 500),
    requestsPerSecond: intField(input.requestsPerSecond ?? 5, 'requestsPerSecond', 1, 100),
    dailyQuota: intField(input.dailyQuota ?? 10000, 'dailyQuota', 0, 10_000_000),
    maxRetries: intField(input.maxRetries ?? 2, 'maxRetries', 0, 10),
    maxHttpRetries: intField(input.maxHttpRetries ?? 3, 'maxHttpRetries', 1, 10),
    retryBackoffMs: intField(input.retryBackoffMs ?? 100, 'retryBackoffMs', 0, 60_000),
    requestTimeoutMs: intField(input.requestTimeoutMs ?? 5000, 'requestTimeoutMs', 100, 120_000),
    hash: {
      algorithm: hash.algorithm,
      salt: String(hash.salt ?? ''),
      uppercase: Boolean(hash.uppercase),
    },
    smsDailyDedupe: boolField(input.smsDailyDedupe, platform === 'sms'),
  };
}

export function buildRouter(ctx: ApiContext): Router {
  const router = new Router();
  const { repo, warehouse, adapter, sync } = ctx;

  // ---------- health ----------
  router.get('/api/health', async () => {
    const destinations = repo.listDestinations();
    const health = await Promise.all(
      destinations.map(async (d) => ({ id: d.id, ...(await adapter.health(d)) })),
    );
    return json({
      ok: true,
      time: nowIso(),
      businessDate: businessDate(),
      warehouseUsers: warehouse.countUsers(),
      destinations: health,
    });
  });

  // ---------- destinations ----------
  router.get('/api/destinations', async () => {
    const destinations = repo.listDestinations();
    const health = await Promise.all(
      destinations.map(async (d) => {
        const h = await adapter.health(d);
        const usage = await adapter.getUsage(d, businessDate()).catch(() => null);
        return {
          ...d,
          health: h,
          usage,
          openFailures: repo.countOpenFailures(d.id),
          taskCount: repo.listTasks().filter((t) => t.destinationId === d.id).length,
        };
      }),
    );
    return json({ destinations: health });
  });

  router.post('/api/destinations', async ({ body }) => {
    const input = (body ?? {}) as Partial<Destination>;
    const platform = input.platform ?? 'sms';
    if (!['sms', 'wecom', 'ads'].includes(platform)) {
      throw new ApiError(400, 'platform 只能是 sms/wecom/ads');
    }
    if (!input.name || !input.baseUrl) throw new ApiError(400, 'name 和 baseUrl 必填');
    const ts = nowIso();
    const destination: Destination = {
      id: input.id ?? makeId('dest'),
      name: String(input.name),
      platform,
      baseUrl: String(input.baseUrl),
      enabled: boolField(input.enabled, true),
      config: validateDestinationConfig(input.config, platform),
      createdAt: ts,
      updatedAt: ts,
    };
    repo.insertDestination(destination);
    repo.audit('operator', 'destination.create', destination.id, destination);
    return json({ destination }, 201);
  });

  router.patch('/api/destinations/:id', async ({ params, body }) => {
    const existing = repo.getDestination(params.id);
    if (!existing) throw new ApiError(404, '目的地不存在', 'not_found');
    const input = (body ?? {}) as Partial<Destination>;
    const platform = (input.platform ?? existing.platform) as Destination['platform'];
    const merged: Destination = {
      ...existing,
      name: input.name ? String(input.name) : existing.name,
      platform,
      baseUrl: input.baseUrl ? String(input.baseUrl) : existing.baseUrl,
      enabled: boolField(input.enabled, existing.enabled),
      config: input.config ? validateDestinationConfig(input.config, platform) : existing.config,
      updatedAt: nowIso(),
    };
    repo.updateDestination(merged);
    repo.audit('operator', 'destination.update', merged.id, merged);
    return json({ destination: merged });
  });

  router.delete('/api/destinations/:id', async ({ params }) => {
    const tasks = repo.listTasks().filter((t) => t.destinationId === params.id);
    if (tasks.length) throw new ApiError(409, '该目的地仍有同步任务, 请先删除任务', 'in_use');
    repo.deleteDestination(params.id);
    repo.audit('operator', 'destination.delete', params.id, {});
    return json({ ok: true });
  });

  router.post('/api/destinations/:id/test', async ({ params }) => {
    const destination = repo.getDestination(params.id);
    if (!destination) throw new ApiError(404, '目的地不存在', 'not_found');
    const health = await adapter.health(destination);
    if (!health.ok) return json({ ok: false, error: health.error ?? '健康检查失败' }, 502);
    const usage = await adapter.getUsage(destination, businessDate());
    return json({ ok: true, health, usage });
  });

  // ---------- mock control (proxied so the UI has one origin) ----------
  router.get('/api/destinations/:id/mock', async ({ params }) => {
    const destination = requireDestination(repo, params.id);
    return json({ state: await adapter.mockState(destination) });
  });

  router.patch('/api/destinations/:id/mock', async ({ params, body }) => {
    const destination = requireDestination(repo, params.id);
    const state = await adapter.updateMockConfig(destination, (body ?? {}) as Record<string, unknown>);
    repo.audit('operator', 'mock.update', destination.id, body);
    return json({ config: state });
  });

  // ---------- tasks ----------
  router.get('/api/tasks', async () => {
    const tasks = repo.listTasks().map((task) => {
      const segment = warehouse.getSegment(task.segmentId);
      const destination = repo.getDestination(task.destinationId);
      return {
        ...task,
        segmentName: segment?.name ?? '(分群已删除)',
        segmentCount: segment?.memberCount ?? 0,
        destinationName: destination?.name ?? '(目的地已删除)',
        platform: destination?.platform ?? null,
        syncedCount: repo.syncedMembers(task.id).size,
      };
    });
    return json({ tasks });
  });

  router.post('/api/tasks', async ({ body }) => {
    const input = (body ?? {}) as Partial<SyncTask>;
    const task = buildTask(repo, warehouse, input);
    repo.insertTask(task);
    repo.audit('operator', 'task.create', task.id, task);
    return json({ task }, 201);
  });

  router.patch('/api/tasks/:id', async ({ params, body }) => {
    const existing = repo.getTask(params.id);
    if (!existing) throw new ApiError(404, '任务不存在', 'not_found');
    const input = (body ?? {}) as Partial<SyncTask>;
    const merged = buildTask(repo, warehouse, { ...existing, ...input, id: existing.id });
    merged.createdAt = existing.createdAt;
    repo.updateTask(merged);
    repo.audit('operator', 'task.update', merged.id, merged);
    return json({ task: merged });
  });

  router.delete('/api/tasks/:id', async ({ params }) => {
    repo.deleteTask(params.id);
    repo.audit('operator', 'task.delete', params.id, {});
    return json({ ok: true });
  });

  // ---------- segments ----------
  router.get('/api/segments', async () => {
    return json({ segments: warehouse.listSegments() });
  });

  router.get('/api/segments/:id/members', async ({ params, query }) => {
    const segment = warehouse.getSegment(params.id);
    if (!segment) throw new ApiError(404, '分群不存在', 'not_found');
    const limit = Math.min(Number(query.get('limit') ?? 50), 500);
    const members = warehouse.listMembers(params.id).slice(0, limit);
    return json({
      segment,
      members: members.map((m) => ({
        userId: m.userId,
        name: m.name,
        phoneMasked: `${m.phone.slice(0, 3)}****${m.phone.slice(-4)}`,
        suppressed: m.suppressed,
        suppressedReason: m.suppressedReason,
      })),
    });
  });

  // ---------- preview ----------
  router.post('/api/preview', async ({ body }) => {
    const input = (body ?? {}) as { taskIds?: string[]; businessDate?: string };
    if (input.businessDate && !isValidBusinessDate(input.businessDate)) {
      throw new ApiError(400, 'businessDate 格式应为 YYYY-MM-DD');
    }
    const preview = await sync.preview({ taskIds: input.taskIds, businessDate: input.businessDate });
    return json({ preview });
  });

  // ---------- runs ----------
  router.post('/api/runs', async ({ body }) => {
    const input = (body ?? {}) as {
      taskIds?: string[];
      businessDate?: string;
      preview?: unknown;
      confirmed?: boolean;
      fingerprint?: string;
    };
    if (input.businessDate && !isValidBusinessDate(input.businessDate)) {
      throw new ApiError(400, 'businessDate 格式应为 YYYY-MM-DD');
    }
    if (sync.engine.isRunning()) throw new ApiError(409, '已有同步任务在执行', 'busy');

    // Never trust a client-supplied diff. If the caller sends a preview (e.g.
    // re-submitting the one it was shown), re-derive it server-side for the
    // same tasks/date and compare fingerprints. The server-derived preview is
    // what actually executes, so a tampered payload cannot redirect or inject.
    let preview: RunPreview;
    if (input.preview) {
      const supplied = input.preview as RunPreview;
      if (!Array.isArray(supplied.tasks) || typeof supplied.businessDate !== 'string') {
        throw new ApiError(400, 'preview 结构不合法', 'invalid_preview');
      }
      const taskIds = supplied.tasks.map((t) => t.taskId);
      const existing = supplied.runId ? repo.getRun(supplied.runId) : undefined;
      if (existing && ['running', 'completed', 'partial'].includes(existing.status)) {
        throw new ApiError(409, '该预览已经执行过, 请重新预览', 'already_executed');
      }
      const fresh = await sync.preview({ taskIds, businessDate: supplied.businessDate });
      if (fresh.fingerprint !== supplied.fingerprint) {
        throw new ApiError(409, '预览生成后数据已变化, 请重新预览确认', 'stale_preview');
      }
      preview = fresh;
    } else {
      preview = await sync.preview({ taskIds: input.taskIds, businessDate: input.businessDate });
    }
    if (preview.requiresConfirmation && !input.confirmed) {
      sync.savePreview(preview);
      return json({ preview, requiresConfirmation: true, summary: null }, 202);
    }

    // Re-check: a concurrent request may have started a run while we awaited
    // the preview / freshness check above.
    if (sync.engine.isRunning()) throw new ApiError(409, '已有同步任务在执行', 'busy');
    const summary = await sync.execute(preview, { confirmed: Boolean(input.confirmed) });
    return json({ preview, summary, requiresConfirmation: false });
  });

  router.get('/api/runs', async ({ query }) => {
    const limit = Math.min(Number(query.get('limit') ?? 30), 200);
    return json({ runs: repo.listRuns(limit) });
  });

  router.get('/api/runs/:id', async ({ params }) => {
    const run = repo.getRun(params.id);
    if (!run) throw new ApiError(404, '运行记录不存在', 'not_found');
    return json({ run });
  });

  // ---------- logs ----------
  router.get('/api/logs', async ({ query }) => {
    const result = repo.queryLogs({
      destinationId: query.get('destinationId') ?? undefined,
      segmentId: query.get('segmentId') ?? undefined,
      status: (query.get('status') as never) ?? undefined,
      action: (query.get('action') as never) ?? undefined,
      businessDate: query.get('businessDate') ?? undefined,
      runId: query.get('runId') ?? undefined,
      userId: query.get('userId') ?? undefined,
      limit: Number(query.get('limit') ?? 100),
      offset: Number(query.get('offset') ?? 0),
    });
    const taskNames = new Map(repo.listTasks().map((t) => [t.id, t.name]));
    const destNames = new Map(repo.listDestinations().map((d) => [d.id, d.name]));
    return json({
      total: result.total,
      logs: result.rows.map((row) => ({
        ...row,
        taskName: taskNames.get(row.taskId) ?? row.taskId,
        destinationName: destNames.get(row.destinationId) ?? row.destinationId,
      })),
    });
  });

  // ---------- failures ----------
  router.get('/api/failures', async ({ query }) => {
    const result = repo.listFailures({
      destinationId: query.get('destinationId') ?? undefined,
      taskId: query.get('taskId') ?? undefined,
      status: (query.get('status') as 'open' | 'resolved' | null) ?? 'open',
      limit: Number(query.get('limit') ?? 100),
      offset: Number(query.get('offset') ?? 0),
    });
    const taskNames = new Map(repo.listTasks().map((t) => [t.id, t.name]));
    return json({
      total: result.total,
      failures: result.rows.map((row) => ({ ...row, taskName: taskNames.get(row.taskId) ?? row.taskId })),
    });
  });

  router.post('/api/failures/retry', async ({ body }) => {
    const input = (body ?? {}) as { destinationId?: string; failureIds?: number[] };
    if (!input.destinationId) throw new ApiError(400, 'destinationId 必填');
    if (sync.engine.isRunning()) {
      throw new ApiError(409, '同步任务正在执行, 请等结束再重试失败项', 'busy');
    }
    const result = await sync.retryService.retry(input.destinationId, { failureIds: input.failureIds });
    return json({ result });
  });

  router.post('/api/failures/:id/resolve', async ({ params, body }) => {
    const id = Number(params.id);
    const failure = repo.getFailure(id);
    if (!failure) throw new ApiError(404, '失败记录不存在', 'not_found');
    const note = String((body as { note?: string } | undefined)?.note ?? '人工标记为已处理');
    repo.resolveFailure(id, note);
    repo.audit('operator', 'failure.resolve', String(id), { note });
    return json({ ok: true });
  });

  // ---------- stats ----------
  router.get('/api/stats', async ({ query }) => {
    const to = query.get('to') ?? businessDate();
    const from = query.get('from') ?? to;
    const rows = repo.dailyStats(from, to, query.get('destinationId') ?? undefined);
    const byDestination = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byDestination.get(row.destinationId) ?? [];
      list.push(row);
      byDestination.set(row.destinationId, list);
    }
    return json({
      from,
      to,
      stats: rows,
      summary: [...byDestination.entries()].map(([destinationId, list]) => {
        const attempts = list.reduce((n, r) => n + r.attempts, 0);
        const success = list.reduce((n, r) => n + r.success, 0);
        const latencySamples = list.reduce((n, r) => n + r.latencySamples, 0);
        // Weight each day's average by the number of latency samples behind it,
        // not by attempts (a day can have attempts without a latency sample).
        const latencyWeighted = list.reduce((n, r) => n + r.avgLatencyMs * r.latencySamples, 0);
        return {
          destinationId,
          destinationName: list[0]!.destinationName,
          platform: list[0]!.platform,
          days: list.length,
          attempts,
          success,
          failed: list.reduce((n, r) => n + r.failed, 0),
          deferred: list.reduce((n, r) => n + r.deferred, 0),
          deduped: list.reduce((n, r) => n + r.deduped, 0),
          blocked: list.reduce((n, r) => n + r.blocked, 0),
          successRate: attempts ? Number(((success / attempts) * 100).toFixed(2)) : 0,
          avgLatencyMs: latencySamples
            ? Number((latencyWeighted / latencySamples).toFixed(1))
            : 0,
        };
      }),
    });
  });

  // ---------- verify ----------
  router.get('/api/verify', async ({ query }) => {
    const destinations = repo.listDestinations();
    const snapshots: Partial<Record<'sms' | 'wecom' | 'ads', MockSnapshot>> = {};
    for (const destination of destinations) {
      try {
        snapshots[destination.platform] = (await adapter.mockState(destination)) as MockSnapshot;
      } catch {
        // platform unreachable: report separately below
      }
    }
    const date = query.get('businessDate') ?? businessDate();
    if (!isValidBusinessDate(date)) throw new ApiError(400, 'businessDate 格式应为 YYYY-MM-DD');
    const report = verifyPlatforms(repo, warehouse, snapshots, date);
    return json({ ...report, snapshots });
  });

  // ---------- audit ----------
  router.get('/api/audit', async ({ query }) => {
    const limit = Math.min(Number(query.get('limit') ?? 100), 500);
    const rows = ctx.appDb
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; actor: string; action: string; target: string; detail_json: string; created_at: string }>;
    return json({
      audit: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        target: r.target,
        detail: JSON.parse(r.detail_json),
        createdAt: r.created_at,
      })),
    });
  });

  return router;
}

function requireDestination(repo: AppRepo, id: string): Destination {
  const destination = repo.getDestination(id);
  if (!destination) throw new ApiError(404, '目的地不存在', 'not_found');
  return destination;
}

function buildTask(repo: AppRepo, warehouse: Warehouse, input: Partial<SyncTask>): SyncTask {
  if (!input.name) throw new ApiError(400, '任务名称必填');
  if (!input.segmentId) throw new ApiError(400, 'segmentId 必填');
  if (!input.destinationId) throw new ApiError(400, 'destinationId 必填');
  if (!input.audienceId || !/^[A-Za-z0-9_-]{1,64}$/.test(input.audienceId)) {
    throw new ApiError(400, 'audienceId 只能包含字母/数字/下划线/短横线, 最长 64');
  }
  const segment = warehouse.getSegment(input.segmentId);
  if (!segment) throw new ApiError(400, `分群 ${input.segmentId} 不存在`);
  const destination = repo.getDestination(input.destinationId);
  if (!destination) throw new ApiError(400, `目的地 ${input.destinationId} 不存在`);

  const duplicate = repo.findTaskByDestinationAudience(
    input.destinationId,
    input.audienceId,
    input.id ?? '',
  );
  if (duplicate) {
    throw new ApiError(
      409,
      `同一目的地下 audienceId "${input.audienceId}" 已被任务「${duplicate.name}」占用, 两个任务会互相覆盖名单`,
      'audience_conflict',
    );
  }

  const ts = nowIso();
  return {
    id: input.id ?? makeId('task'),
    name: String(input.name),
    segmentId: String(input.segmentId),
    destinationId: String(input.destinationId),
    audienceId: String(input.audienceId),
    enabled: boolField(input.enabled, true),
    confirmThreshold: intField(input.confirmThreshold ?? 0, 'confirmThreshold', 0, 10_000_000),
    createdAt: input.createdAt ?? ts,
    updatedAt: ts,
  };
}
