# 分群同步 (audience-sync)

把数仓里算好的人群自动推到短信平台 / 企业微信 / 广告投放平台, 替代“导 Excel 再手动上传”。
带一个本地控制台页面: 目的地连接、同步任务、人群差异预览、发送日志、失败记录、统计与名单核对。

- 数仓用本地 **SQLite** 装一份假的用户表和分群结果 (`data/warehouse.db`)
- 三个外部平台是 **mock 服务**, 可注入限速、批量上限、每日配额和部分失败
- 全部用 TypeScript + Node 内置 `node:sqlite` / `fetch`, 运行时不依赖任何第三方包

## 快速开始

```bash
npm install          # 只装 TypeScript 与 @types/node (dev)
npm run seed         # 生成 data/warehouse.db 和 data/app.db, 并把用户灌进 mock 平台
npm start            # 启动控制台 + 三个 mock 平台  → http://127.0.0.1:4100
```

`npm start` 会自动: 打开两个 SQLite 库 → 起 3 个 mock 平台 (4101/4102/4103) →
把目的地地址对齐到实际端口 → 把数仓用户灌进 mock 平台用户库 (用于哈希校验) → 提供页面与 API。

其他命令:

```bash
npm test             # 14 个集成测试, 每个用例起一套独立的临时库 + mock 平台
npm run demo         # 4 轮分群变化全流程, 每轮核对三个平台名单
npm run verify       # 同步一次后输出逐任务核对结果
npm run typecheck    # 只做类型检查
```

环境变量: `DATA_DIR` (默认 `./data`)、`PORT` (4100)、`SMS_MOCK_PORT` / `WECOM_MOCK_PORT` / `ADS_MOCK_PORT`、`START_MOCKS=0` 可关闭内置 mock 改为连真实平台。

## 需求如何落地

| # | 需求 | 实现位置 | 做法 |
|---|------|----------|------|
| 1 | 只推新增和移出, 不全量重传 | `core/preview.ts` + `task_members` 表 | 每个任务记录“上次成功同步的用户+手机号哈希”, 预览时和当前分群做差集; 手机号变了也算一次新增 |
| 2 | 不同平台用不同哈希 | `core/hash.ts` + 目的地 `config.hash` | 短信 SHA-256+盐+大写、企微 MD5 无盐、广告 SHA-256+另一盐; 发送前按目的地现算, 库里和日志里只存哈希 |
| 3 | 限速 / 批量 / 每日配额 | `core/rateLimiter.ts`、`core/syncEngine.ts` | 每个目的地共享一个令牌间隔限速器; 批次 = `min(配置批量, 500)`, 平台返回 413 时自动二分重发; 配额先查平台剩余再预留, 超出的记为 `deferred` 顺延次日 |
| 4 | 退订 / 拉黑最高优先级 | `core/preview.ts`、`core/syncEngine.ts` | 预览阶段就不进 `adds`; 执行前再查一次库, 预览后新退订的人被 `suppressed` 拦截并留日志; 已在平台上的退订用户一定进入移出名单 |
| 5 | 部分成功只重试失败部分 | `core/syncEngine.ts` `retryFailedItems` | 逐条读平台返回的 `results`, 成功项立即落库, 只把失败项组成新批次重发 (最多 N 次) |
| 6 | 同一人同一天多分群只发一条短信 | `core/syncEngine.ts` + `sms_daily_send` 表 | 全局手机号账本 + 本批 `plannedPhones`; 复用的用户仍会进平台名单, 只是 `sendSms=false`, 日志标 `deduped` |
| 7 | 预览影响人数, 超阈值需确认 | `core/preview.ts` + `POST /api/runs` | 每个任务可配 `confirmThreshold`, 超了整次运行 `requiresConfirmation=true`, 未带 `confirmed` 时 API 返回 202 且不执行 |
| 8 | 按天统计成功率与耗时 | `db/appRepo.ts` `dailyStats` | 从 `send_logs` 聚合每天每目的地的成功/失败/顺延/去重/拦截、成功率、平均与 P95 耗时; **成功率分母只算真正发到平台的项**, 顺延/去重/拦截单独计数, 不拉低成功率 |

补充的安全性与正确性设计:

- **预览指纹**: 预览时对“新增/移出/去重/顺延”集合做哈希; 确认执行时若数据已变化, API 返回 `409 stale_preview`, 防止拿旧预览误操作。
- **配额与平台对齐**: 本地配额与平台 `/v1/usage` 取较小值, 避免平台侧已用额度未知导致超额。
- **哈希即校验**: mock 平台会用自己的盐重算哈希并比对, 配置错了就是 `unmatched_hash` 失败, 不会静默写错名单。
- **幂等运行记录**: 预览可先存为 `awaiting_confirmation`, 之后确认执行不会重复插入。
- **崩溃自愈**: 每日配额预留 (`reserved_adds`) 在每次运行开始时按成功日志重算并清零, 进程中途崩溃不会永久占用当日额度。
- **重试前复核**: 重试失败项前会重新检查用户是否仍在分群、是否退订/拉黑、是否已不在数仓; 已离开分群的人不会因为“重试”被错误补推到平台。重试同样遵守当日配额与短信去重账本。
- **平台回执驱动记账**: 平台在逐条结果里返回 `billed`/`texted`, 本地配额与短信账本只按平台真正计费/真正发出的条数记, 幂等重加不会虚增用量。
- **严格的限速**: 客户端用滑动窗口限速, 任意 1 秒内不超过 N 个请求; 核对脚本把任何一次 429 视为限速失败。
- **不信任客户端预览**: `POST /api/runs` 收到预览时会用同样的任务/业务日在服务端重算并比对指纹, 实际执行的是服务端结果; 已执行过的预览不能重放。

## 目录结构

```
src/
  core/
    preview.ts       增量 diff、阈值、配额与短信去重预测
    syncEngine.ts    分批发送、限速、配额结算、逐条重试、打日志
    retryService.ts  按目的地重试失败项 (不重发成功项)
    syncService.ts   预览 → 确认 → 执行的门面
    verify.ts        独立核对: 数仓应有名单 vs 平台实际名单
    hash.ts phone.ts rateLimiter.ts time.ts
  db/                SQLite 封装、表结构、数仓读取、应用库仓储
  platform/adapter.ts  HTTP 适配器 (真实平台与 mock 同一套接口)
  mocks/server.ts    三个 mock 平台: 限速/批量/配额/部分失败注入 + 状态查询
  server/            HTTP 路由、静态文件、启动入口
  scripts/           seed / demo / verify 命令行
  test/              harness + 集成测试
public/              控制台页面 (原生 JS, 无构建步骤)
```

## 关键数据表

数仓 (`warehouse.db`): `users` (含 `opted_out` / `blacklisted`)、`segments`、`segment_members`

应用库 (`app.db`):
- `destinations` / `tasks`: 连接与任务配置 (哈希、批量、限速、配额、阈值)
- `task_members`: 每个任务已成功同步的用户与哈希 —— 增量同步的依据
- `runs`: 一次预览/执行 (含指纹与汇总)
- `send_logs`: 逐条发送日志 (成功/失败/顺延/去重)
- `failures`: 待处理失败, 支持按目的地重试
- `daily_usage`: 每目的地每日配额预留与实际用量
- `sms_daily_send`: 每业务日每手机号是否已发过短信的账本
- `audit_log`: 配置变更、确认、重试等操作留痕

## mock 平台

每个 mock 是一个独立 HTTP 服务 + 独立 SQLite 文件, 接口:

- `POST /v1/audience/:audienceId/members` — `{action, businessDate, batchId, contacts:[{userId, phoneHash?, sendSms?}]}`, 返回逐条 `results` 与 `quota`
- `GET /v1/usage?date=` — 当日配额
- `GET /health`, `GET /mock/state`, `PATCH /mock/config`, `POST /mock/reset`, `POST /mock/seed`

可注入: `rpsLimit` (每秒请求)、`maxBatchSize` (超出返回 413)、`dailyQuota`、`latencyMs`、`transientFailPct` (可重试失败)、`permanentFailPct` (永远失败)、`failNextRequests` (接下来 N 个请求 503)。

控制台每个目的地卡片上的 **Mock 配置** 按钮可以直接改这些值, 不用重启。

## 核对方式

`GET /api/verify` / `npm run verify` / `npm run demo` 的核对逻辑在 `core/verify.ts`, 刻意**不读** `task_members`:

1. 应有名单 = 当前分群成员 − (`opted_out=1` 或 `blacklisted=1`) 用户
2. 实际名单 = 直接问 mock 平台要 (`/mock/state`)
3. 比对缺少 / 多出 / 黑名单泄漏 / 哈希是否等于目的地规则重算值 / 同一受众内手机号重复
4. 额外检查平台侧观测到的最大批次、最大 RPS、配额是否越界, 以及短信同一手机号同日是否重复
5. 引擎明确记为 `deferred` 的配额顺延不算“缺少”, 但会在核对结果里单独列出

`npm run demo` 跑 4 轮: 初次全量 → 分群增删+退订+注入失败 → 关掉永久失败并走重试 → 压低广告配额制造顺延;
每轮结束都执行一次核对, 最后打印三个平台的最终名单对比。

## 已知取舍

- 数仓与平台之间是“最终一致”: 平台返回成功但本地落库前进程崩溃, 下一次会按 `task_members` 重推该批; mock 对已存在成员是幂等的 (返回成功)。
- 短信去重以“业务日 + 手机号”为粒度, 账本写在本地; 如果线上有多个同步实例, 该表需要换成共享存储。
- 控制台没有登录与权限, 适合内网/本地使用; 对外暴露前需加鉴权。
