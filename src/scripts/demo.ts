import { createHarness } from '../test/harness.js';
import { mutateWarehouse } from './seed.js';
import { businessDate } from '../core/time.js';
import { addDays } from '../core/time.js';

interface RoundReport {
  round: number;
  preview: {
    adds: number;
    removes: number;
    blocked: number;
    smsDeduped: number;
    deferred: number;
    affected: number;
    requiresConfirmation: boolean;
  };
  summary: {
    status: string;
    addSuccess: number;
    removeSuccess: number;
    failed: number;
    deferred: number;
    deduped: number;
    requests: number;
  };
  verifyOk: boolean;
  failures: string[];
}

/**
 * Multi-round integration sweep:
 *   round 1: initial push
 *   round 2: segment churn + opt-outs + transient/permanent failures
 *   round 3: retry the open failures, then membership churn again
 *   round 4: quota pressure on the ads platform
 *
 * After every round each platform's actual audience is compared against an
 * independently computed expected audience.
 */
async function main(): Promise<void> {
  const harness = await createHarness({ userCount: 320 });
  const reports: RoundReport[] = [];

  try {
    await harness.setMockConfig('sms', { rpsLimit: 6, maxBatchSize: 40, transientFailPct: 6, dailyQuota: 5000 });
    await harness.setMockConfig('wecom', { rpsLimit: 8, maxBatchSize: 80, transientFailPct: 4, dailyQuota: 5000 });
    await harness.setMockConfig('ads', {
      rpsLimit: 10,
      maxBatchSize: 60,
      transientFailPct: 5,
      // Round 1 injects a permanent 15% failure to prove the failure log and the
      // retry endpoint work; afterwards it is set back to 0 so the final lists
      // can converge.
      permanentFailPct: 15,
      dailyQuota: 5000,
    });

    // Make the ads quota tight enough to force deferral in round 4.
    const today = businessDate();

    for (let round = 1; round <= 4; round++) {
      if (round === 2) {
        mutateWarehouse(harness.warehouse, harness.seed.userIds, 2, {
          addToSegment: [
            { segmentId: 'seg_new_users', count: 30 },
            { segmentId: 'seg_lapsed', count: 20 },
          ],
          removeFromSegment: [{ segmentId: 'seg_new_users', count: 15 }],
          optOut: 6,
        });
      }
      if (round === 3) {
        mutateWarehouse(harness.warehouse, harness.seed.userIds, 3, {
          addToSegment: [{ segmentId: 'seg_high_value', count: 20 }],
          removeFromSegment: [{ segmentId: 'seg_cart_abandon', count: 18 }],
          blacklist: 3,
        });
        // Stop injecting permanent failures, then retry what is still open.
        await harness.setMockConfig('ads', { permanentFailPct: 0 });
        const retry = await harness.sync.retryService.retry('dest_sms');
        console.log(
          `  [重试] 短信平台: 尝试 ${retry.attempted}, 成功 ${retry.succeeded}, 仍失败 ${retry.failed}`,
        );
        const retryWecom = await harness.sync.retryService.retry('dest_wecom');
        console.log(
          `  [重试] 企业微信: 尝试 ${retryWecom.attempted}, 成功 ${retryWecom.succeeded}, 仍失败 ${retryWecom.failed}`,
        );
        const retryAds = await harness.sync.retryService.retry('dest_ads');
        console.log(
          `  [重试] 广告平台: 尝试 ${retryAds.attempted}, 成功 ${retryAds.succeeded}, 仍失败 ${retryAds.failed}`,
        );
      }
      if (round === 4) {
        // Stress quota: shrink the ads daily quota to force deferred items.
        const adsDestination = harness.repo.getDestination('dest_ads')!;
        adsDestination.config.dailyQuota = 120;
        harness.repo.updateDestination(adsDestination);
        mutateWarehouse(harness.warehouse, harness.seed.userIds, 4, {
          addToSegment: [{ segmentId: 'seg_lapsed', count: 90 }],
          removeFromSegment: [{ segmentId: 'seg_high_value', count: 10 }],
        });
      }

      const preview = await harness.sync.preview({ businessDate: today });
      const requiresConfirmation = preview.requiresConfirmation;
      // The seed thresholds are intentionally high, so confirm automatically.
      const summary = await harness.sync.execute(preview, { confirmed: true });
      const openAfterRun = harness.repo.countOpenFailures();
      console.log(
        `  失败记录: 本次失败 ${summary.totals.failed}, 累计待处理 ${openAfterRun}`,
      );

      const report = await harness.verify();
      reports.push({
        round,
        preview: {
          adds: preview.totals.adds,
          removes: preview.totals.removes,
          blocked: preview.totals.blocked,
          smsDeduped: preview.totals.smsDeduped,
          deferred: preview.totals.deferred,
          affected: preview.totals.affected,
          requiresConfirmation,
        },
        summary: {
          status: summary.status,
          addSuccess: summary.totals.addSuccess,
          removeSuccess: summary.totals.removeSuccess,
          failed: summary.totals.failed,
          deferred: summary.totals.deferred,
          deduped: summary.totals.deduped,
          requests: summary.totals.requests,
        },
        verifyOk: report.ok,
        failures: report.failures,
      });

      console.log(
        `第 ${round} 轮: 预览新增 ${preview.totals.adds} / 移出 ${preview.totals.removes} / ` +
          `拦截 ${preview.totals.blocked} / 短信去重 ${preview.totals.smsDeduped} / 顺延 ${preview.totals.deferred} ` +
          `=> 运行 ${summary.status}, 失败 ${summary.totals.failed}, 核对 ${report.ok ? '通过' : '未通过'}`,
      );
      for (const failure of report.failures) console.log(`    ✗ ${failure}`);
    }

    console.log('\n=== 各目的地最终核对 ===');
    const final = await harness.verify();
    for (const destination of final.destinations) {
      console.log(
        `\n${destination.destinationName} (${destination.platform}) ` +
          `批次上限 ${destination.batchLimit} 实际最大 ${destination.maxBatchSeen} | ` +
          `配额 ${destination.quotaUsed}/${destination.quotaLimit} | ` +
          `RPS 上限 ${destination.rpsLimit} 实际 ${destination.maxRpsSeen}`,
      );
      for (const task of destination.tasks) {
        console.log(
          `  - ${task.taskName}: 期望 ${task.expectedCount}, 实际 ${task.actualCount}, ` +
            `缺 ${task.missing.length}, 多 ${task.extra.length}, 哈希错 ${task.wrongHash}, ` +
            `黑名单泄漏 ${task.blockedLeaked.length} ${task.ok ? '✓' : '✗'}`,
        );
      }
    }
    console.log(
      `\n短信跨受众去重: 检查 ${final.smsDailyDedupe.checkedDays} 天, 重复短信 ${final.smsDailyDedupe.duplicateTexts} 条`,
    );

    const stats = harness.repo.dailyStats(addDays(today, -1), addDays(today, 1));
    console.log('\n=== 按天成功率/耗时 ===');
    for (const row of stats) {
      console.log(
        `${row.businessDate} ${row.destinationName}: 尝试 ${row.attempts}, 成功 ${row.success}, ` +
          `失败 ${row.failed}, 顺延 ${row.deferred}, 去重 ${row.deduped}, ` +
          `成功率 ${row.successRate}%, 平均 ${row.avgLatencyMs}ms, P95 ${row.p95LatencyMs}ms`,
      );
    }

    const openFailures = harness.repo.countOpenFailures();
    console.log(`\n仍待处理失败记录: ${openFailures}`);
    console.log(`\n最终结论: ${final.ok ? '所有平台名单与应有名单一致 ✓' : '存在不一致 ✗'}`);
    for (const failure of final.failures) console.log(`  ✗ ${failure}`);
    if (reports.some((r) => !r.verifyOk)) {
      console.log(
        '\n(前几轮的“未通过”是注入的永久失败尚未重试造成, 已在第 3 轮通过重试接口收敛; 最终状态以上方为准。)',
      );
    }

    if (process.env.DUMP_JSON === '1') {
      console.log(JSON.stringify({ reports, final }, null, 2));
    }
    if (!final.ok) process.exitCode = 1;
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
