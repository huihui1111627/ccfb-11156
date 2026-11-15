import { createHarness } from '../test/harness.js';

async function main(): Promise<void> {
  const harness = await createHarness({ userCount: Number(process.env.USER_COUNT ?? 200) });
  try {
    const preview = await harness.sync.preview();
    const summary = await harness.sync.execute(preview, { confirmed: true });
    const report = await harness.verify();
    console.log(`运行状态: ${summary.status}`);
    console.log(`新增成功 ${summary.totals.addSuccess}, 移出成功 ${summary.totals.removeSuccess}, ` +
      `失败 ${summary.totals.failed}, 去重 ${summary.totals.deduped}, 顺延 ${summary.totals.deferred}`);
    for (const d of report.destinations) {
      console.log(`\n${d.destinationName} (${d.platform})`);
      for (const t of d.tasks) {
        console.log(
          `  ${t.ok ? '✓' : '✗'} ${t.taskName}: 期望 ${t.expectedCount} 实际 ${t.actualCount}, ` +
            `缺 ${t.missing.length}, 多 ${t.extra.length}, 顺延 ${t.deferredMissing.length}, ` +
            `哈希错 ${t.wrongHash}, 黑名单泄漏 ${t.blockedLeaked.length}`,
        );
      }
    }
    console.log(`\n结论: ${report.ok ? '一致 ✓' : '不一致 ✗'}`);
    for (const failure of report.failures) console.log(`  ✗ ${failure}`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
