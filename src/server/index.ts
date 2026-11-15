import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from '../config.js';
import { openDatabase } from '../db/sqlite.js';
import { initAppSchema, initWarehouseSchema } from '../db/schema.js';
import { AppRepo } from '../db/appRepo.js';
import { Warehouse } from '../db/warehouse.js';
import { HttpPlatformAdapter } from '../platform/adapter.js';
import { SyncService } from '../core/syncService.js';
import { buildRouter, type ApiContext } from './routes.js';
import { startMocks, type MockPlatformServer } from '../mocks/server.js';

export interface ServerHandle {
  server: http.Server;
  url: string;
  ctx: ApiContext;
  mocks: Record<string, MockPlatformServer> | null;
  close(): Promise<void>;
}

export async function createServer(options: { config?: AppConfig; mocks?: boolean } = {}): Promise<ServerHandle> {
  const config = options.config ?? loadConfig();
  const appDb = openDatabase(config.appDbPath);
  initAppSchema(appDb);
  const warehouseDb = openDatabase(config.warehouseDbPath);
  initWarehouseSchema(warehouseDb);
  const repo = new AppRepo(appDb);
  const warehouse = new Warehouse(warehouseDb);
  const adapter = new HttpPlatformAdapter();
  const sync = new SyncService({ repo, warehouse, adapter });

  let mocks: Record<string, MockPlatformServer> | null = null;
  if (options.mocks ?? config.startMocks) {
    mocks = await startMocks(config.mockDbDir, config.mockPorts);
    // Keep destination base URLs aligned with the ports actually bound.
    for (const destination of repo.listDestinations()) {
      const server = mocks[destination.platform as keyof typeof mocks];
      if (!server) continue;
      destination.baseUrl = `http://127.0.0.1:${server.port}`;
      repo.updateDestination(destination);
    }
    // Seed the mock platforms with the warehouse roster so hash checks work.
    const users = warehouse.db
      .prepare('SELECT user_id AS userId, phone FROM users')
      .all() as Array<{ userId: string; phone: string }>;
    if (users.length) {
      await Promise.all(Object.values(mocks).map((mock) => mock.seedUsers(users)));
    }
  }

  const ctx: ApiContext = { config, repo, warehouse, adapter, sync, appDb };
  const router = buildRouter(ctx);
  const staticDir = path.resolve(process.cwd(), 'public');
  if (fs.existsSync(staticDir)) router.staticFiles(staticDir);

  const server = http.createServer((req, res) => {
    router.handle(req, res).catch((error: Error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error', message: error.message }));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host}:${port}`;

  return {
    server,
    url,
    ctx,
    mocks,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (mocks) await Promise.all(Object.values(mocks).map((m) => m.stop()));
      appDb.close();
      warehouseDb.close();
    },
  };
}

// Entry point when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer()
    .then((handle) => {
      console.log(`分群同步控制台: ${handle.url}`);
      console.log(`数据目录: ${handle.ctx.config.dataDir}`);
      const shutdown = async () => {
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error('启动失败:', error);
      process.exit(1);
    });
}
