import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../config.js';
import { openDatabase } from '../db/sqlite.js';
import { initAppSchema, initWarehouseSchema } from '../db/schema.js';
import { AppRepo } from '../db/appRepo.js';
import { Warehouse } from '../db/warehouse.js';
import { HttpPlatformAdapter } from '../platform/adapter.js';
import { SyncService } from '../core/syncService.js';
import { startMocks, type MockConfig, type MockPlatform, type MockPlatformServer } from '../mocks/server.js';
import { seedDatabase, type SeedResult } from '../scripts/seed.js';
import type { Destination, SyncTask } from '../types.js';
import { verifyPlatforms, type MockSnapshot, type VerifyReport } from '../core/verify.js';

export interface HarnessOptions {
  userCount?: number;
  /** Per-platform mock overrides applied at construction. */
  mockConfig?: Partial<Record<MockPlatform, Partial<MockConfig>>>;
  /** Keep the temp data dir after close (for debugging). */
  keepData?: boolean;
  dataDir?: string;
  /** Ports to use; 0 = ephemeral. */
  ports?: { sms: number; wecom: number; ads: number };
}

export interface Harness {
  config: AppConfig;
  warehouse: Warehouse;
  repo: AppRepo;
  adapter: HttpPlatformAdapter;
  sync: SyncService;
  mocks: Record<MockPlatform, MockPlatformServer>;
  seed: SeedResult;
  destinations: Destination[];
  tasks: SyncTask[];
  /** Resolve the current baseUrl per platform. */
  baseUrl(platform: MockPlatform): string;
  snapshot(platform: MockPlatform): Promise<MockSnapshot>;
  snapshots(): Promise<Partial<Record<MockPlatform, MockSnapshot>>>;
  verify(): Promise<VerifyReport>;
  setMockConfig(platform: MockPlatform, patch: Partial<MockConfig>): Promise<MockConfig>;
  /** Point destinations at the live mock ports (they may be ephemeral). */
  wireDestinations(): void;
  close(): Promise<void>;
}

/**
 * Boots a fully isolated stack: temp dir, warehouse + app DBs, three mock
 * platforms on ephemeral ports, and the sync service pointed at them.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'audience-sync-'));
  const config = loadConfig({
    dataDir,
    warehouseDbPath: path.join(dataDir, 'warehouse.db'),
    appDbPath: path.join(dataDir, 'app.db'),
    mockDbDir: path.join(dataDir, 'mocks'),
    startMocks: false,
    mockPorts: options.ports ?? { sms: 0, wecom: 0, ads: 0 },
  });

  // A fresh harness must never inherit mock DBs from a previous run.
  fs.rmSync(config.mockDbDir, { recursive: true, force: true });

  const seed = seedDatabase({ config, userCount: options.userCount });
  const mocks = await startMocks(config.mockDbDir, config.mockPorts, options.mockConfig ?? {});

  const appDb = openDatabase(config.appDbPath);
  initAppSchema(appDb);
  const warehouseDb = openDatabase(config.warehouseDbPath);
  initWarehouseSchema(warehouseDb);
  const repo = new AppRepo(appDb);
  const warehouse = new Warehouse(warehouseDb);
  const adapter = new HttpPlatformAdapter();
  const sync = new SyncService({ repo, warehouse, adapter });

  const harness: Harness = {
    config,
    warehouse,
    repo,
    adapter,
    sync,
    mocks,
    seed,
    destinations: repo.listDestinations(),
    tasks: repo.listTasks(),
    baseUrl(platform) {
      return `http://127.0.0.1:${mocks[platform].port}`;
    },
    wireDestinations() {
      for (const destination of repo.listDestinations()) {
        destination.baseUrl = harness.baseUrl(destination.platform);
        destination.updatedAt = new Date().toISOString();
        repo.updateDestination(destination);
      }
      harness.destinations = repo.listDestinations();
    },
    async snapshot(platform) {
      return (await harness.mocks[platform].state()) as MockSnapshot;
    },
    async snapshots() {
      const result: Partial<Record<MockPlatform, MockSnapshot>> = {};
      for (const platform of ['sms', 'wecom', 'ads'] as MockPlatform[]) {
        result[platform] = (await harness.mocks[platform].state()) as MockSnapshot;
      }
      return result;
    },
    async verify() {
      return verifyPlatforms(repo, warehouse, await harness.snapshots());
    },
    async setMockConfig(platform, patch) {
      return harness.mocks[platform].updateConfig(patch);
    },
    async close() {
      await Promise.all(Object.values(mocks).map((m) => m.stop()));
      appDb.close();
      warehouseDb.close();
      if (!options.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };

  harness.wireDestinations();

  // Seed all three platforms with the warehouse user roster so hash checks work.
  const users = seed.userIds.map((userId) => {
    const row = warehouse.db.prepare('SELECT phone FROM users WHERE user_id = ?').get(userId) as {
      phone: string;
    };
    return { userId, phone: row.phone };
  });
  await Promise.all(Object.values(mocks).map((mock) => mock.seedUsers(users)));

  return harness;
}
