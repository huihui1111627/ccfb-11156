const state = {
  view: 'overview',
  destinations: [],
  tasks: [],
  segments: [],
  preview: null,
  runs: [],
  businessDate: '',
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = () => $('#view');
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 3600);
}

function chip(text, kind = 'gray') {
  return `<span class="chip ${kind}">${esc(text)}</span>`;
}

function platformChip(platform) {
  const map = { sms: ['短信', 'blue'], wecom: ['企微', 'green'], ads: ['广告', 'amber'] };
  const [label, kind] = map[platform] ?? [platform, 'gray'];
  return chip(label, kind);
}

function statusChip(status) {
  const map = {
    success: ['成功', 'green'],
    failed: ['失败', 'red'],
    deferred: ['顺延', 'amber'],
    open: ['待处理', 'red'],
    resolved: ['已解决', 'green'],
    completed: ['完成', 'green'],
    partial: ['部分失败', 'amber'],
    running: ['运行中', 'blue'],
    previewed: ['已预览', 'gray'],
    awaiting_confirmation: ['待确认', 'amber'],
    failed_run: ['失败', 'red'],
  };
  const [label, kind] = map[status] ?? [status, 'gray'];
  return chip(label, kind);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return esc(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function confirmDialog({ title, body, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    const footer = $('#modalFooter');
    footer.innerHTML = `
      <button class="btn" id="modalCancel">取消</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="modalConfirm">${esc(confirmText)}</button>`;
    modal.hidden = false;
    const close = (result) => {
      modal.hidden = true;
      resolve(result);
    };
    $('#modalCancel').onclick = () => close(false);
    $('#modalClose').onclick = () => close(false);
    $('#modalConfirm').onclick = () => close(true);
    modal.onclick = (event) => { if (event.target === modal) close(false); };
  });
}

// ---------------- data loading ----------------
async function loadBasics() {
  const [health, destinations, tasks, segments] = await Promise.all([
    api('/api/health'),
    api('/api/destinations'),
    api('/api/tasks'),
    api('/api/segments'),
  ]);
  state.businessDate = health.businessDate;
  state.destinations = destinations.destinations;
  state.tasks = tasks.tasks;
  state.segments = segments.segments;
  $('#businessDate').textContent = health.businessDate;
  const up = health.destinations.filter((d) => d.ok).length;
  $('#health').innerHTML =
    `<span class="dot ${up === health.destinations.length ? 'ok' : up ? 'bad' : 'bad'}"></span>` +
    `平台连通 ${up}/${health.destinations.length}`;
}

// ---------------- views ----------------
const views = {};

views.overview = async () => {
  const [stats, failures, runs] = await Promise.all([
    api(`/api/stats`),
    api('/api/failures?status=open&limit=5'),
    api('/api/runs?limit=5'),
  ]);
  const totalSuccess = stats.summary.reduce((n, s) => n + s.success, 0);
  const totalAttempts = stats.summary.reduce((n, s) => n + s.attempts, 0);
  const openFailures = failures.total;

  return `
    <div class="grid cols-4">
      ${statCard('目的地', state.destinations.length, `${state.destinations.filter((d) => d.online !== false).length} 个已连接`)}
      ${statCard('同步任务', state.tasks.length, `${state.tasks.filter((t) => t.enabled).length} 个已启用`)}
      ${statCard('今日推送成功率', totalAttempts ? `${((totalSuccess / totalAttempts) * 100).toFixed(1)}%` : '—', `${totalSuccess}/${totalAttempts} 条记录`)}
      ${statCard('待处理失败', openFailures, openFailures ? '需要重试或人工处理' : '暂无')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>目的地连接</h2>
        <button class="btn primary" id="quickRun">立即同步全部任务</button>
      </div>
      <div class="panel-body tight">
        <table>
          <thead><tr><th>目的地</th><th>类型</th><th>配额使用</th><th>今日成功率</th><th>待处理失败</th><th>任务数</th><th></th></tr></thead>
          <tbody>
            ${state.destinations.map((d) => {
              const s = stats.summary.find((x) => x.destinationId === d.id);
              const usage = d.usage;
              const pct = usage && usage.limit ? Math.min(100, (usage.used / usage.limit) * 100) : 0;
              return `<tr>
                <td><strong>${esc(d.name)}</strong><div class="small muted mono">${esc(d.baseUrl)}</div></td>
                <td>${platformChip(d.platform)}</td>
                <td style="min-width:170px">
                  <div class="small muted">${usage ? `${usage.used} / ${usage.limit}` : '不可用'}</div>
                  <div class="bar"><i style="width:${pct}%;background:${pct > 85 ? 'var(--red)' : 'var(--accent)'}"></i></div>
                </td>
                <td class="num">${s ? `${s.successRate}%` : '—'}</td>
                <td class="num">${d.openFailures ? chip(d.openFailures, 'red') : chip('0', 'green')}</td>
                <td class="num">${d.taskCount}</td>
                <td class="row-actions"><button class="btn ghost" data-goto="destinations">管理</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="panel">
        <div class="panel-head"><h2>最近运行</h2><button class="btn ghost" data-goto="logs">全部日志</button></div>
        <div class="panel-body tight">
          ${runs.runs.length ? `<table>
            <thead><tr><th>时间</th><th>状态</th><th class="num">新增</th><th class="num">移出</th><th class="num">失败</th></tr></thead>
            <tbody>${runs.runs.map((r) => `<tr>
              <td class="small">${fmtTime(r.createdAt)}</td>
              <td>${statusChip(r.status)}</td>
              <td class="num">${r.summary?.totals.addSuccess ?? '—'}</td>
              <td class="num">${r.summary?.totals.removeSuccess ?? '—'}</td>
              <td class="num">${r.summary?.totals.failed ?? '—'}</td>
            </tr>`).join('')}</tbody>
          </table>` : '<div class="empty">还没有运行记录</div>'}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>最近失败</h2><button class="btn ghost" data-goto="failures">处理失败</button></div>
        <div class="panel-body tight">
          ${failures.failures.length ? `<table>
            <thead><tr><th>用户</th><th>任务</th><th>原因</th></tr></thead>
            <tbody>${failures.failures.map((f) => `<tr>
              <td class="mono">${esc(f.userId)}</td>
              <td class="small">${esc(f.taskName)}</td>
              <td class="small">${esc(f.errorCode ?? '')}<div class="muted">${esc(f.errorMessage ?? '')}</div></td>
            </tr>`).join('')}</tbody>
          </table>` : '<div class="empty">暂无待处理失败</div>'}
        </div>
      </div>
    </div>
  `;
};

function statCard(label, value, sub) {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

views.destinations = async () => {
  return `
    <div class="banner info">哈希方式、批量大小、限速与配额都在这里按目的地配置。手机号在发送前会按此处的规则哈希, 不会离开服务器。</div>
    <div class="grid cols-2">
      ${state.destinations.map((d) => destinationCard(d)).join('')}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>新增目的地</h2></div>
      <div class="panel-body">
        <form id="destForm" class="grid cols-3">
          <label class="field"><span>名称</span><input name="name" required placeholder="例如: 抖音广告" /></label>
          <label class="field"><span>类型</span>
            <select name="platform">
              <option value="sms">短信平台</option>
              <option value="wecom">企业微信</option>
              <option value="ads">广告投放</option>
            </select>
          </label>
          <label class="field"><span>接口地址</span><input name="baseUrl" required placeholder="http://127.0.0.1:4104" /></label>
          <div class="flex" style="align-items:flex-end;grid-column:span 3">
            <button class="btn primary" type="submit">创建连接</button>
            <span class="small muted">创建后可继续配置哈希、批量与配额。</span>
          </div>
        </form>
      </div>
    </div>
  `;
};

function destinationCard(d) {
  const conf = d.config;
  const usage = d.usage;
  const pct = usage && usage.limit ? Math.min(100, (usage.used / usage.limit) * 100) : 0;
  const healthOk = d.health?.ok;
  return `<div class="panel">
    <div class="panel-head">
      <div class="flex">
        <h2>${esc(d.name)}</h2>${platformChip(d.platform)}
        ${healthOk ? chip('在线', 'green') : chip('离线', 'red')}
      </div>
      <div class="row-actions">
        <button class="btn ghost" data-test-dest="${d.id}">测试连接</button>
        <button class="btn ghost" data-mock="${d.id}">Mock 配置</button>
        <button class="btn ghost" data-edit-dest="${d.id}">编辑</button>
      </div>
    </div>
    <div class="panel-body" style="display:grid;gap:12px">
      <div class="mono small muted">${esc(d.baseUrl)}</div>
      <div>
        <div class="flex small"><span class="muted">今日配额</span><span class="spacer"></span><span>${usage ? `${usage.used} / ${usage.limit}` : '未知'}</span></div>
        <div class="bar mt" style="margin-top:6px"><i style="width:${pct}%;background:${pct > 85 ? 'var(--red)' : 'var(--accent)'}"></i></div>
      </div>
      <dl class="kv">
        <dt>手机号哈希</dt><dd class="mono small">${esc(conf.hash.algorithm)}${conf.hash.uppercase ? ' / 大写' : ''}${conf.hash.salt ? ` / salt=${esc(conf.hash.salt)}` : ' / 无 salt'}</dd>
        <dt>批量大小</dt><dd>${conf.batchSize}</dd>
        <dt>限速</dt><dd>${conf.requestsPerSecond} 请求/秒</dd>
        <dt>每日配额</dt><dd>${conf.dailyQuota}</dd>
        <dt>逐条重试</dt><dd>${conf.maxRetries} 次, 间隔 ${conf.retryBackoffMs}ms</dd>
        <dt>待处理失败</dt><dd>${d.openFailures ? chip(d.openFailures, 'red') : '0'}</dd>
      </dl>
    </div>
  </div>`;
}

views.tasks = async () => {
  return `
    <div class="panel">
      <div class="panel-head">
        <h2>同步任务</h2>
        <button class="btn primary" id="newTask">新建任务</button>
      </div>
      <div class="panel-body tight">
        <table>
          <thead><tr><th>任务</th><th>分群</th><th>目的地</th><th>受众 ID</th><th class="num">已同步</th><th class="num">确认阈值</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${state.tasks.map((t) => `<tr>
              <td><strong>${esc(t.name)}</strong></td>
              <td>${esc(t.segmentName)} <span class="muted small">(${t.segmentCount})</span></td>
              <td>${esc(t.destinationName)} ${platformChip(t.platform ?? 'sms')}</td>
              <td class="mono small">${esc(t.audienceId)}</td>
              <td class="num">${t.syncedCount}</td>
              <td class="num">${t.confirmThreshold || '—'}</td>
              <td>${t.enabled ? chip('启用', 'green') : chip('停用', 'gray')}</td>
              <td class="row-actions">
                <button class="btn ghost" data-preview-task="${t.id}">预览</button>
                <button class="btn ghost" data-edit-task="${t.id}">编辑</button>
                <button class="btn ghost" data-delete-task="${t.id}">删除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="8" class="empty">还没有同步任务</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="banner info">
      阈值规则: 某个任务本次的 (新增 + 移出) 人数超过阈值时, 整次运行需要人工确认后才会执行。
    </div>
  `;
};

views.preview = async () => {
  const preview = state.preview ?? (await api('/api/preview', { method: 'POST', body: {} })).preview;
  state.preview = preview;
  return renderPreview(preview);
};

function renderPreview(preview) {
  const t = preview.totals;
  return `
    <div class="grid cols-4">
      ${statCard('拟新增', t.adds, '本轮要推给平台的人')}
      ${statCard('拟移出', t.removes, '已推送但不在分群里了')}
      ${statCard('被拦截', t.blocked, '退订 / 拉黑, 永不推送')}
      ${statCard('短信去重', t.smsDeduped, '今天已发过短信, 不再重发')}
    </div>
    ${preview.requiresConfirmation
      ? `<div class="banner warn">⚠ 本次有任务影响人数超过阈值, 需要人工确认后才能执行。请核对下方明细。</div>`
      : `<div class="banner info">影响人数未超过任何任务阈值, 可直接执行。执行只会推送下面的新增/移出, 不会全量重传。</div>`}
    ${t.deferred ? `<div class="banner warn">有 ${t.deferred} 人因目的地今日配额不足被顺延到下一次同步。</div>` : ''}
    <div class="flex">
      <button class="btn primary" id="executePreview">${preview.requiresConfirmation ? '确认并执行' : '执行本次同步'}</button>
      <button class="btn" id="refreshPreview">重新计算</button>
      <span class="small muted">指纹 ${esc(preview.fingerprint)} · 业务日 ${esc(preview.businessDate)}</span>
    </div>
    <div class="grid cols-2">
      ${preview.tasks.map(taskDiffCard).join('')}
    </div>
  `;
}

function taskDiffCard(diff) {
  const sample = (ids) => ids.slice(0, 8).map(esc).join(' ') + (ids.length > 8 ? ' …' : '');
  return `<div class="preview-card ${diff.requiresConfirmation ? 'need-confirm' : ''}">
    <header>
      <div>
        <strong>${esc(diff.taskName)}</strong>
        <div class="small muted">${esc(diff.segmentName)} → ${esc(diff.destinationName)} ${platformChip(diff.platform)}
          · 分群 ${diff.totalMembers} 人, 其中 ${diff.unchanged} 人无变化</div>
      </div>
      ${diff.requiresConfirmation ? chip('超阈值需确认', 'amber') : chip('可执行', 'green')}
    </header>
    <div class="body">
      <div class="mini-stats">
        <div><b style="color:var(--green)">${diff.adds.length}</b>新增</div>
        <div><b style="color:var(--red)">${diff.removes.length}</b>移出</div>
        <div><b class="muted">${diff.blocked.length}</b>拦截</div>
        <div><b class="muted">${diff.smsDeduped.length}</b>短信去重</div>
        <div><b class="muted">${diff.deferred.length}</b>配额顺延</div>
        <div><b class="muted">${diff.quotaRemaining}</b>今日剩余配额</div>
      </div>
      ${diff.adds.length ? `<div><div class="small muted">新增样例</div><div class="sample-list">${sample(diff.adds)}</div></div>` : ''}
      ${diff.removes.length ? `<div><div class="small muted">移出样例</div><div class="sample-list">${sample(diff.removes)}</div></div>` : ''}
      ${diff.smsDeduped.length ? `<div><div class="small muted">今天已收到短信、不再重发的用户</div><div class="sample-list">${sample(diff.smsDeduped)}</div></div>` : ''}
      ${diff.warnings.map((w) => `<div class="banner warn small">${esc(w)}</div>`).join('')}
    </div>
  </div>`;
}

views.logs = async ({ query = {} } = {}) => {
  const params = new URLSearchParams({ limit: '100', ...query });
  const data = await api(`/api/logs?${params}`);
  const filters = `
    <form class="flex wrap" id="logFilters" style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <select name="destinationId" style="width:auto">
        <option value="">全部目的地</option>
        ${state.destinations.map((d) => `<option value="${d.id}" ${query.destinationId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
      <select name="status" style="width:auto">
        <option value="">全部状态</option>
        <option value="success" ${query.status === 'success' ? 'selected' : ''}>成功</option>
        <option value="failed" ${query.status === 'failed' ? 'selected' : ''}>失败</option>
        <option value="deferred" ${query.status === 'deferred' ? 'selected' : ''}>顺延</option>
      </select>
      <select name="action" style="width:auto">
        <option value="">全部动作</option>
        <option value="add" ${query.action === 'add' ? 'selected' : ''}>新增</option>
        <option value="remove" ${query.action === 'remove' ? 'selected' : ''}>移出</option>
      </select>
      <input name="userId" placeholder="用户 ID" value="${esc(query.userId ?? '')}" style="width:150px" />
      <button class="btn" type="submit">筛选</button>
      <span class="spacer"></span>
      <span class="small muted">共 ${data.total} 条</span>
    </form>`;
  return `<div class="panel">
    <div class="panel-head"><h2>发送日志</h2><span class="small muted">手机号只记录哈希, 不落明文</span></div>
    ${filters}
    <div class="panel-body tight">
      ${data.logs.length ? `<table>
        <thead><tr><th>时间</th><th>目的地 / 任务</th><th>动作</th><th>用户</th><th>手机号哈希</th><th>状态</th><th>重试</th><th class="num">耗时</th><th>错误</th></tr></thead>
        <tbody>${data.logs.map((l) => `<tr>
          <td class="small">${fmtTime(l.createdAt)}</td>
          <td class="small">${esc(l.destinationName)}<div class="muted">${esc(l.taskName)}</div></td>
          <td>${l.action === 'add' ? chip('新增', 'blue') : chip('移出', 'gray')}</td>
          <td class="mono small">${esc(l.userId)}</td>
          <td class="mono small muted">${l.phoneHash ? esc(l.phoneHash.slice(0, 16)) + '…' : '—'}</td>
          <td>${statusChip(l.status)}${l.deduped ? ' ' + chip('去重', 'amber') : ''}</td>
          <td class="num small">${l.attemptNo || '—'}</td>
          <td class="num small">${l.latencyMs}ms</td>
          <td class="small">${esc(l.errorCode ?? '')}<div class="muted">${esc(l.errorMessage ?? '')}</div></td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty">没有匹配的日志</div>'}
    </div>
  </div>`;
};

views.failures = async () => {
  const [open, resolved] = await Promise.all([
    api('/api/failures?status=open&limit=200'),
    api('/api/failures?status=resolved&limit=30'),
  ]);
  const byDestination = new Map();
  for (const failure of open.failures) {
    const list = byDestination.get(failure.destinationId) ?? [];
    list.push(failure);
    byDestination.set(failure.destinationId, list);
  }
  return `
    <div class="banner info">平台返回部分成功时, 失败项已自动重试。仍未成功的进入这里, 可对某个目的地单独重试, 不会重发已成功的项。</div>
    <div class="panel">
      <div class="panel-head">
        <h2>待处理失败 (${open.total})</h2>
        <div class="flex">
          ${[...byDestination.entries()].map(([destinationId, list]) => {
            const destination = state.destinations.find((d) => d.id === destinationId);
            return `<button class="btn primary" data-retry-dest="${destinationId}">重试 ${esc(destination?.name ?? destinationId)} (${list.length})</button>`;
          }).join('')}
        </div>
      </div>
      <div class="panel-body tight">
        ${open.failures.length ? `<table>
          <thead><tr><th>目的地</th><th>任务</th><th>用户</th><th>动作</th><th>错误</th><th class="num">尝试</th><th>最近尝试</th><th></th></tr></thead>
          <tbody>${open.failures.map((f) => `<tr>
            <td class="small">${esc(state.destinations.find((d) => d.id === f.destinationId)?.name ?? f.destinationId)}</td>
            <td class="small">${esc(f.taskName)}</td>
            <td class="mono small">${esc(f.userId)}</td>
            <td>${f.action === 'add' ? chip('新增', 'blue') : chip('移出', 'gray')}</td>
            <td class="small">${esc(f.errorCode ?? '')}<div class="muted">${esc(f.errorMessage ?? '')}</div></td>
            <td class="num">${f.attempts}</td>
            <td class="small">${fmtTime(f.lastAttemptAt)}</td>
            <td class="row-actions"><button class="btn ghost" data-resolve="${f.id}">标记已处理</button></td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty">没有待处理的失败, 所有名单都已收敛 ✓</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>最近已解决 (${resolved.total})</h2></div>
      <div class="panel-body tight">
        ${resolved.failures.length ? `<table>
          <thead><tr><th>用户</th><th>任务</th><th>动作</th><th>处理说明</th><th>解决时间</th></tr></thead>
          <tbody>${resolved.failures.map((f) => `<tr>
            <td class="mono small">${esc(f.userId)}</td>
            <td class="small">${esc(f.taskName)}</td>
            <td>${f.action === 'add' ? '新增' : '移出'}</td>
            <td class="small muted">${esc(f.resolveNote ?? '')}</td>
            <td class="small">${fmtTime(f.resolvedAt)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty">暂无记录</div>'}
      </div>
    </div>
  `;
};

views.stats = async ({ query = {} } = {}) => {
  const params = new URLSearchParams(query.destinationId ? { destinationId: query.destinationId } : {});
  const data = await api(`/api/stats?${params}`);
  return `
    <div class="panel">
      <div class="panel-head">
        <h2>按天统计 (${esc(data.from)})</h2>
        <select id="statsDest" style="width:auto">
          <option value="">全部目的地</option>
          ${state.destinations.map((d) => `<option value="${d.id}" ${query.destinationId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="panel-body tight">
        <table>
          <thead><tr><th>日期</th><th>目的地</th><th class="num">实际发送</th><th class="num">成功</th><th class="num">失败</th><th class="num">顺延</th><th class="num">去重</th><th class="num">拦截</th><th class="num">成功率</th><th class="num">平均耗时</th><th class="num">P95</th></tr></thead>
          <tbody>
            ${data.stats.map((r) => `<tr>
              <td>${esc(r.businessDate)}</td>
              <td>${esc(r.destinationName)} ${platformChip(r.platform)}</td>
              <td class="num">${r.attempts}</td>
              <td class="num">${r.success}</td>
              <td class="num">${r.failed}</td>
              <td class="num">${r.deferred}</td>
              <td class="num">${r.deduped}</td>
              <td class="num">${r.blocked ?? 0}</td>
              <td class="num">${r.successRate}%</td>
              <td class="num">${r.avgLatencyMs}ms</td>
              <td class="num">${r.p95LatencyMs}ms</td>
            </tr>`).join('') || '<tr><td colspan="10" class="empty">暂无统计数据</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="grid cols-3">
      ${data.summary.map((s) => `<div class="panel"><div class="panel-body">
        <div class="flex"><strong>${esc(s.destinationName)}</strong>${platformChip(s.platform)}</div>
        <div class="grid cols-2 mt" style="gap:8px">
          <div class="small muted">成功率<b style="display:block;font-size:19px;color:var(--text)">${s.successRate}%</b></div>
          <div class="small muted">平均耗时<b style="display:block;font-size:19px;color:var(--text)">${s.avgLatencyMs}ms</b></div>
          <div class="small muted">成功 / 尝试<b style="display:block;font-size:15px;color:var(--text)">${s.success} / ${s.attempts}</b></div>
          <div class="small muted">顺延 / 去重 / 拦截<b style="display:block;font-size:15px;color:var(--text)">${s.deferred} / ${s.deduped} / ${s.blocked ?? 0}</b></div>
        </div>
      </div></div>`).join('')}
    </div>
  `;
};

views.verify = async () => {
  const report = await api(`/api/verify?businessDate=${encodeURIComponent(state.businessDate || '')}`);
  return `
    <div class="banner ${report.ok ? 'ok' : 'bad'}">
      ${report.ok
        ? '✓ 所有平台的最终名单与“数仓分群 − 退订/黑名单”的应有名单完全一致, 哈希格式、批次大小、配额与短信去重全部通过。'
        : `✗ 发现 ${report.failures.length} 项不一致, 详见下方。`}
    </div>
    ${report.destinations.map((d) => `<div class="panel">
      <div class="panel-head">
        <div class="flex"><h2>${esc(d.destinationName)}</h2>${platformChip(d.platform)}${d.ok ? chip('一致', 'green') : chip('不一致', 'red')}</div>
      </div>
      <div class="panel-body">
        <div class="flex wrap small" style="gap:16px;margin-bottom:10px">
          <span>哈希格式 ${d.hashFormatOk ? '✓' : '✗'}</span>
          <span>批次 ${d.maxBatchSeen}/${d.batchLimit} ${d.batchSizeOk ? '✓' : '✗'}</span>
          <span>配额 ${d.quotaUsed}/${d.quotaLimit} ${d.quotaOk ? '✓' : '✗'}</span>
          <span>RPS ${d.maxRpsSeen}/${d.rpsLimit}</span>
          <span>限速响应 ${d.rateLimitedResponses}</span>
          ${d.platform === 'sms' ? `<span>短信去重 ${d.smsDedupeOk ? '✓' : `✗ 重复 ${d.duplicateTexts}`}</span>` : ''}
        </div>
        <table>
          <thead><tr><th>任务</th><th class="num">应有</th><th class="num">实际</th><th class="num">缺少</th><th class="num">多出</th><th class="num">配额顺延</th><th class="num">哈希错</th><th class="num">黑名单泄漏</th><th>结论</th></tr></thead>
          <tbody>${d.tasks.map((t) => `<tr>
            <td>${esc(t.taskName)}<div class="small muted mono">${esc(t.audienceId)}</div></td>
            <td class="num">${t.expectedCount}</td>
            <td class="num">${t.actualCount}</td>
            <td class="num">${t.missing.length}</td>
            <td class="num">${t.extra.length}</td>
            <td class="num">${t.deferredMissing.length}</td>
            <td class="num">${t.wrongHash}</td>
            <td class="num">${t.blockedLeaked.length}</td>
            <td>${t.ok ? chip('一致', 'green') : chip('不一致', 'red')}
              ${t.notes.map((n) => `<div class="small muted">${esc(n)}</div>`).join('')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`).join('')}
    <div class="panel"><div class="panel-body small muted">
      短信跨受众去重: 检查 ${report.smsDailyDedupe.checkedDays} 个业务日,
      同一手机号同日重复短信 ${report.smsDailyDedupe.duplicateTexts} 条 ${report.smsDailyDedupe.ok ? '✓' : '✗'}
      <div class="mt">核对时间 ${fmtTime(report.generatedAt)}</div>
    </div></div>
  `;
};

// ---------------- actions ----------------
const actions = {
  async quickRun() {
    await actions.previewAndRun();
  },

  async previewAndRun() {
    const { preview } = await api('/api/preview', { method: 'POST', body: {} });
    state.preview = preview;
    if (preview.requiresConfirmation) {
      const body = preview.tasks.filter((t) => t.requiresConfirmation).map((t) => `
        <div class="banner warn">${esc(t.taskName)}: 影响 ${t.affected} 人, 超过阈值 ${t.threshold}</div>`).join('');
      const ok = await confirmDialog({
        title: '需要人工确认',
        body: `${body}<p class="small muted">确认后会按上面的预览结果推送, 只推送新增与移出, 不会全量重传。</p>`,
        confirmText: '确认执行',
      });
      if (!ok) return;
      await execute(preview, true);
    } else {
      await execute(preview, false);
    }
  },

  async executePreview() {
    if (!state.preview) return;
    const preview = state.preview;
    if (preview.requiresConfirmation) {
      const ok = await confirmDialog({
        title: '确认执行同步',
        body: `<p>本次将新增 <b>${preview.totals.adds}</b> 人、移出 <b>${preview.totals.removes}</b> 人, ` +
          `拦截 <b>${preview.totals.blocked}</b> 人, 短信去重 <b>${preview.totals.smsDeduped}</b> 人。</p>
          <p class="small muted">闸门阈值已触发, 需要你确认。</p>`,
        confirmText: '确认并执行',
      });
      if (!ok) return;
      await execute(preview, true);
    } else {
      await execute(preview, false);
    }
  },
};

async function execute(preview, confirmed) {
  try {
    const data = await api('/api/runs', {
      method: 'POST',
      body: { preview, confirmed, taskIds: preview.tasks.map((t) => t.taskId), businessDate: preview.businessDate },
    });
    if (data.requiresConfirmation) {
      state.preview = data.preview;
      await render();
      return;
    }
    const s = data.summary;
    toast(`同步完成: 新增 ${s.totals.addSuccess}, 移出 ${s.totals.removeSuccess}, 失败 ${s.totals.failed}`, s.totals.failed ? 'bad' : 'ok');
    state.preview = null;
    await refreshAll();
    setView('logs');
  } catch (error) {
    if (error.status === 409 && error.data?.error === 'stale_preview') {
      toast('预览已过期: 数据在预览后发生变化, 已为你重新计算', 'bad');
      state.preview = null;
      await render();
      return;
    }
    toast(error.message, 'bad');
  }
}

async function refreshAll() {
  await loadBasics();
}

const viewConfig = {
  overview: { title: '总览', load: views.overview },
  destinations: { title: '目的地连接', load: views.destinations },
  tasks: { title: '同步任务', load: views.tasks },
  preview: { title: '人群差异 / 预览', load: views.preview },
  logs: { title: '发送日志', load: views.logs },
  failures: { title: '失败记录', load: views.failures },
  stats: { title: '统计报表', load: views.stats },
  verify: { title: '名单核对', load: views.verify },
};

let currentQuery = {};

async function render() {
  const config = viewConfig[state.view];
  $('#viewTitle').textContent = config.title;
  document.querySelectorAll('#nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
  });
  const top = $('#topActions');
  top.innerHTML = `<button class="btn" id="reloadView">刷新</button>`;
  $('#reloadView').onclick = () => render();
  main().innerHTML = '<div class="empty">加载中…</div>';
  try {
    main().innerHTML = await config.load({ query: currentQuery });
    bindViewEvents();
  } catch (error) {
    main().innerHTML = `<div class="banner bad">加载失败: ${esc(error.message)}</div>`;
  }
}

function setView(view) {
  state.view = view;
  currentQuery = {};
  render();
}

function bindViewEvents() {
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.onclick = () => setView(el.dataset.goto);
  });
  document.querySelectorAll('[data-preview-task]').forEach((el) => {
    el.onclick = async () => {
      const { preview } = await api('/api/preview', {
        method: 'POST',
        body: { taskIds: [el.dataset.previewTask] },
      });
      state.preview = preview;
      setView('preview');
    };
  });
  const quickRun = $('#quickRun');
  if (quickRun) quickRun.onclick = actions.quickRun;
  const exec = $('#executePreview');
  if (exec) exec.onclick = actions.executePreview;
  const refresh = $('#refreshPreview');
  if (refresh) refresh.onclick = async () => {
    state.preview = null;
    await render();
  };
  const newTask = $('#newTask');
  if (newTask) newTask.onclick = openTaskModal;
  document.querySelectorAll('[data-edit-task]').forEach((el) => {
    el.onclick = () => openTaskModal(el.dataset.editTask);
  });
  document.querySelectorAll('[data-delete-task]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDialog({
        title: '删除任务',
        body: '<p>删除任务不会清理平台上的受众, 只停止后续同步。确定继续?</p>',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/tasks/${el.dataset.deleteTask}`, { method: 'DELETE' });
      toast('任务已删除', 'ok');
      await refreshAll();
      await render();
    };
  });
  document.querySelectorAll('[data-edit-dest]').forEach((el) => {
    el.onclick = () => openDestinationModal(el.dataset.editDest);
  });
  document.querySelectorAll('[data-test-dest]').forEach((el) => {
    el.onclick = async () => {
      try {
        const result = await api(`/api/destinations/${el.dataset.testDest}/test`, { method: 'POST' });
        toast(`连接正常, 延迟 ${result.health.latencyMs}ms`, 'ok');
      } catch (error) {
        toast(`连接失败: ${error.message}`, 'bad');
      }
    };
  });
  document.querySelectorAll('[data-mock]').forEach((el) => {
    el.onclick = () => openMockModal(el.dataset.mock);
  });
  const destForm = $('#destForm');
  if (destForm) destForm.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(destForm);
    try {
      await api('/api/destinations', { method: 'POST', body: Object.fromEntries(form) });
      toast('目的地已创建', 'ok');
      await refreshAll();
      await render();
    } catch (error) {
      toast(error.message, 'bad');
    }
  };
  document.querySelectorAll('[data-retry-dest]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        const { result } = await api('/api/failures/retry', {
          method: 'POST',
          body: { destinationId: el.dataset.retryDest },
        });
        toast(`重试完成: 成功 ${result.succeeded}, 仍失败 ${result.failed}`, result.failed ? 'bad' : 'ok');
        await render();
      } catch (error) {
        toast(error.message, 'bad');
        el.disabled = false;
      }
    };
  });
  document.querySelectorAll('[data-resolve]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDialog({
        title: '标记失败已处理',
        body: '<p>仅从待处理列表移除, 不会重新推送该用户。</p>',
        confirmText: '标记已处理',
      });
      if (!ok) return;
      await api(`/api/failures/${el.dataset.resolve}/resolve`, { method: 'POST', body: {} });
      await render();
    };
  });
  const logFilters = $('#logFilters');
  if (logFilters) logFilters.onsubmit = (event) => {
    event.preventDefault();
    currentQuery = Object.fromEntries(
      [...new FormData(logFilters).entries()].filter(([, value]) => value),
    );
    render();
  };
  const statsDest = $('#statsDest');
  if (statsDest) statsDest.onchange = () => {
    currentQuery = statsDest.value ? { destinationId: statsDest.value } : {};
    render();
  };
}

// ---------------- modals ----------------
function openTaskModal(taskId) {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  const modal = $('#modal');
  $('#modalTitle').textContent = task ? '编辑任务' : '新建任务';
  $('#modalBody').innerHTML = `
    <label class="field"><span>任务名称</span><input id="tName" value="${esc(task?.name ?? '')}" /></label>
    <label class="field"><span>数仓分群</span>
      <select id="tSegment">${state.segments.map((s) => `<option value="${s.id}" ${task?.segmentId === s.id ? 'selected' : ''}>${esc(s.name)} (${s.memberCount})</option>`).join('')}</select>
    </label>
    <label class="field"><span>目的地</span>
      <select id="tDestination">${state.destinations.map((d) => `<option value="${d.id}" ${task?.destinationId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    </label>
    <label class="field"><span>受众 ID (平台侧唯一)</span><input id="tAudience" value="${esc(task?.audienceId ?? '')}" placeholder="sms_new_users" /></label>
    <label class="field"><span>人工确认阈值 (0 = 不启用)</span><input id="tThreshold" type="number" min="0" value="${task?.confirmThreshold ?? 0}" /></label>
    <label class="check"><input type="checkbox" id="tEnabled" ${task?.enabled !== false ? 'checked' : ''} /> 启用此任务</label>
  `;
  $('#modalFooter').innerHTML = `
    <button class="btn" id="modalCancel">取消</button>
    <button class="btn primary" id="modalSave">保存</button>`;
  modal.hidden = false;
  $('#modalCancel').onclick = () => { modal.hidden = true; };
  $('#modalClose').onclick = () => { modal.hidden = true; };
  $('#modalSave').onclick = async () => {
    const body = {
      name: $('#tName').value.trim(),
      segmentId: $('#tSegment').value,
      destinationId: $('#tDestination').value,
      audienceId: $('#tAudience').value.trim(),
      confirmThreshold: Number($('#tThreshold').value || 0),
      enabled: $('#tEnabled').checked,
    };
    try {
      if (task) await api(`/api/tasks/${task.id}`, { method: 'PATCH', body });
      else await api('/api/tasks', { method: 'POST', body });
      modal.hidden = true;
      toast('任务已保存', 'ok');
      await refreshAll();
      await render();
    } catch (error) {
      toast(error.message, 'bad');
    }
  };
}

function openDestinationModal(destinationId) {
  const d = state.destinations.find((x) => x.id === destinationId);
  if (!d) return;
  const c = d.config;
  const modal = $('#modal');
  $('#modalTitle').textContent = `编辑目的地 · ${d.name}`;
  $('#modalBody').innerHTML = `
    <label class="field"><span>名称</span><input id="dName" value="${esc(d.name)}" /></label>
    <label class="field"><span>接口地址</span><input id="dUrl" value="${esc(d.baseUrl)}" /></label>
    <div class="grid cols-2">
      <label class="field"><span>批量大小</span><input id="dBatch" type="number" min="1" max="500" value="${c.batchSize}" /></label>
      <label class="field"><span>每秒请求数</span><input id="dRps" type="number" min="1" max="100" value="${c.requestsPerSecond}" /></label>
      <label class="field"><span>每日配额</span><input id="dQuota" type="number" min="0" value="${c.dailyQuota}" /></label>
      <label class="field"><span>逐条重试次数</span><input id="dRetries" type="number" min="0" max="10" value="${c.maxRetries}" /></label>
      <label class="field"><span>哈希算法</span>
        <select id="dAlgo">
          <option value="sha256" ${c.hash.algorithm === 'sha256' ? 'selected' : ''}>SHA-256</option>
          <option value="md5" ${c.hash.algorithm === 'md5' ? 'selected' : ''}>MD5</option>
        </select>
      </label>
      <label class="field"><span>哈希 salt</span><input id="dSalt" value="${esc(c.hash.salt)}" /></label>
    </div>
    <label class="check"><input type="checkbox" id="dUpper" ${c.hash.uppercase ? 'checked' : ''} /> 哈希输出大写</label>
    <label class="check"><input type="checkbox" id="dEnabled" ${d.enabled ? 'checked' : ''} /> 启用此目的地</label>
    <div class="banner warn small">修改哈希规则后, 下一次同步会把所有用户视为“手机号变更”重新推送, 请谨慎操作。</div>
  `;
  $('#modalFooter').innerHTML = `
    <button class="btn" id="modalCancel">取消</button>
    <button class="btn primary" id="modalSave">保存</button>`;
  modal.hidden = false;
  $('#modalCancel').onclick = () => { modal.hidden = true; };
  $('#modalClose').onclick = () => { modal.hidden = true; };
  $('#modalSave').onclick = async () => {
    const body = {
      name: $('#dName').value.trim(),
      baseUrl: $('#dUrl').value.trim(),
      enabled: $('#dEnabled').checked,
      config: {
        ...c,
        batchSize: Number($('#dBatch').value),
        requestsPerSecond: Number($('#dRps').value),
        dailyQuota: Number($('#dQuota').value),
        maxRetries: Number($('#dRetries').value),
        hash: {
          algorithm: $('#dAlgo').value,
          salt: $('#dSalt').value,
          uppercase: $('#dUpper').checked,
        },
      },
    };
    try {
      await api(`/api/destinations/${d.id}`, { method: 'PATCH', body });
      modal.hidden = true;
      toast('目的地已保存', 'ok');
      await refreshAll();
      await render();
    } catch (error) {
      toast(error.message, 'bad');
    }
  };
}

async function openMockModal(destinationId) {
  const d = state.destinations.find((x) => x.id === destinationId);
  const modal = $('#modal');
  $('#modalTitle').textContent = `Mock 平台配置 · ${d.name}`;
  $('#modalBody').innerHTML = '<div class="empty">读取中…</div>';
  $('#modalFooter').innerHTML = `
    <button class="btn" id="modalCancel">关闭</button>
    <button class="btn primary" id="modalSave">应用</button>`;
  modal.hidden = false;
  $('#modalCancel').onclick = () => { modal.hidden = true; };
  $('#modalClose').onclick = () => { modal.hidden = true; };
  try {
    const { state: mockState } = await api(`/api/destinations/${d.id}/mock`);
    const c = mockState.config;
    $('#modalBody').innerHTML = `
      <div class="banner info small">模拟平台行为: 限速、批量上限、每日配额与部分失败都在这里注入。所有注入都会在平台侧真实生效。</div>
      <div class="mock-grid">
        <label class="field"><span>每秒请求上限</span><input id="mRps" type="number" min="1" value="${c.rpsLimit}" /></label>
        <label class="field"><span>单批最大人数</span><input id="mBatch" type="number" min="1" value="${c.maxBatchSize}" /></label>
        <label class="field"><span>每日配额</span><input id="mQuota" type="number" min="0" value="${c.dailyQuota}" /></label>
        <label class="field"><span>单次延迟 (ms)</span><input id="mLatency" type="number" min="0" value="${c.latencyMs}" /></label>
        <label class="field"><span>瞬时失败比例 (%)</span><input id="mTransient" type="number" min="0" max="100" value="${c.transientFailPct}" /></label>
        <label class="field"><span>永久失败比例 (%)</span><input id="mPermanent" type="number" min="0" max="100" value="${c.permanentFailPct}" /></label>
        <label class="field"><span>接下来 N 个请求返回 503</span><input id="mFailNext" type="number" min="0" value="${c.failNextRequests}" /></label>
      </div>
      <div class="small muted">当前平台受众: ${mockState.audiences.map((a) => `${esc(a.audienceId)}=${a.count}`).join(', ') || '空'}</div>
      <div class="small muted">已接受请求最大批次 ${mockState.stats.maxBatchSizeSeen}, 最大 RPS ${mockState.stats.maxRequestsPerSecond}, 429 次数 ${mockState.stats.rateLimitedResponses}</div>
    `;
    $('#modalSave').onclick = async () => {
      try {
        await api(`/api/destinations/${d.id}/mock`, {
          method: 'PATCH',
          body: {
            rpsLimit: Number($('#mRps').value),
            maxBatchSize: Number($('#mBatch').value),
            dailyQuota: Number($('#mQuota').value),
            latencyMs: Number($('#mLatency').value),
            transientFailPct: Number($('#mTransient').value),
            permanentFailPct: Number($('#mPermanent').value),
            failNextRequests: Number($('#mFailNext').value),
          },
        });
        modal.hidden = true;
        toast('Mock 配置已更新', 'ok');
        await refreshAll();
        await render();
      } catch (error) {
        toast(error.message, 'bad');
      }
    };
  } catch (error) {
    $('#modalBody').innerHTML = `<div class="banner bad">读取失败: ${esc(error.message)}</div>`;
  }
}

// ---------------- boot ----------------
document.querySelectorAll('#nav button').forEach((button) => {
  button.onclick = () => setView(button.dataset.view);
});

setInterval(async () => {
  try {
    const health = await api('/api/health');
    const up = health.destinations.filter((d) => d.ok).length;
    $('#health').innerHTML =
      `<span class="dot ${up === health.destinations.length ? 'ok' : 'bad'}"></span>` +
      `平台连通 ${up}/${health.destinations.length}`;
  } catch {
    $('#health').innerHTML = '<span class="dot bad"></span>服务不可用';
  }
}, 15000);

(async () => {
  try {
    await loadBasics();
    await render();
  } catch (error) {
    main().innerHTML = `<div class="banner bad">初始化失败: ${esc(error.message)}</div>`;
  }
})();
