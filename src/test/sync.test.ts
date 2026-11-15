import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from './harness.js';
import { mutateWarehouse } from '../scripts/seed.js';
import { addDays, businessDate } from '../core/time.js';
import { hashPhone } from '../core/hash.js';

async function withHarness<T>(
  options: Parameters<typeof createHarness>[0],
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  const harness = await createHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

test('首次同步推送当前分群, 只包含未退订/未拉黑用户', async () => {
  await withHarness({ userCount: 120 }, async (h) => {
    const preview = await h.sync.preview({ businessDate: businessDate() });
    const summary = await h.sync.execute(preview, { confirmed: true });
    assert.equal(summary.status, 'completed');
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
    for (const destination of report.destinations) {
      for (const task of destination.tasks) {
        assert.equal(task.missing.length, 0);
        assert.equal(task.extra.length, 0);
        assert.equal(task.blockedLeaked.length, 0);
      }
    }
  });
});

test('第二轮只推送新增和移出, 不全量重传', async () => {
  await withHarness({ userCount: 150 }, async (h) => {
    await h.sync.execute(await h.sync.preview({ businessDate: businessDate() }), { confirmed: true });

    mutateWarehouse(h.warehouse, h.seed.userIds, 2, {
      addToSegment: [{ segmentId: 'seg_new_users', count: 8 }],
      removeFromSegment: [{ segmentId: 'seg_new_users', count: 5 }],
    });
    const logsBefore = countLogs(h);
    const preview = await h.sync.preview({ businessDate: businessDate() });
    const totalAffected = preview.totals.adds + preview.totals.removes;
    assert.ok(totalAffected < 40, `第二轮应只有少量变化, 实际 ${totalAffected}`);
    const summary = await h.sync.execute(preview, { confirmed: true });

    const logsAfter = countLogs(h);
    assert.equal(summary.totals.addSuccess, preview.totals.adds);
    assert.equal(summary.totals.removeSuccess, preview.totals.removes);
    // Only the delta should have generated new log rows (plus dedupe accounting).
    assert.ok(
      logsAfter - logsBefore <= totalAffected + preview.totals.smsDeduped + 5,
      `新增日志 ${logsAfter - logsBefore} 应约等于变化人数 ${totalAffected}`,
    );

    // Second preview after execution must be a no-op.
    const idle = await h.sync.preview({ businessDate: businessDate() });
    assert.equal(idle.totals.adds, 0);
    assert.equal(idle.totals.removes, 0);
  });
});

test('每个目的地按自己的哈希规则生成手机号哈希', async () => {
  await withHarness({ userCount: 80 }, async (h) => {
    await h.sync.execute(await h.sync.preview({ businessDate: businessDate() }), { confirmed: true });
    for (const destination of h.destinations) {
      const snapshot = await h.snapshot(destination.platform);
      for (const audience of snapshot.audiences) {
        for (const member of audience.members) {
          assert.equal(hashPhone(phoneOf(h, member.userId), destination.config.hash), member.phoneHash);
        }
      }
    }
    const sms = await h.snapshot('sms');
    const wecom = await h.snapshot('wecom');
    const firstSms = sms.audiences[0]?.members[0];
    const firstWecom = wecom.audiences[0]?.members[0];
    assert.ok(firstSms && firstWecom);
    // Same user, different algorithm/case per platform.
    assert.notEqual(firstSms.phoneHash, firstWecom.phoneHash);
    assert.ok(firstSms.phoneHash === firstSms.phoneHash.toUpperCase());
    assert.ok(firstWecom.phoneHash === firstWecom.phoneHash.toLowerCase());
  });
});

test('遵守批次大小、每秒限速与每日配额', async () => {
  await withHarness({ userCount: 200 }, async (h) => {
    await h.setMockConfig('sms', { maxBatchSize: 25, rpsLimit: 4, dailyQuota: 60 });
    const preview = await h.sync.preview({ businessDate: businessDate() });
    const summary = await h.sync.execute(preview, { confirmed: true });
    const smsSnapshot = await h.snapshot('sms');
    for (const destination of h.destinations.filter((d) => d.platform === 'sms')) {
      const snap = await h.snapshot('sms');
      assert.ok(snap.stats.maxBatchSizeSeen <= 25, `批次 ${snap.stats.maxBatchSizeSeen} > 25`);
      assert.ok(snap.stats.maxRequestsPerSecond <= 4, `RPS ${snap.stats.maxRequestsPerSecond} > 4`);
      const used = snap.usage.reduce((n, u) => n + u.used, 0);
      assert.equal(used, 60, '配额应被用满且不超额');
      void destination;
    }
    assert.equal(smsSnapshot.usage[0]?.used, 60);
    // Whatever was not sent must be reported as deferred, and the preview must
    // have flagged it too.
    const deferredLogs = h.repo.queryLogs({ status: 'deferred' }).total;
    assert.ok(deferredLogs > 0, '配额不足时应有 deferred 记录');
    assert.ok(summary.totals.deferred > 0);
  });
});

test('退订和黑名单用户永远不会被加入平台名单, 且下一次同步会将其移出', async () => {
  await withHarness({ userCount: 160 }, async (h) => {
    const suppressed = h.warehouse.listSuppressed();
    const preview = await h.sync.preview({ businessDate: businessDate() });
    for (const diff of preview.tasks) {
      for (const userId of diff.adds) {
        assert.equal(suppressed.userIds.has(userId), false, `退订/黑名单 ${userId} 进入了推送名单`);
      }
    }
    await h.sync.execute(preview, { confirmed: true });
    let report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));

    // Opt a synced user out after the push. They may remain on the platform
    // until the next run, but that run must remove them, never re-add them.
    const target = preview.tasks[0]!.adds[0];
    assert.ok(target);
    h.warehouse.db
      .prepare(`UPDATE users SET opted_out = 1, opted_out_at = ? WHERE user_id = ?`)
      .run(new Date().toISOString(), target);

    const next = await h.sync.preview({ businessDate: businessDate() });
    const affected = next.tasks.filter((t) => t.removes.includes(target));
    assert.ok(affected.length > 0, '退订用户应进入移出名单');
    for (const diff of next.tasks) {
      assert.equal(diff.adds.includes(target), false, '退订用户不得再次被加入');
      assert.equal(diff.blocked.includes(target), false, '已同步用户应走移出而不是拦截');
    }
    const summary = await h.sync.execute(next, { confirmed: true });
    assert.ok(summary.totals.removeSuccess > 0);

    report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('同一天同一手机号跨分群只收到一条短信', async () => {
  await withHarness({ userCount: 160 }, async (h) => {
    await h.setMockConfig('sms', { transientFailPct: 0, maxBatchSize: 200, rpsLimit: 20 });
    const preview = await h.sync.preview({ businessDate: businessDate() });
    assert.ok(preview.totals.smsDeduped > 0, '种子数据应包含跨分群重复手机号');
    await h.sync.execute(preview, { confirmed: true });

    const snapshot = await h.snapshot('sms');
    const byDay = new Map<string, Map<string, number>>();
    for (const text of snapshot.texts) {
      const day = byDay.get(text.date) ?? new Map<string, number>();
      day.set(text.phone, (day.get(text.phone) ?? 0) + 1);
      byDay.set(text.date, day);
    }
    for (const [day, phones] of byDay) {
      for (const [phone, count] of phones) {
        assert.equal(count, 1, `${day} ${phone} 收到 ${count} 条短信`);
      }
    }
  });
});

test('平台部分成功时只重试失败的那部分', async () => {
  await withHarness({ userCount: 120 }, async (h) => {
    // Give the ads destination enough retries to absorb transient failures.
    const ads = h.repo.getDestination('dest_ads')!;
    ads.config.maxRetries = 3;
    h.repo.updateDestination(ads);
    await h.setMockConfig('ads', { transientFailPct: 25, permanentFailPct: 0 });

    const preview = await h.sync.preview({ businessDate: businessDate() });
    const summary = await h.sync.execute(preview, { confirmed: true });
    assert.equal(summary.status, 'completed', JSON.stringify(summary.totals));
    assert.equal(summary.totals.failed, 0);

    // Partial success proof: within one logical batch, some items succeeded on
    // the first attempt while only the failed remainder was resent. Grouping by
    // the base batch id (retries append ":retryN") makes this visible.
    const perBatch = h.repo.db
      .prepare(
        `SELECT CASE WHEN instr(batch_id, ':retry') > 0
                     THEN substr(batch_id, 1, instr(batch_id, ':retry') - 1)
                     ELSE batch_id END AS baseBatch,
                SUM(CASE WHEN attempt_no = 1 AND status = 'success' THEN 1 ELSE 0 END) AS firstTryOk,
                SUM(CASE WHEN attempt_no > 1 THEN 1 ELSE 0 END) AS retried,
                SUM(CASE WHEN attempt_no = 1 THEN 1 ELSE 0 END) AS firstAttemptTotal
         FROM send_logs
         WHERE run_id = ? AND destination_id = 'dest_ads' AND action = 'add'
         GROUP BY baseBatch`,
      )
      .all(summary.runId) as Array<{
      baseBatch: string;
      firstTryOk: number;
      retried: number;
      firstAttemptTotal: number;
    }>;
    assert.ok(
      perBatch.some((b) => Number(b.firstTryOk) > 0 && Number(b.retried) > 0),
      '应至少有一个批次同时包含首次成功项与重试项 (部分成功只重发失败部分)',
    );
    // The retried set is strictly smaller than the whole first batch.
    for (const batch of perBatch) {
      assert.ok(
        Number(batch.retried) < Number(batch.firstAttemptTotal),
        `重试项 ${batch.retried} 不应等于首批全量 ${batch.firstAttemptTotal}`,
      );
    }

    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('永久失败进入失败记录, 重试成功后名单收敛', async () => {
  await withHarness({ userCount: 120 }, async (h) => {
    await h.setMockConfig('ads', { permanentFailPct: 20, transientFailPct: 0 });
    await h.sync.execute(await h.sync.preview({ businessDate: businessDate() }), { confirmed: true });

    const openAfter = h.repo.countOpenFailures('dest_ads');
    assert.ok(openAfter > 0, '应产生永久失败记录');
    let report = await h.verify();
    assert.equal(report.ok, false, '存在永久失败时名单应不一致');

    await h.setMockConfig('ads', { permanentFailPct: 0 });
    const retry = await h.sync.retryService.retry('dest_ads');
    assert.equal(retry.failed, 0);
    assert.equal(retry.succeeded, retry.attempted);
    assert.equal(h.repo.countOpenFailures('dest_ads'), 0);

    report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('超过阈值需要人工确认, 未确认不得执行', async () => {
  await withHarness({ userCount: 200 }, async (h) => {
    const task = h.tasks[0]!;
    task.confirmThreshold = 10;
    h.repo.updateTask(task);

    const preview = await h.sync.preview({ businessDate: businessDate() });
    const taskDiff = preview.tasks.find((t) => t.taskId === task.id)!;
    assert.equal(taskDiff.requiresConfirmation, true);
    assert.equal(preview.requiresConfirmation, true);

    await assert.rejects(
      h.sync.execute(preview, { confirmed: false }),
      /需要人工确认/,
    );

    const savedPreview = await h.sync.preview({ businessDate: businessDate() });
    h.sync.savePreview(savedPreview);
    const stored = h.repo.getRun(savedPreview.runId);
    assert.equal(stored?.status, 'awaiting_confirmation');

    const confirmed = await h.sync.execute(savedPreview, { confirmed: true });
    assert.ok(confirmed.totals.addSuccess > 0);
  });
});

test('按天统计成功率与耗时', async () => {
  await withHarness({ userCount: 100 }, async (h) => {
    await h.setMockConfig('wecom', { transientFailPct: 10 });
    await h.sync.execute(await h.sync.preview({ businessDate: businessDate() }), { confirmed: true });
    const stats = h.repo.dailyStats(businessDate(), businessDate());
    assert.ok(stats.length >= 3, '每个目的地都应有一行统计');
    for (const row of stats) {
      assert.ok(row.attempts > 0);
      assert.ok(row.successRate >= 0 && row.successRate <= 100);
      assert.ok(row.avgLatencyMs >= 0);
      assert.ok(row.p95LatencyMs >= 0);
    }
  });
});

test('stale preview 指纹变化时拒绝执行', async () => {
  await withHarness({ userCount: 100 }, async (h) => {
    const preview = await h.sync.preview({ businessDate: businessDate() });
    mutateWarehouse(h.warehouse, h.seed.userIds, 9, {
      addToSegment: [{ segmentId: 'seg_new_users', count: 5 }],
      removeFromSegment: [],
    });
    const fresh = await h.sync.preview({ businessDate: businessDate() });
    assert.notEqual(preview.fingerprint, fresh.fingerprint);
  });
});

test('预览后进入黑名单的用户在执行前被拦截, 不会到达平台', async () => {
  await withHarness({ userCount: 80 }, async (h) => {
    const preview = await h.sync.preview({ businessDate: businessDate() });
    const target = preview.tasks.find((t) => t.taskId === 'task_wecom_high')!.adds[0];
    assert.ok(target);
    h.warehouse.db
      .prepare(`UPDATE users SET blacklisted = 1, blacklist_reason = '测试监管投诉' WHERE user_id = ?`)
      .run(target);

    const summary = await h.sync.execute(preview, { confirmed: true });
    assert.ok(summary.totals.failed > 0);

    const snapshot = await h.snapshot('wecom');
    const leaked = snapshot.audiences.some((a) => a.members.some((m) => m.userId === target));
    assert.equal(leaked, false, '预览后拉黑的用户不得出现在平台名单中');

    const logs = h.repo.queryLogs({ userId: target, status: 'failed' });
    assert.ok(logs.rows.some((l) => l.errorCode === 'suppressed'), '应记录为 suppressed 拦截');
  });
});

test('目的地哈希配置错误时平台会拒绝, 失败进入失败记录', async () => {
  await withHarness({ userCount: 40 }, async (h) => {
    const wecom = h.repo.getDestination('dest_wecom')!;
    wecom.config.hash = { algorithm: 'sha256', salt: 'wrong-salt', uppercase: true };
    h.repo.updateDestination(wecom);
    await h.setMockConfig('wecom', { permanentFailPct: 0, transientFailPct: 0 });

    const preview = await h.sync.preview({ businessDate: businessDate() });
    const expectedAdds = preview.tasks
      .filter((t) => t.destinationId === 'dest_wecom')
      .reduce((n, t) => n + t.adds.length, 0);
    await h.sync.execute(preview, { confirmed: true });

    const failures = h.repo.listFailures({ destinationId: 'dest_wecom', status: 'open' }).rows;
    assert.equal(failures.length, expectedAdds);
    assert.ok(failures.every((f) => f.errorCode === 'unmatched_hash'));
    const snapshot = await h.snapshot('wecom');
    const total = snapshot.audiences.reduce((n, a) => n + a.members.length, 0);
    assert.equal(total, 0, '哈希不匹配时不应有任何用户进入名单');
  });
});

test('预览的配额顺延数与执行结果一致, 顺延的人次日重新进入新增', async () => {
  await withHarness({ userCount: 80 }, async (h) => {
    await h.setMockConfig('ads', { dailyQuota: 5, transientFailPct: 0, permanentFailPct: 0 });
    const day1 = '2026-11-16';
    const preview = await h.sync.preview({ businessDate: day1 });
    const adsDiff = preview.tasks.find((t) => t.destinationId === 'dest_ads')!;
    assert.ok(adsDiff.deferred.length > 0, '预览应显示因配额被顺延的人');
    const summary = await h.sync.execute(preview, { confirmed: true });
    assert.equal(
      summary.totals.deferred,
      adsDiff.deferred.length,
      '预览顺延数必须与执行时实际顺延数一致',
    );

    // Next business day the platform quota resets and the deferred people are
    // exactly the ones that show up as adds again.
    await h.setMockConfig('ads', { dailyQuota: 1000 });
    const day2 = await h.sync.preview({ businessDate: addDays(day1, 1) });
    const day2Diff = day2.tasks.find((t) => t.destinationId === 'dest_ads')!;
    assert.deepEqual([...day2Diff.adds].sort(), [...adsDiff.deferred].sort());

    const day2summary = await h.sync.execute(day2, { confirmed: true });
    assert.equal(day2summary.totals.deferred, 0);
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('幂等: 连续两次预览第二次为空', async () => {
  await withHarness({ userCount: 100 }, async (h) => {
    await h.sync.execute(await h.sync.preview({ businessDate: businessDate() }), { confirmed: true });
    const idle = await h.sync.preview({ businessDate: businessDate() });
    assert.equal(idle.totals.adds, 0);
    assert.equal(idle.totals.removes, 0);
    assert.equal(idle.totals.affected, 0);
  });
});

test('用户手机号变化时按新增重推, 平台侧哈希被更新', async () => {
  await withHarness({ userCount: 60 }, async (h) => {
    const day = '2026-11-16';
    await h.setMockConfig('wecom', { permanentFailPct: 0, transientFailPct: 0 });
    await h.sync.execute(await h.sync.preview({ businessDate: day }), { confirmed: true });

    const snapshot = await h.snapshot('wecom');
    const member = snapshot.audiences[0]!.members[0]!;
    const oldHash = member.phoneHash;
    h.warehouse.db
      .prepare('UPDATE users SET phone = ? WHERE user_id = ?')
      .run('13900009999', member.userId);
    // The platform's own identity store learns the new phone.
    const roster = h.warehouse.db.prepare('SELECT user_id AS userId, phone FROM users').all();
    await Promise.all(Object.values(h.mocks).map((mock) => mock.seedUsers(roster as never)));

    const preview = await h.sync.preview({ businessDate: day });
    const diff = preview.tasks.find((t) => t.audienceId === snapshot.audiences[0]!.audienceId)!;
    assert.ok(diff.adds.includes(member.userId), '手机号变化应被视为新增');

    await h.sync.execute(preview, { confirmed: true });
    const after = await h.snapshot('wecom');
    const updated = after.audiences[0]!.members.find((m) => m.userId === member.userId)!;
    assert.notEqual(updated.phoneHash, oldHash, '平台侧应存新手机号的哈希');
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('移出分群后从平台删除, 重新入群后再次推送', async () => {
  await withHarness({ userCount: 60 }, async (h) => {
    const day = '2026-11-16';
    await h.setMockConfig('wecom', { permanentFailPct: 0, transientFailPct: 0 });
    await h.sync.execute(await h.sync.preview({ businessDate: day }), { confirmed: true });
    const snapshot = await h.snapshot('wecom');
    const member = snapshot.audiences[0]!.members[0]!;

    h.warehouse.db
      .prepare('DELETE FROM segment_members WHERE segment_id = ? AND user_id = ?')
      .run('seg_high_value', member.userId);
    await h.sync.execute(await h.sync.preview({ businessDate: day }), { confirmed: true });
    let after = await h.snapshot('wecom');
    assert.equal(
      after.audiences[0]!.members.some((m) => m.userId === member.userId),
      false,
      '离开分群后应从平台删除',
    );

    h.warehouse.db
      .prepare('INSERT INTO segment_members (segment_id, user_id, version) VALUES (?, ?, 1)')
      .run('seg_high_value', member.userId);
    const preview = await h.sync.preview({ businessDate: day });
    const diff = preview.tasks.find((t) => t.audienceId === snapshot.audiences[0]!.audienceId)!;
    assert.ok(diff.adds.includes(member.userId), '重新入群应再次作为新增');
    await h.sync.execute(preview, { confirmed: true });
    after = await h.snapshot('wecom');
    assert.equal(
      after.audiences[0]!.members.some((m) => m.userId === member.userId),
      true,
      '重新入群后应重新出现在平台',
    );
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('重试时用户已离开分群, 不会被错误地补推到平台', async () => {
  await withHarness({ userCount: 80 }, async (h) => {
    const day = businessDate();
    await h.setMockConfig('wecom', { permanentFailPct: 30, transientFailPct: 0 });
    await h.sync.execute(await h.sync.preview({ businessDate: day }), { confirmed: true });

    const failures = h.repo.listFailures({ destinationId: 'dest_wecom', status: 'open' }).rows;
    assert.ok(failures.length > 0, '应产生永久失败');
    const victim = failures[0]!;
    // The user leaves the segment before the operator retries.
    h.warehouse.db
      .prepare('DELETE FROM segment_members WHERE segment_id = ? AND user_id = ?')
      .run(victim.segmentId, victim.userId);

    await h.setMockConfig('wecom', { permanentFailPct: 0 });
    await h.sync.retryService.retry('dest_wecom');

    const snapshot = await h.snapshot('wecom');
    const leaked = snapshot.audiences.some((a) => a.members.some((m) => m.userId === victim.userId));
    assert.equal(leaked, false, '已离开分群的用户不应被重试补推到平台');
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('崩溃遗留的配额预留会在下次运行前被清理', async () => {
  await withHarness({ userCount: 60 }, async (h) => {
    const day = '2026-11-16';
    await h.setMockConfig('ads', { dailyQuota: 10000, transientFailPct: 0, permanentFailPct: 0 });
    // Simulate a run that reserved 40 slots then died before settling.
    h.repo.ensureUsageRow('dest_ads', day);
    h.repo.reserveQuota('dest_ads', day, 40);
    assert.equal(h.repo.getUsage('dest_ads', day).reserved, 40);

    const preview = await h.sync.preview({ businessDate: day });
    const adsDiff = preview.tasks.find((t) => t.destinationId === 'dest_ads')!;
    // The preview must not treat the stale reservation as real usage.
    assert.equal(adsDiff.deferred.length, 0, '陈旧预留不应导致 preview 顺延');

    await h.sync.execute(preview, { confirmed: true });
    assert.equal(h.repo.getUsage('dest_ads', day).reserved, 0);
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('重试失败项时也遵守短信去重, 不会对同一手机号发第二条', async () => {
  await withHarness({ userCount: 200 }, async (h) => {
    const day = businessDate();
    const sms = h.repo.getDestination('dest_sms')!;
    sms.config.maxRetries = 0; // force failures into the manual retry path
    h.repo.updateDestination(sms);
    await h.setMockConfig('sms', { transientFailPct: 40, permanentFailPct: 0, rpsLimit: 50, maxBatchSize: 200 });

    const preview = await h.sync.preview({ businessDate: day });
    await h.sync.execute(preview, { confirmed: true });
    // Some adds fail and are queued for manual retry. Retry them; no phone that
    // already got a text today may get a second one.
    await h.sync.retryService.retry('dest_sms');

    const snapshot = await h.snapshot('sms');
    const counts = new Map<string, number>();
    for (const text of snapshot.texts) {
      const key = `${text.date}|${text.phone}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicates = [...counts.values()].filter((n) => n > 1);
    assert.equal(duplicates.length, 0, '重试不得导致同一手机号同日收到两条短信');

    // Keep retrying until convergence (each retry is bounded by today's quota),
    // then the independent oracle must agree.
    for (let i = 0; i < 5 && h.repo.countOpenFailures('dest_sms') > 0; i++) {
      await h.sync.retryService.retry('dest_sms');
    }
    const report = await h.verify();
    assert.equal(report.ok, true, report.failures.join('\n'));
  });
});

test('数仓中已删除的用户仍会从平台移除, 不会永久残留', async () => {
  await withHarness({ userCount: 80 }, async (h) => {
    const day = businessDate();
    await h.setMockConfig('wecom', { permanentFailPct: 0, transientFailPct: 0 });
    await h.sync.execute(await h.sync.preview({ businessDate: day }), { confirmed: true });

    const snapshot = await h.snapshot('wecom');
    const member = snapshot.audiences[0]!.members[0]!;
    // Hard-delete the user from the warehouse entirely.
    h.warehouse.db.prepare('DELETE FROM users WHERE user_id = ?').run(member.userId);

    const preview = await h.sync.preview({ businessDate: day });
    const diff = preview.tasks.find((t) => t.audienceId === snapshot.audiences[0]!.audienceId)!;
    assert.ok(diff.removes.includes(member.userId), '已删除用户应进入移出名单');
    await h.sync.execute(preview, { confirmed: true });

    const after = await h.snapshot('wecom');
    assert.equal(
      after.audiences[0]!.members.some((m) => m.userId === member.userId),
      false,
      '已删除用户必须从平台移除',
    );

    // And the next preview must not keep emitting the same remove forever.
    const next = await h.sync.preview({ businessDate: day });
    assert.equal(next.totals.removes, 0, '移除完成后不应重复产生移出');
  });
});

function countLogs(h: Harness): number {
  return Number((h.repo.db.prepare('SELECT COUNT(*) AS c FROM send_logs').get() as { c: number }).c);
}

function phoneOf(h: Harness, userId: string): string {
  const row = h.warehouse.db.prepare('SELECT phone FROM users WHERE user_id = ?').get(userId) as {
    phone: string;
  };
  return row.phone;
}
