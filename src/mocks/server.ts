import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../db/sqlite.js';
import { normalizePhone } from '../core/phone.js';

export type MockPlatform = 'sms' | 'wecom' | 'ads';

export interface MockConfig {
  name: string;
  platform: MockPlatform;
  /** Requests allowed per wall-clock second. */
  rpsLimit: number;
  /** Hard cap on contacts per request; larger batches are rejected with 413. */
  maxBatchSize: number;
  /** Per-day quota of accepted adds. */
  dailyQuota: number;
  /** Artificial latency per request. */
  latencyMs: number;
  /** Percent of items that fail transiently on a given attempt (retry can succeed). */
  transientFailPct: number;
  /** Percent of items that always fail. */
  permanentFailPct: number;
  /** Next N requests fail at HTTP level with 503. */
  failNextRequests: number;
  hash: { algorithm: 'sha256' | 'md5'; salt: string; uppercase: boolean };
}

const DEFAULT_CONFIG: MockConfig = {
  name: 'mock',
  platform: 'sms',
  rpsLimit: 10,
  maxBatchSize: 200,
  dailyQuota: 100000,
  latencyMs: 5,
  transientFailPct: 0,
  permanentFailPct: 0,
  failNextRequests: 0,
  hash: { algorithm: 'sha256', salt: '', uppercase: false },
};

interface Contact {
  userId: string;
  phoneHash?: string;
  sendSms?: boolean;
}

interface MockStateRow {
  key: string;
  value: string;
}

function stableHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid json: ${(error as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * A fake downstream platform. It owns its own SQLite file, enforces rate
 * limits/quota/batch size, validates phone hashes against a known salt, and can
 * inject partial failures. It never trusts the sync engine.
 */
export class MockPlatformServer {
  private server: http.Server | null = null;
  private readonly db: DatabaseSync;
  private readonly configPath: string;
  private config: MockConfig;
  private readonly secondCounters = new Map<number, number>();
  private inflightFailures = 0;
  private listeningPort = 0;

  constructor(
    readonly platform: MockPlatform,
    private readonly dbPath: string,
    config?: Partial<MockConfig>,
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.configPath = `${dbPath}.config.json`;
    this.config = this.loadConfig(config);
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS members (
        audience_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        phone_hash TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (audience_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS usage (
        business_date TEXT PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attempts (
        audience_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (audience_id, user_id, action)
      );
      CREATE TABLE IF NOT EXISTS texts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_date TEXT NOT NULL,
        phone TEXT NOT NULL,
        audience_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_texts_day ON texts(business_date, phone);
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        batch_size INTEGER NOT NULL,
        outcome TEXT NOT NULL
      );
    `);
  }

  private loadConfig(override?: Partial<MockConfig>): MockConfig {
    let stored: Partial<MockConfig> = {};
    if (fs.existsSync(this.configPath)) {
      try {
        stored = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<MockConfig>;
      } catch {
        stored = {};
      }
    }
    const merged = {
      ...DEFAULT_CONFIG,
      ...stored,
      ...(override ?? {}),
      hash: { ...DEFAULT_CONFIG.hash, ...(stored.hash ?? {}), ...(override?.hash ?? {}) },
    } as MockConfig;
    merged.platform = this.platform;
    return merged;
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  getConfig(): MockConfig {
    return { ...this.config, hash: { ...this.config.hash } };
  }

  updateConfig(patch: Partial<MockConfig>): MockConfig {
    const next: MockConfig = {
      ...this.config,
      ...patch,
      hash: { ...this.config.hash, ...(patch.hash ?? {}) },
      platform: this.platform,
    };
    next.rpsLimit = Math.max(1, Math.round(next.rpsLimit));
    next.maxBatchSize = Math.max(1, Math.round(next.maxBatchSize));
    next.dailyQuota = Math.max(0, Math.round(next.dailyQuota));
    next.transientFailPct = clampPct(next.transientFailPct);
    next.permanentFailPct = clampPct(next.permanentFailPct);
    next.failNextRequests = Math.max(0, Math.round(next.failNextRequests));
    this.config = next;
    this.inflightFailures = next.failNextRequests;
    this.saveConfig();
    return this.getConfig();
  }

  private expectedHash(phone: string): string {
    const { algorithm, salt, uppercase } = this.config.hash;
    const digest = createHash(algorithm)
      .update(`${salt}${normalizePhone(phone)}`, 'utf8')
      .digest('hex');
    return uppercase ? digest.toUpperCase() : digest;
  }

  seedUsers(users: Array<{ userId: string; phone: string }>): void {
    const stmt = this.db.prepare(
      'INSERT INTO users (user_id, phone) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone',
    );
    for (const u of users) stmt.run(u.userId, normalizePhone(u.phone));
  }

  private recordRequest(pathname: string, status: number, batchSize: number, outcome: string): void {
    this.db
      .prepare('INSERT INTO requests (ts, path, status, batch_size, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), pathname, status, batchSize, outcome);
  }

  private rateLimited(): boolean {
    const second = Math.floor(Date.now() / 1000);
    const count = (this.secondCounters.get(second) ?? 0) + 1;
    this.secondCounters.set(second, count);
    if (this.secondCounters.size > 30) {
      for (const key of this.secondCounters.keys()) if (key < second - 5) this.secondCounters.delete(key);
    }
    return count > this.config.rpsLimit;
  }

  async start(port: number, host = '127.0.0.1'): Promise<number> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: Error) => {
        if (!res.headersSent) json(res, 500, { error: 'mock_internal_error', message: error.message });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    this.listeningPort = resolvedPort;
    return resolvedPort;
  }

  get port(): number {
    return this.listeningPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    this.db.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, platform: this.platform, name: this.config.name });
      return;
    }
    if (method === 'GET' && url.pathname === '/mock/config') {
      json(res, 200, this.config);
      return;
    }
    if (method === 'PATCH' && url.pathname === '/mock/config') {
      const patch = (await readBody(req)) as Partial<MockConfig>;
      json(res, 200, this.updateConfig(patch));
      return;
    }
    if (method === 'POST' && url.pathname === '/mock/seed') {
      const body = (await readBody(req)) as { users?: Array<{ userId: string; phone: string }> };
      this.seedUsers(body.users ?? []);
      json(res, 200, { seeded: body.users?.length ?? 0 });
      return;
    }
    if (method === 'POST' && url.pathname === '/mock/reset') {
      this.db.exec('DELETE FROM members; DELETE FROM usage; DELETE FROM attempts; DELETE FROM texts; DELETE FROM requests;');
      this.inflightFailures = this.config.failNextRequests;
      json(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url.pathname === '/mock/state') {
      json(res, 200, this.state());
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/usage') {
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
      const used = this.usage(date);
      json(res, 200, { limit: this.config.dailyQuota, used, remaining: Math.max(0, this.config.dailyQuota - used) });
      return;
    }
    const membersMatch = /^\/v1\/audience\/([^/]+)\/members$/.exec(url.pathname);
    if (membersMatch && method === 'GET') {
      const audienceId = decodeURIComponent(membersMatch[1] as string);
      const rows = this.db
        .prepare('SELECT user_id AS userId, phone_hash AS phoneHash, added_at AS addedAt FROM members WHERE audience_id = ? ORDER BY user_id')
        .all(audienceId);
      json(res, 200, { audienceId, members: rows });
      return;
    }
    if (membersMatch && method === 'POST') {
      await this.handleMembers(req, res, decodeURIComponent(membersMatch[1] as string));
      return;
    }
    json(res, 404, { error: 'not_found' });
  }

  private usage(date: string): number {
    const row = this.db.prepare('SELECT used FROM usage WHERE business_date = ?').get(date) as
      | { used: number }
      | undefined;
    return row ? Number(row.used) : 0;
  }

  private addUsage(date: string, delta: number): number {
    this.db
      .prepare(
        `INSERT INTO usage (business_date, used) VALUES (?, ?)
         ON CONFLICT(business_date) DO UPDATE SET used = used + excluded.used`,
      )
      .run(date, delta);
    return this.usage(date);
  }

  private attemptCount(audienceId: string, userId: string, action: string): number {
    const row = this.db
      .prepare('SELECT count FROM attempts WHERE audience_id = ? AND user_id = ? AND action = ?')
      .get(audienceId, userId, action) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  private bumpAttempt(audienceId: string, userId: string, action: string): number {
    this.db
      .prepare(
        `INSERT INTO attempts (audience_id, user_id, action, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(audience_id, user_id, action) DO UPDATE SET count = count + 1`,
      )
      .run(audienceId, userId, action);
    return this.attemptCount(audienceId, userId, action);
  }

  private async handleMembers(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    audienceId: string,
  ): Promise<void> {
    const started = Date.now();
    const body = (await readBody(req)) as {
      action?: 'add' | 'remove';
      businessDate?: string;
      batchId?: string;
      contacts?: Contact[];
    };
    const action = body.action === 'remove' ? 'remove' : 'add';
    const businessDate = body.businessDate || new Date().toISOString().slice(0, 10);
    const contacts = Array.isArray(body.contacts) ? body.contacts : [];

    if (this.rateLimited()) {
      this.recordRequest(req.url ?? '', 429, contacts.length, 'rate_limited');
      const retryAfterMs = 1000 - (Date.now() % 1000);
      res.setHeader('retry-after', Math.ceil(retryAfterMs / 1000));
      json(res, 429, { error: 'rate_limited', retryAfterMs });
      return;
    }
    if (contacts.length === 0) {
      this.recordRequest(req.url ?? '', 400, 0, 'empty_batch');
      json(res, 400, { error: 'empty_batch' });
      return;
    }
    if (contacts.length > this.config.maxBatchSize) {
      this.recordRequest(req.url ?? '', 413, contacts.length, 'batch_too_large');
      json(res, 413, {
        error: 'batch_too_large',
        message: `max batch size is ${this.config.maxBatchSize}, got ${contacts.length}`,
      });
      return;
    }
    if (this.inflightFailures > 0) {
      this.inflightFailures -= 1;
      this.recordRequest(req.url ?? '', 503, contacts.length, 'injected_http_failure');
      json(res, 503, { error: 'service_unavailable' });
      return;
    }
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    const userLookup = this.db.prepare('SELECT phone FROM users WHERE user_id = ?');
    const results: Array<{
      userId: string;
      ok: boolean;
      errorCode?: string;
      errorMessage?: string;
      billed?: boolean;
      texted?: boolean;
    }> = [];
    let acceptedAdds = 0;
    let used = this.usage(businessDate);

    for (const contact of contacts) {
      const userId = String(contact?.userId ?? '');
      const attempt = this.bumpAttempt(audienceId, userId, action);
      const dice = stableHash(`${audienceId}:${userId}:${attempt}`) % 100;
      const permanentDice = stableHash(`permanent:${audienceId}:${userId}`) % 100;

      if (!userId) {
        results.push({ userId, ok: false, errorCode: 'invalid_contact', errorMessage: 'missing userId' });
        continue;
      }
      if (permanentDice < this.config.permanentFailPct) {
        results.push({
          userId,
          ok: false,
          errorCode: 'platform_rejected',
          errorMessage: '用户资料被平台拒绝 (permanent)',
        });
        continue;
      }
      if (dice < this.config.transientFailPct) {
        results.push({
          userId,
          ok: false,
          errorCode: 'upstream_timeout',
          errorMessage: '平台上游超时 (transient)',
        });
        continue;
      }

      const known = userLookup.get(userId) as { phone: string } | undefined;
      if (!known) {
        results.push({
          userId,
          ok: false,
          errorCode: 'unmatched_hash',
          errorMessage: '手机号哈希与平台用户库不匹配',
        });
        continue;
      }
      if (action === 'add' && String(contact.phoneHash ?? '') !== this.expectedHash(known.phone)) {
        results.push({
          userId,
          ok: false,
          errorCode: 'unmatched_hash',
          errorMessage: '手机号哈希与平台用户库不匹配 (salt/algorithm/case)',
        });
        continue;
      }

      if (action === 'add') {
        const existing = this.db
          .prepare('SELECT phone_hash AS phoneHash FROM members WHERE audience_id = ? AND user_id = ?')
          .get(audienceId, userId) as { phoneHash: string } | undefined;
        const incomingHash = String(contact.phoneHash);
        if (existing) {
          // Already a member. If the phone (and therefore the hash) changed,
          // update it in place — still idempotent, still no extra quota, and
          // no text is sent for an existing membership.
          if (existing.phoneHash !== incomingHash) {
            this.db
              .prepare('UPDATE members SET phone_hash = ?, added_at = ? WHERE audience_id = ? AND user_id = ?')
              .run(incomingHash, nowIso(), audienceId, userId);
          }
          results.push({ userId, ok: true, billed: false, texted: false });
          continue;
        }
        if (used >= this.config.dailyQuota) {
          results.push({
            userId,
            ok: false,
            errorCode: 'quota_exhausted',
            errorMessage: '该目的地今日配额已用尽',
          });
          continue;
        }
        used = this.addUsage(businessDate, 1);
        acceptedAdds += 1;
        this.db
          .prepare('INSERT INTO members (audience_id, user_id, phone_hash, added_at) VALUES (?, ?, ?, ?)')
          .run(audienceId, userId, incomingHash, nowIso());
        const texted = this.platform === 'sms' && contact.sendSms !== false;
        if (texted) {
          // Deliberately NOT deduped here: the sync engine is responsible for
          // cross-audience daily dedupe, so duplicate texts must be observable.
          this.db
            .prepare(
              `INSERT INTO texts (business_date, phone, audience_id, user_id, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(businessDate, normalizePhone(known.phone), audienceId, userId, nowIso());
        }
        results.push({ userId, ok: true, billed: true, texted });
        continue;
      } else {
        this.db.prepare('DELETE FROM members WHERE audience_id = ? AND user_id = ?').run(audienceId, userId);
      }
      results.push({ userId, ok: true });
    }

    const status = results.every((r) => r.ok) ? 200 : 200;
    this.recordRequest(req.url ?? '', status, contacts.length, results.every((r) => r.ok) ? 'ok' : 'partial');
    json(res, status, {
      results,
      acceptedAdds,
      quota: {
        limit: this.config.dailyQuota,
        used,
        remaining: Math.max(0, this.config.dailyQuota - used),
      },
      latencyMs: Date.now() - started,
    });
  }

  /** Snapshot used by the verifier and the UI mock panel. */
  state(): unknown {
    const members = this.db
      .prepare('SELECT audience_id AS audienceId, user_id AS userId, phone_hash AS phoneHash FROM members ORDER BY audience_id, user_id')
      .all() as Array<{ audienceId: string; userId: string; phoneHash: string }>;
    const audiences = new Map<string, Array<{ userId: string; phoneHash: string }>>();
    for (const m of members) {
      const list = audiences.get(m.audienceId) ?? [];
      list.push({ userId: m.userId, phoneHash: m.phoneHash });
      audiences.set(m.audienceId, list);
    }
    const usage = this.db.prepare('SELECT business_date AS date, used FROM usage ORDER BY business_date').all();
    const texts = this.db
      .prepare('SELECT business_date AS date, phone, audience_id AS audienceId, user_id AS userId FROM texts ORDER BY date, phone')
      .all();
    const requests = this.db
      .prepare('SELECT ts, status, batch_size AS batchSize, outcome FROM requests ORDER BY id')
      .all() as Array<{ ts: number; status: number; batchSize: number; outcome: string }>;
    // Only requests the platform actually accepted count toward the observed
    // batch size / RPS; a 413 or 429 is a rejection, not a violation of limits.
    const accepted = requests.filter((r) => {
      const status = Number(r.status);
      return status !== 413 && status !== 429;
    });
    const maxBatch = accepted.reduce((max, r) => Math.max(max, Number(r.batchSize)), 0);
    const rateBucket = new Map<number, number>();
    for (const r of accepted) {
      const sec = Math.floor(Number(r.ts) / 1000);
      rateBucket.set(sec, (rateBucket.get(sec) ?? 0) + 1);
    }
    const maxRequestsPerSecond = [...rateBucket.values()].reduce((max, n) => Math.max(max, n), 0);
    const rateLimitedResponses = requests.filter((r) => Number(r.status) === 429).length;
    const rejectedForBatchSize = requests.filter((r) => Number(r.status) === 413).length;
    return {
      platform: this.platform,
      config: this.getConfig(),
      audiences: [...audiences.entries()].map(([audienceId, list]) => ({
        audienceId,
        count: list.length,
        members: list,
      })),
      usage,
      texts,
      stats: {
        requests: requests.length,
        acceptedRequests: accepted.length,
        maxBatchSizeSeen: maxBatch,
        maxRequestsPerSecond,
        rateLimitedResponses,
        rejectedForBatchSize,
      },
    };
  }
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export async function startMocks(
  dbDir: string,
  ports: { sms: number; wecom: number; ads: number },
  overrides: Partial<Record<MockPlatform, Partial<MockConfig>>> = {},
): Promise<Record<MockPlatform, MockPlatformServer>> {
  const sms = new MockPlatformServer('sms', path.join(dbDir, 'sms.db'), {
    name: '短信平台 Mock',
    platform: 'sms',
    hash: { algorithm: 'sha256', salt: 'sms-2024', uppercase: true },
    ...(overrides.sms ?? {}),
  });
  const wecom = new MockPlatformServer('wecom', path.join(dbDir, 'wecom.db'), {
    name: '企业微信 Mock',
    platform: 'wecom',
    hash: { algorithm: 'md5', salt: '', uppercase: false },
    ...(overrides.wecom ?? {}),
  });
  const ads = new MockPlatformServer('ads', path.join(dbDir, 'ads.db'), {
    name: '广告投放平台 Mock',
    platform: 'ads',
    hash: { algorithm: 'sha256', salt: 'ads_salt_v2', uppercase: false },
    ...(overrides.ads ?? {}),
  });
  await Promise.all([
    sms.start(ports.sms).then((port) => {
      ports.sms = port;
    }),
    wecom.start(ports.wecom).then((port) => {
      ports.wecom = port;
    }),
    ads.start(ports.ads).then((port) => {
      ports.ads = port;
    }),
  ]);
  return { sms, wecom, ads };
}
