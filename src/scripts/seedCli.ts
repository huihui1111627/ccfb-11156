import { loadConfig } from '../config.js';
import { seedDatabase } from './seed.js';
import { startMocks } from '../mocks/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const userCount = Number(process.env.USER_COUNT ?? 400);
  const seeded = seedDatabase({ config, userCount });

  const mocks = await startMocks(config.mockDbDir, config.mockPorts);
  const users = seeded.userIds.map((userId) => {
    const row = seeded.warehouse.db
      .prepare('SELECT phone FROM users WHERE user_id = ?')
      .get(userId) as { phone: string };
    return { userId, phone: row.phone };
  });
  await Promise.all(Object.values(mocks).map((mock) => mock.seedUsers(users)));

  console.log(`数据仓库: ${config.warehouseDbPath}`);
  console.log(`应用库:   ${config.appDbPath}`);
  console.log(`用户数:   ${users.length}`);
  console.log(`分群:     ${seeded.warehouse.listSegments().map((s) => `${s.name}(${s.memberCount})`).join(', ')}`);
  console.log(`目的地:   ${seeded.destinations.map((d) => d.name).join(', ')}`);
  console.log(`同步任务: ${seeded.tasks.map((t) => t.name).join(', ')}`);
  console.log('三个 mock 平台已灌入同一批用户, 可用于哈希校验。');
  await Promise.all(Object.values(mocks).map((m) => m.stop()));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
