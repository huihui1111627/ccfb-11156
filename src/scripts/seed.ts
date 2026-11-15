import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../config.js';
import { openDatabase } from '../db/sqlite.js';
import { initAppSchema } from '../db/schema.js';
import { AppRepo } from '../db/appRepo.js';
import { Warehouse } from '../db/warehouse.js';
import type { Destination, SyncTask } from '../types.js';
import { nowIso } from '../db/sqlite.js';

export interface SeedOptions {
  config?: AppConfig;
  userCount?: number;
  reset?: boolean;
}

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗'];
const GIVEN = ['伟', '芳', '娜', '秀英', '敏', '静', '丽', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀兰', '霞'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakePhone(rand: () => number): string {
  const prefixes = ['138', '139', '150', '151', '152', '158', '159', '186', '187', '188', '177', '180'];
  const prefix = prefixes[Math.floor(rand() * prefixes.length)]!;
  let tail = '';
  for (let i = 0; i < 8; i++) tail += Math.floor(rand() * 10);
  return `${prefix}${tail}`;
}

function chineseName(rand: () => number): string {
  const s = SURNAMES[Math.floor(rand() * SURNAMES.length)]!;
  const g = GIVEN[Math.floor(rand() * GIVEN.length)]!;
  return rand() < 0.5 ? s + g : s + g + GIVEN[Math.floor(rand() * GIVEN.length)]!;
}

const SEGMENTS = [
  { id: 'seg_new_users', name: '近30天新注册用户', description: '注册时间在最近 30 天且未完成首单' },
  { id: 'seg_high_value', name: '高价值复购用户', description: '近 90 天复购 ≥ 3 次' },
  { id: 'seg_cart_abandon', name: '加购未支付用户', description: '近 7 天加购但未支付' },
  { id: 'seg_lapsed', name: '流失预警用户', description: '过去 60 天无活跃' },
];

export interface SeedResult {
  config: AppConfig;
  warehouse: Warehouse;
  repo: AppRepo;
  destinations: Destination[];
  tasks: SyncTask[];
  userIds: string[];
}

export function seedDatabase(options: SeedOptions = {}): SeedResult {
  const config = options.config ?? loadConfig();
  const userCount = options.userCount ?? 400;
  fs.mkdirSync(config.dataDir, { recursive: true });

  if (options.reset !== false) {
    for (const file of [config.warehouseDbPath, config.appDbPath]) {
      for (const suffix of ['', '-wal', '-shm']) {
        const target = `${file}${suffix}`;
        if (fs.existsSync(target)) fs.rmSync(target);
      }
    }
  }

  const warehouse = new Warehouse(openDatabase(config.warehouseDbPath));
  const repo = new AppRepo(openDatabase(config.appDbPath));
  initAppSchema(repo.db);

  const rand = mulberry32(0xc0ffee);
  const now = nowIso();
  const insertUser = warehouse.db.prepare(
    `INSERT INTO users (user_id, phone, name, email, opted_out, blacklisted, opted_out_at, blacklist_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const userIds: string[] = [];
  for (let i = 1; i <= userCount; i++) {
    const userId = `u${String(i).padStart(5, '0')}`;
    userIds.push(userId);
    const roll = rand();
    const optedOut = roll < 0.02 ? 1 : 0;
    const blacklisted = roll >= 0.02 && roll < 0.032 ? 1 : 0;
    insertUser.run(
      userId,
      fakePhone(rand),
      chineseName(rand),
      `${userId}@example.com`,
      optedOut,
      blacklisted,
      optedOut ? now : null,
      blacklisted ? '投诉骚扰' : null,
      now,
    );
  }

  const insertSegment = warehouse.db.prepare(
    'INSERT INTO segments (id, name, description, updated_at) VALUES (?, ?, ?, ?)',
  );
  const insertMember = warehouse.db.prepare(
    'INSERT OR IGNORE INTO segment_members (segment_id, user_id, version) VALUES (?, ?, 1)',
  );
  for (const segment of SEGMENTS) {
    insertSegment.run(segment.id, segment.name, segment.description, now);
  }
  for (const userId of userIds) {
    const n = Math.floor(rand() * 10);
    if (n < 3) insertMember.run(SEGMENTS[0]!.id, userId);
    if (n >= 2 && n < 5) insertMember.run(SEGMENTS[1]!.id, userId);
    if (n >= 4 && n < 7) insertMember.run(SEGMENTS[2]!.id, userId);
    if (n >= 7) insertMember.run(SEGMENTS[3]!.id, userId);
  }

  // Two users are deliberately in multiple segments to exercise SMS dedupe.
  const multi = userIds.slice(0, 12);
  for (const userId of multi) {
    insertMember.run(SEGMENTS[0]!.id, userId);
    insertMember.run(SEGMENTS[2]!.id, userId);
  }

  const ts = nowIso();
  const destinations: Destination[] = [
    {
      id: 'dest_sms',
      name: '营销短信平台',
      platform: 'sms',
      baseUrl: 'http://127.0.0.1:4101',
      enabled: true,
      config: {
        batchSize: 50,
        requestsPerSecond: 5,
        dailyQuota: 5000,
        maxRetries: 2,
        maxHttpRetries: 3,
        retryBackoffMs: 100,
        requestTimeoutMs: 5000,
        hash: { algorithm: 'sha256', salt: 'sms-2024', uppercase: true },
        smsDailyDedupe: true,
      },
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'dest_wecom',
      name: '企业微信客户群',
      platform: 'wecom',
      baseUrl: 'http://127.0.0.1:4102',
      enabled: true,
      config: {
        batchSize: 100,
        requestsPerSecond: 8,
        dailyQuota: 8000,
        maxRetries: 2,
        maxHttpRetries: 3,
        retryBackoffMs: 100,
        requestTimeoutMs: 5000,
        hash: { algorithm: 'md5', salt: '', uppercase: false },
        smsDailyDedupe: false,
      },
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'dest_ads',
      name: '巨量广告投放',
      platform: 'ads',
      baseUrl: 'http://127.0.0.1:4103',
      enabled: true,
      config: {
        batchSize: 200,
        requestsPerSecond: 10,
        dailyQuota: 20000,
        maxRetries: 1,
        maxHttpRetries: 2,
        retryBackoffMs: 100,
        requestTimeoutMs: 5000,
        hash: { algorithm: 'sha256', salt: 'ads_salt_v2', uppercase: false },
        smsDailyDedupe: false,
      },
      createdAt: ts,
      updatedAt: ts,
    },
  ];

  const tasks: SyncTask[] = [
    {
      id: 'task_sms_new',
      name: '新客短信唤醒',
      segmentId: 'seg_new_users',
      destinationId: 'dest_sms',
      audienceId: 'sms_new_users',
      enabled: true,
      confirmThreshold: 1000,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'task_sms_cart',
      name: '加购短信提醒',
      segmentId: 'seg_cart_abandon',
      destinationId: 'dest_sms',
      audienceId: 'sms_cart_abandon',
      enabled: true,
      confirmThreshold: 1000,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'task_wecom_high',
      name: '高价值用户企微群',
      segmentId: 'seg_high_value',
      destinationId: 'dest_wecom',
      audienceId: 'wecom_high_value',
      enabled: true,
      confirmThreshold: 500,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'task_ads_lapsed',
      name: '流失用户广告召回',
      segmentId: 'seg_lapsed',
      destinationId: 'dest_ads',
      audienceId: 'ads_lapsed',
      enabled: true,
      confirmThreshold: 500,
      createdAt: ts,
      updatedAt: ts,
    },
  ];

  for (const destination of destinations) repo.insertDestination(destination);
  for (const task of tasks) repo.insertTask(task);

  return { config, warehouse, repo, destinations, tasks, userIds };
}

/** Gradient/change generator so demo rounds are deterministic but not trivial. */
export interface SegmentMutation {
  addToSegment?: Array<{ segmentId: string; count: number }>;
  removeFromSegment?: Array<{ segmentId: string; count: number }>;
  optOut?: number;
  blacklist?: number;
}

export function mutateWarehouse(
  warehouse: Warehouse,
  userIds: string[],
  round: number,
  mutation?: SegmentMutation,
): void {
  const rand = mulberry32(1000 + round * 37);
  const segments = SEGMENTS.map((s) => s.id);
  const insertMember = warehouse.db.prepare(
    'INSERT OR IGNORE INTO segment_members (segment_id, user_id, version) VALUES (?, ?, 1)',
  );
  const removeMember = warehouse.db.prepare(
    'DELETE FROM segment_members WHERE segment_id = ? AND user_id = ?',
  );

  const addPlan = mutation?.addToSegment ?? [
    { segmentId: 'seg_new_users', count: 25 },
    { segmentId: 'seg_cart_abandon', count: 15 },
  ];
  const removePlan = mutation?.removeFromSegment ?? [{ segmentId: 'seg_new_users', count: 12 }];

  for (const plan of addPlan) {
    const notInSegment = userIds.filter((userId) => {
      const row = warehouse.db
        .prepare('SELECT 1 AS x FROM segment_members WHERE segment_id = ? AND user_id = ?')
        .get(plan.segmentId, userId);
      return !row;
    });
    for (let i = 0; i < plan.count && notInSegment.length; i++) {
      const player = notInSegment[Math.floor(rand() * notInSegment.length)]!;
      insertMember.run(plan.segmentId, player);
    }
  }
  for (const plan of removePlan) {
    const inSegment = warehouse.db
      .prepare('SELECT user_id AS userId FROM segment_members WHERE segment_id = ?')
      .all(plan.segmentId) as { userId: string }[];
    for (let i = 0; i < plan.count && inSegment.length; i++) {
      const pick = inSegment[Math.floor(rand() * inSegment.length)]!;
      removeMember.run(plan.segmentId, pick.userId);
    }
  }
  if (mutation?.optOut) {
    warehouse.db.exec(
      `UPDATE users SET opted_out = 1, opted_out_at = datetime('now')
       WHERE user_id IN (SELECT user_id FROM users WHERE opted_out = 0 AND blacklisted = 0 ORDER BY user_id LIMIT ${Math.floor(mutation.optOut)})`,
    );
  }
  if (mutation?.blacklist) {
    warehouse.db.exec(
      `UPDATE users SET blacklisted = 1, blacklist_reason = '监管投诉'
       WHERE user_id IN (SELECT user_id FROM users WHERE blacklisted = 0 AND opted_out = 0 ORDER BY user_id DESC LIMIT ${Math.floor(mutation.blacklist)})`,
    );
  }
  for (const segmentId of segments) {
    warehouse.db
      .prepare('UPDATE segments SET updated_at = ? WHERE id = ?')
      .run(nowIso(), segmentId);
  }
}

export { SEGMENTS, chineseName, fakePhone, mulberry32 };
