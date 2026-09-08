'use strict';

/* ============ 常量与状态 ============ */
const $ = (s, root) => (root || document).querySelector(s);
const STATUS = {
  pending:   { label: '待审核', cls: 'pending' },
  approved:  { label: '已通过', cls: 'approved' },
  paid:      { label: '已打款', cls: 'paid' },
  rejected:  { label: '已驳回', cls: 'rejected' },
  withdrawn: { label: '已撤回', cls: 'withdrawn' },
};
const ROLE_NAMES = { employee: '员工', finance: '财务审核', cashier: '出纳', admin: '管理员' };
const ROLE_CONF = {
  employee: { title: '我的报销', desc: '提交并实时跟踪你的报销申请', tabs: ['all','pending','approved','rejected','paid','withdrawn'], newBtn: true, def: 'all' },
  finance:  { title: '报销审核', desc: '审核所有员工的报销申请，通过后安排打款', tabs: ['all','pending','approved','rejected','paid'], newBtn: false, def: 'pending' },
  cashier:  { title: '打款管理', desc: '对已通过审核的申请执行打款', tabs: ['all','approved','paid'], newBtn: false, def: 'approved' },
  admin:    { title: '管理后台', desc: '账号管理、操作审计与全量报销概览', tabs: ['all','pending','approved','rejected','paid','withdrawn'], newBtn: false, def: 'all', admin: true },
};
const activeStatuses = ['pending', 'approved'];
const ADMIN_SECTIONS = [
  { id: 'overview', label: '报销总览' },
  { id: 'accounts', label: '账号管理' },
  { id: 'audit', label: '操作审计' },
  { id: 'chat', label: '智能问答' },
];
const AUDIT_ACTION_LABELS = {
  login: '登录', login_fail: '登录失败', login_blocked: '登录被阻止',
  user_create: '创建账号', user_update: '更新账号', user_password: '重置密码',
  user_toggle: '启用/停用账号', user_delete: '删除账号',
  submit: '提交报销', update: '修改报销', resubmit: '重新提交', withdraw: '撤回报销',
  approve: '审核通过', reject: '审核驳回', pay: '打款',
};
const AUDIT_BADGE = {
  login: 'paid', user_create: 'approved', user_update: 'approved', user_password: 'approved', user_toggle: 'approved',
  user_delete: 'rejected', login_fail: 'rejected', login_blocked: 'rejected', reject: 'rejected',
  submit: 'approved', update: 'pending', resubmit: 'pending', withdraw: 'withdrawn', approve: 'approved', pay: 'paid',
};

const S = {
  token: localStorage.getItem('rm_token'),
  user: JSON.parse(localStorage.getItem('rm_user') || 'null'),
  filter: 'all',
  search: '',
  items: [],
  prevStatus: {},
  stats: null,
  pollTimer: null,
  pendingImage: null, // base64 data url 待上传图片
  editingId: null,
  adminSection: 'overview',
};

/* ============ 工具 ============ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function authImg(url) {
  // 上传的发票图需登录鉴权（?token=），data URL 预览无需
  if (!url || !url.startsWith('/uploads/') || !S.token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(S.token);
}
function money(n) { return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function toast(msg, type) {
  type = type || 'info';
  const icons = { success: '✅', error: '⚠️', info: '🔔' };
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span class="t-ico">' + icons[type] + '</span><span>' + msg + '</span>';
  $('#toastStack').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(120%)'; }, 3800);
  setTimeout(() => el.remove(), 4300);
}
async function api(method, path, body) {
  const headers = new Headers();
  if (S.token) headers.set('Authorization', 'Bearer ' + S.token);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { logout(); }
  return { ok: res.ok, status: res.status, data };
}

/* ============ 登录 / 登出 ============ */
function renderLogin() {
  stopPolling();
  const accounts = [
    { u: 'zhangwei', t: '员工 · 张伟' },
    { u: 'lina', t: '员工 · 李娜' },
    { u: 'finance', t: '财务审核 · 王晓' },
    { u: 'cashier', t: '出纳 · 赵出纳' },
    { u: 'admin', t: '管理员 · 系统管理' },
  ];
  $('#root').innerHTML = `
    <div class="login-wrap">
      <div class="login-brand">
        <div class="logo"><span class="mark">🧾</span> 报销云</div>
        <div>
          <h1>让每一笔报销<br/>清晰、高效、可追溯</h1>
          <p>员工在线提交发票，财务在线审核，出纳一键打款 —— 全流程电子化，状态实时可见，审批留痕。</p>
          <div class="features">
            <div><span class="dot"></span> 发票拍照上传 · 自动校验</div>
            <div><span class="dot"></span> 多角色协同 · 权限隔离</div>
            <div><span class="dot"></span> 全流程留痕 · 实时状态</div>
          </div>
        </div>
        <div style="opacity:.7;font-size:12px;">演示系统 · 数据存于本地</div>
      </div>
      <div class="login-side">
        <div class="login-card">
          <h2>登录</h2>
          <p class="sub">使用你的账号进入报销系统</p>
          <form id="loginForm" autocomplete="off">
            <div class="field" id="uField">
              <label>账号</label>
              <div class="input-wrap"><span class="in-ico">👤</span><input id="loginUser" name="username" placeholder="请输入账号" autocomplete="username" /></div>
              <div class="err"></div>
            </div>
            <div class="field" id="pField">
              <label>密码</label>
              <div class="input-wrap"><span class="in-ico">🔒</span><input id="loginPass" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" /></div>
              <div class="err"></div>
            </div>
            <button class="btn primary btn-block" type="submit" id="loginBtn">登 录</button>
          </form>
          <div class="demo-accounts">
            <div class="t">演示账号（点击填入，密码均为 123456）</div>
            <div class="row">
              ${accounts.map(a => `<button class="p" data-user="${a.u}">${a.t}</button>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  $('#loginForm').addEventListener('submit', doLogin);
  document.querySelectorAll('.demo-accounts .p').forEach(b =>
    b.addEventListener('click', () => { $('#loginUser').value = b.dataset.user; $('#loginPass').value = '123456'; $('#loginUser').focus(); })
  );
}

async function doLogin(e) {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  setFieldErr('uField', username ? '' : '请输入账号');
  setFieldErr('pField', password ? '' : '请输入密码');
  if (!username || !password) return;
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = '登录中…';
  try {
    const { ok, data } = await api('POST', '/api/login', { username, password });
    if (!ok) { setFieldErr('pField', data.error || '登录失败'); toast(data.error || '登录失败', 'error'); return; }
    S.token = data.token; S.user = data.user;
    localStorage.setItem('rm_token', data.token);
    localStorage.setItem('rm_user', JSON.stringify(data.user));
    enterApp();
  } catch (err) {
    toast('无法连接服务器：' + err.message, 'error');
  } finally { btn.disabled = false; btn.textContent = '登 录'; }
}

function setFieldErr(frameId, msg) {
  const f = document.getElementById(frameId);
  if (!f) return;
  f.classList.toggle('error', !!msg);
  const el = f.querySelector('.err'); if (el) el.textContent = msg;
}

function logout() {
  api('POST', '/api/logout').catch(() => {});
  S.token = null; S.user = null;
  localStorage.removeItem('rm_token'); localStorage.removeItem('rm_user');
  renderLogin();
}

/* ============ 应用入口 ============ */
function enterApp() {
  const conf = ROLE_CONF[S.user.role];
  if (!conf) { logout(); return; }
  S.filter = conf.def; S.search = '';
  S.adminSection = 'overview';
  renderShell();
  loadData();
  if (S.user.role !== 'admin') startPolling(); // admin 管理端不做高频轮询，进入区块时按需刷新
}

function renderShell() {
  const u = S.user, conf = ROLE_CONF[u.role];
  $('#root').innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="topbar-inner">
          <div class="brand"><span class="mark">🧾</span> 报销云</div>
          <div class="topbar-right">
            <div class="user-chip">
              <div class="avatar">${esc((u.name || '?').slice(0,1))}</div>
              <div class="meta">
                <div class="name">${esc(u.name)}</div>
              </div>
              <span class="role-badge">${ROLE_NAMES[u.role] || u.role}</span>
            </div>
            <button class="icon-btn" id="logoutBtn" title="退出登录" aria-label="退出登录">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="container" id="content"></div>
    </div>
  `;
  $('#logoutBtn').addEventListener('click', () => { if (confirm('确定退出登录？')) logout(); });
}

/* ============ 数据加载与轮询 ============ */
async function loadData() {
  try {
    const [listRes, statsRes] = await Promise.all([api('GET', '/api/reimbursements'), api('GET', '/api/stats')]);
    if (listRes.ok) {
      detectStatusChanges(listRes.data.items || []);
      S.items = listRes.data.items || [];
    }
    if (statsRes.ok) S.stats = statsRes.data;
    renderContent();
  } catch (err) { /* 轮询失败静默，避免抖动 */ }
}

function detectStatusChanges(items) {
  // 首次加载仅记录，不发通知
  const isFirst = Object.keys(S.prevStatus).length === 0;
  const cur = {};
  items.forEach(i => { cur[i.id] = i.status; });
  if (!isFirst) {
    items.forEach(i => {
      if (S.prevStatus[i.id] && S.prevStatus[i.id] !== i.status) {
        const to = STATUS[i.status];
        toast(`申请 #${i.id} 状态更新 → ${to ? to.label : i.status}`, i.status === 'rejected' ? 'error' : 'success');
      }
    });
  }
  S.prevStatus = cur;
}

function startPolling() {
  stopPolling();
  S.pollTimer = setInterval(loadData, 3000);
}
function stopPolling() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

/* ============ 内容渲染 ============ */
function renderContent() {
  if (S.user.role === 'admin') { renderAdmin(); return; }
  const conf = ROLE_CONF[S.user.role];
  const box = $('#content');
  box.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${conf.title}</h2>
        <p class="desc">${conf.desc}</p>
      </div>
      ${conf.newBtn ? `<button class="btn primary" id="newBtn">＋ 新建报销</button>` : ''}
    </div>
    ${renderStats()}
    <div class="toolbar">
      <div class="tabs">${renderTabs(conf.tabs)}</div>
      <div class="search"><span>🔍</span><input id="searchInput" placeholder="搜索内容 / 事项 / 姓名…" value="${esc(S.search)}" /></div>
    </div>
    <div class="list" id="list"></div>
  `;
  if (conf.newBtn) $('#newBtn').addEventListener('click', () => openForm(null));
  $('#searchInput').addEventListener('input', (e) => { S.search = e.target.value; renderList(); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { S.filter = t.dataset.f; renderContent(); }));
  renderList();
}

function renderStats() {
  const r = S.user.role;
  const s = S.stats;
  if (!s) return `<div class="stats">${Array(4).fill('<div class="skeleton"></div>').join('')}</div>`;
  const card = (cls, k, v, a) => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="a">${a || ''}</div></div>`;
  if (r === 'employee') {
    return `<div class="stats">
      ${card('t-pending','待审核', s.pending.n, '金额 ' + money(s.pending.s))}
      ${card('t-approved','审核通过', s.approved.n, '金额 ' + money(s.approved.s))}
      ${card('t-paid','已打款', s.paid.n, '金额 ' + money(s.paid.s))}
      ${card('t-rejected','已驳回', s.rejected.n, s.rejected.n ? '可修改后重新提交' : '')}
    </div>`;
  }
  if (r === 'cashier') {
    // 出纳只看待打款与已打款
    return `<div class="stats">
      ${card('t-approved','待打款', s.approved.n, '金额 ' + money(s.approved.s))}
      ${card('t-paid','已打款', s.paid.n, '金额 ' + money(s.paid.s))}
    </div>`;
  }
  return `<div class="stats">
    ${card('t-pending','待审核', s.pending.n, '金额 ' + money(s.pending.s))}
    ${card('t-approved','待打款', s.approved.n, '金额 ' + money(s.approved.s))}
    ${card('t-paid','已打款', s.paid.n, '金额 ' + money(s.paid.s))}
    ${card('t-rejected','已驳回', s.rejected.n, '金额 ' + money(s.rejected.s))}
  </div>`;
}

function renderTabs(tabs) {
  return tabs.map(t => {
    if (t === 'all') return `<button class="tab ${S.filter==='all'?'active':''}" data-f="all">全部 ${S.stats ? S.stats.total.n : ''}</button>`;
    const st = STATUS[t];
    const n = S.stats ? (S.stats[t] ? S.stats[t].n : 0) : '';
    return `<button class="tab ${S.filter===t?'active':''}" data-f="${t}">${st.label} ${n}</button>`;
  }).join('');
}

function filteredItems() {
  let list = S.items;
  if (S.filter !== 'all') list = list.filter(i => i.status === S.filter);
  if (S.search) {
    const q = S.search.toLowerCase();
    list = list.filter(i => (i.invoiceContent + ' ' + i.reason + ' ' + (i.applicant ? i.applicant.name : '')).toLowerCase().includes(q));
  }
  return list;
}

function renderList() {
  const box = $('#list');
  if (!box) return;
  const list = filteredItems();
  if (!list.length) {
    box.innerHTML = `<div class="empty"><div class="big">🗂️</div><div>${S.filter==='all' ? '暂无报销申请' : '当前筛选下暂无申请'}</div></div>`;
    return;
  }
  box.innerHTML = list.map(renderItem).join('');
  box.querySelectorAll('.reimb').forEach(el => el.addEventListener('click', (e) => {
    // 点击卡片打开详情；点击操作按钮则交给全局处理器，不打开详情
    if (e.target.closest('.btn')) return;
    openDetail(Number(el.dataset.id));
  }));
}

function renderItem(x) {
  const st = STATUS[x.status] || { label: x.status, cls: 'gray' };
  const isEmp = S.user.role === 'employee';
  const img = x.imageUrl ? `<img src="${esc(authImg(x.imageUrl))}" alt="发票" />` : `<span class="ph">🖼️</span>`;
  const applicant = isEmp ? '' : `<span>👤 ${esc(x.applicant ? x.applicant.name : '')}</span>`;
  let action = '';
  if (isEmp) {
    if (x.status === 'pending') action = `<button class="btn ghost btn-sm" data-act="edit">编辑</button><button class="btn danger btn-sm" data-act="withdraw">撤回</button>`;
    else if (x.status === 'rejected') action = `<button class="btn subtle btn-sm" data-act="edit">修改并重提</button>`;
  } else if (S.user.role === 'finance' && x.status === 'pending') {
    action = `<button class="btn success btn-sm" data-act="approve">通过</button><button class="btn danger btn-sm" data-act="reject">驳回</button>`;
  } else if (S.user.role === 'cashier' && x.status === 'approved') {
    action = `<button class="btn primary btn-sm" data-act="pay">打款 ${money(x.amount)}</button>`;
  }
  return `
    <div class="reimb" data-id="${x.id}">
      <div class="thumb">${img}</div>
      <div class="body">
        <div class="row1">
          <span class="amount">${money(x.amount)}</span>
          <span class="content">${esc(x.invoiceContent)}</span>
          <span class="badge ${st.cls}"><span class="dot"></span>${st.label}</span>
        </div>
        <div class="reason">${esc(x.reason)}</div>
        <div class="meta">
          ${applicant}
          <span>🕒 更新 ${fmtTime(x.updatedAt)}</span>
        </div>
      </div>
      <div class="actions" data-actions>${action}</div>
    </div>
  `;
}

/* 卡片内动作（点击操作按钮时执行，不打开详情） */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn[data-act]');
  if (!btn) return;
  const card = btn.closest('.reimb');
  if (!card) return; // 详情弹窗内的按钮由 openDetail 单独处理
  e.stopPropagation();
  const id = Number(card.dataset.id);
  const act = btn.dataset.act;
  if (act === 'edit') openForm(id);
  else if (act === 'withdraw') await withdraw(id);
  else if (act === 'approve') await approve(id);
  else if (act === 'reject') await openReject(id);
  else if (act === 'pay') await pay(id);
});

/* ============ 详情弹窗 ============ */
async function openDetail(id) {
  const { ok, data } = await api('GET', '/api/reimbursements/' + id);
  if (!ok) { toast(data.error || '加载失败', 'error'); return; }
  const x = data.item;
  const st = STATUS[x.status];
  const histLabel = {
    submit: '提交报销申请', update: '修改申请', resubmit: '修改后重新提交',
    withdraw: '撤回申请', approve: '审核通过', reject: '驳回申请', pay: '打款完成',
  };
  const actions = actionButtonsFor(x);
  $('#detailModalBody').innerHTML = `
    <div class="modal-head">
      <h3>报销申请 #${x.id}</h3>
      <button class="close" onclick="closeModal('detailModal')">✕</button>
    </div>
    <div class="modal-body">
      <div class="detail-grid">
        <div class="d-info"><div class="k">申请人</div><div class="v">${esc(x.applicant ? x.applicant.name : '')}</div></div>
        <div class="d-info"><div class="k">发票金额</div><div class="v">${money(x.amount)}</div></div>
        <div class="d-info"><div class="k">发票内容</div><div class="v">${esc(x.invoiceContent)}</div></div>
        <div class="d-info"><div class="k">申请事项</div><div class="v">${esc(x.reason)}</div></div>
        <div class="d-info"><div class="k">当前状态</div><div class="v"><span class="badge ${st.cls}"><span class="dot"></span>${st.label}</span></div></div>
        <div class="d-info"><div class="k">提交 / 更新时间</div><div class="v" style="font-size:13px;">${fmtTime(x.createdAt)}<br/>${fmtTime(x.updatedAt)}</div></div>
      </div>
      <div class="k" style="font-size:13px;color:var(--ink-faint);margin-bottom:8px;">发票图片</div>
      ${x.imageUrl ? `<div class="invoice-img"><img src="${esc(authImg(x.imageUrl))}" alt="发票" /></div>` : '<div class="invoice-img"><span class="ph">🖼️ 未上传</span></div>'}
      <h4 style="margin:22px 0 10px;font-size:15px;">流程记录</h4>
      <div class="timeline">
        ${(x.history || []).map(h => {
          const cls = h.action === 'reject' ? 'red' : h.action === 'approve' ? 'green' : h.action === 'pay' ? 'green' : h.action === 'submit' ? '' : 'gray';
          return `<div class="tl-item ${cls}">
            <div class="t">${histLabel[h.action] || h.action} <span style="font-weight:400;color:var(--ink-faint)">· ${esc(h.operator_name || '系统')}</span></div>
            ${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}
            <div class="time">${fmtTime(h.created_at)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    ${actions ? `<div class="modal-foot">${actions}</div>` : ''}
  `;
  $('#detailModal').hidden = false;
  $('#detailModalBody').querySelectorAll('.btn[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    await closeModal('detailModal');
    if (act === 'edit') openForm(x.id);
    else if (act === 'withdraw') await withdraw(x.id);
    else if (act === 'approve') await approve(x.id);
    else if (act === 'reject') await openReject(x.id);
    else if (act === 'pay') await pay(x.id);
  }));
  const img = $('#detailModalBody .invoice-img img');
  if (img) img.addEventListener('click', () => showImage(img.src));
}

function actionButtonsFor(x) {
  const isEmp = S.user.role === 'employee';
  let btns = '';
  if (isEmp) {
    if (x.status === 'pending') btns = `<button class="btn ghost" data-act="edit">编辑</button><button class="btn danger" data-act="withdraw">撤回</button>`;
    else if (x.status === 'rejected') btns = `<button class="btn subtle" data-act="edit">修改并重新提交</button>`;
  } else if (S.user.role === 'finance' && x.status === 'pending') {
    btns = `<button class="btn success" data-act="approve">审核通过</button><button class="btn danger" data-act="reject">审核不通过</button>`;
  } else if (S.user.role === 'cashier' && x.status === 'approved') {
    btns = `<button class="btn primary" data-act="pay">立即打款 ${money(x.amount)}</button>`;
  }
  return btns;
}

async function openReject(id) {
  let x;
  try {
    const r = await api('GET', '/api/reimbursements/' + id);
    if (!r.ok) { toast(r.data.error || '加载失败', 'error'); return; }
    x = r.data.item;
  } catch { toast('加载失败', 'error'); return; }
  const reasonEl = $('#rejectModalBody');
  reasonEl.innerHTML = `
    <div class="modal-head">
      <h3>审核不通过</h3>
      <button class="close" onclick="closeModal('rejectModal')">✕</button>
    </div>
    <div class="modal-body">
      <p style="margin:0 0 8px;color:var(--ink-soft);font-size:13px;">申请 #${id} · ${esc(x.applicant ? x.applicant.name : '')} · ${money(x.amount)} · ${esc(x.invoiceContent)}</p>
      <div class="field" id="rjField">
        <label>驳回原因（必填，将反馈给申请人）</label>
        <textarea id="rjReason" rows="3" placeholder="请说明不通过的原因，如：发票抬头不符、金额超出标准…"></textarea>
        <div class="err"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal('rejectModal')">取消</button>
      <button class="btn danger" id="rjConfirm">确认驳回</button>
    </div>
  `;
  $('#rejectModal').hidden = false;
  $('#rjReason').focus();
  $('#rjConfirm').addEventListener('click', async () => {
    const note = $('#rjReason').value.trim();
    if (!note) { setFieldErr('rjField', '驳回必须填写原因'); return; }
    const res = await api('POST', `/api/reimbursements/${id}/reject`, { note });
    if (!res.ok) { toast(res.data.error || '操作失败', 'error'); return; }
    await closeModal('rejectModal');
    toast('已驳回该申请', 'success');
    loadData();
  });
}

/* ============ 表单弹窗（新建 / 编辑） ============ */
function openForm(id) {
  S.editingId = id;
  S.pendingImage = null;
  const conf = ROLE_CONF[S.user.role];
  let x = null;
  if (id) { x = S.items.find(i => i.id === id) || null; }
  const isEdit = !!x;
  const canUpload = true;
  $('#formModalBody').innerHTML = `
    <div class="modal-head">
      <h3>${isEdit ? (x.status === 'rejected' ? '修改并重新提交' : '编辑报销申请') : '新建报销申请'}</h3>
      <button class="close" onclick="closeModal('formModal')">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="field" id="fAmount">
          <label>发票金额（元）</label>
          <input id="fAmountInput" type="number" step="0.01" min="0" placeholder="0.00" value="${x ? x.amount : ''}" />
          <div class="err"></div>
        </div>
        <div class="field" id="fContent">
          <label>发票内容</label>
          <input id="fContentInput" placeholder="如：高铁票、办公用品、餐饮费" value="${esc(x ? x.invoiceContent : '')}" />
          <div class="err"></div>
        </div>
        <div class="field full" id="fReason">
          <label>申请事项（报销原因）</label>
          <textarea id="fReasonInput" rows="3" placeholder="请说明报销原因…">${esc(x ? x.reason : '')}</textarea>
          <div class="err"></div>
        </div>
        <div class="field full" id="fImage">
          <label>发票图片</label>
          <div class="upload-zone" id="uploadZone">
            <div id="upEmpty" ${x && x.imageUrl && !S.pendingImage ? 'style="display:none"' : ''}>
              <div class="u-ico">📤</div>
              <div class="up-hint">点击或拖拽图片到此处上传（支持 PNG/JPG，≤10MB）</div>
            </div>
            <img id="upPrev" class="prev" alt="预览" ${showImgSrc(x)} />
          </div>
          <input type="file" id="fileInput" accept="image/*" style="display:none" />
          <div class="err" id="fImageErr"></div>
          <div class="dup-warn" id="dupWarn" hidden></div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal('formModal')">取消</button>
      <button class="btn primary" id="saveBtn">${isEdit ? '保存并提交' : '提交申请'}</button>
    </div>
  `;
  $('#formModal').hidden = false;

  const zone = $('#uploadZone');
  const fileInput = $('#fileInput');
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  $('#fAmountInput').addEventListener('input', liveDupCheck);
  $('#fContentInput').addEventListener('input', liveDupCheck);
  $('#saveBtn').addEventListener('click', submitForm);
}

function showImgSrc(x) {
  // 编辑时若无新图，显示已有图
  return S.pendingImage || (x && x.imageUrl) ? `src="${esc(S.pendingImage || authImg(x.imageUrl))}"` : '';
}

function handleFile(file) {
  const mb = file.size / 1024 / 1024;
  if (!/^image\/(png|jpeg|jpg|gif|webp)/.test(file.type)) { setImageErr('请上传 PNG / JPG / GIF / WebP 图片'); return; }
  if (file.size > 10 * 1024 * 1024) { setImageErr('图片超过 10MB，请压缩后重试'); return; }
  setImageErr('');
  const reader = new FileReader();
  reader.onload = () => {
    S.pendingImage = reader.result;
    $('#upEmpty').style.display = 'none';
    const img = $('#upPrev'); img.src = S.pendingImage; img.style.display = 'block';
  };
  reader.readAsDataURL(file);
}
function setImageErr(m) { const e = $('#fImageErr'); if (e) e.textContent = m; }

function liveDupCheck() {
  const amount = Number($('#fAmountInput').value);
  const content = $('#fContentInput').value.trim();
  const box = $('#dupWarn');
  if (!box) return;
  if (!(amount > 0) || !content) { box.hidden = true; return; }
  const dup = S.items.filter(i => i.id !== S.editingId && activeStatuses.includes(i.status) &&
    Math.round(i.amount*100) === Math.round(amount*100) && i.invoiceContent.trim() === content);
  if (dup.length) {
    box.hidden = false;
    box.innerHTML = `⚠️ 检测到你可能已提交过相同发票（金额 <b>${money(dup[0].amount)}</b>、内容 <b>${esc(dup[0].invoiceContent)}</b>，状态${STATUS[dup[0].status].label}）。请确认是否为重复报销（可继续提交，或返回核对）。`;
  } else { box.hidden = true; }
}

async function submitForm() {
  const amount = Number($('#fAmountInput').value);
  const content = $('#fContentInput').value.trim();
  const reason = $('#fReasonInput').value.trim();
  let valid = true;
  setFieldErr('fAmount', amount > 0 ? '' : '请输入大于 0 的金额');
  if (!(amount > 0)) valid = false;
  setFieldErr('fContent', content ? '' : '请输入发票内容');
  if (!content) valid = false;
  setFieldErr('fReason', reason ? '' : '请填写申请事项');
  if (!reason) valid = false;
  const isEdit = !!S.editingId;
  if (!isEdit && !S.pendingImage) { setImageErr('请上传发票图片'); valid = false; }
  if (!valid) { toast('请完善申请信息', 'error'); return; }

  const body = { amount, invoiceContent: content, reason };
  if (S.pendingImage) body.invoiceImage = S.pendingImage;

  const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = '提交中…';
  const res = await api(isEdit ? 'PUT' : 'POST', isEdit ? `/api/reimbursements/${S.editingId}` : '/api/reimbursements', body);
  btn.disabled = false; btn.textContent = isEdit ? '保存并提交' : '提交申请';
  if (!res.ok) { toast(res.data.error || '提交失败', 'error'); return; }
  await closeModal('formModal');
  if (res.data.duplicates && res.data.duplicates.length) {
    toast('已提交，但检测到疑似重复报销，请留意', 'info');
  } else {
    toast(isEdit ? '已保存并提交' : '报销申请已提交', 'success');
  }
  S.pendingImage = null; S.editingId = null;
  loadData();
}

/* ============ 业务动作 ============ */
async function withdraw(id) {
  if (!confirm('确定撤回这笔报销申请吗？撤回后财务将无法审核。')) return;
  const res = await api('POST', `/api/reimbursements/${id}/withdraw`);
  if (!res.ok) { toast(res.data.error || '操作失败', 'error'); return; }
  toast('已撤回申请', 'info');
  loadData();
}
async function approve(id) {
  const res = await api('POST', `/api/reimbursements/${id}/approve`);
  if (!res.ok) { toast(res.data.error || '操作失败', 'error'); return; }
  toast('审核通过，已进入打款池', 'success');
  loadData();
}
async function pay(id) {
  if (!confirm('确认已线下打款完成？此操作不可撤销。')) return;
  const res = await api('POST', `/api/reimbursements/${id}/pay`);
  if (!res.ok) { toast(res.data.error || '操作失败', 'error'); return; }
  toast('打款完成 ✅', 'success');
  loadData();
}

/* ============ 弹窗控制 ============ */
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
  return Promise.resolve();
}
window.closeModal = closeModal;

function showImage(src) {
  $('#imageModalBody').innerHTML = `<img src="${esc(src)}" alt="发票" /><button class="close" onclick="closeModal('imageModal')">✕</button>`;
  $('#imageModal').hidden = false;
  $('#imageModalBody').addEventListener('click', (e) => { if (e.target === $('#imageModalBody').firstElementChild || e.target.classList.contains('close')) closeModal('imageModal'); });
}

/* 点击遮罩关闭 */
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-layer')) e.target.hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal-layer').forEach(m => m.hidden = true); });

/* ============ 管理后台（admin） ============ */
let ACCT_USERS = [];

function renderAdmin() {
  const box = $('#content');
  box.innerHTML = `
    <div class="page-head">
      <div><h2>${ROLE_CONF.admin.title}</h2><p class="desc">${ROLE_CONF.admin.desc}</p></div>
    </div>
    <div class="admin-nav">${ADMIN_SECTIONS.map(s => `<button class="admin-tab ${S.adminSection === s.id ? 'active' : ''}" data-s="${s.id}">${s.label}</button>`).join('')}</div>
    <div id="adminBody"></div>
  `;
  $('#content').querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => { S.adminSection = t.dataset.s; renderAdmin(); }));
  renderAdminSection();
}

function renderAdminSection() {
  const fns = { overview: renderAdminOverview, accounts: renderAdminAccounts, audit: renderAdminAudit, chat: renderAdminChat };
  (fns[S.adminSection] || renderAdminOverview)();
}

function renderAdminOverview() {
  $('#adminBody').innerHTML = renderStats() + `
    <div class="toolbar">
      <div class="tabs">${renderTabs(ROLE_CONF.admin.tabs)}</div>
      <div style="display:flex;gap:10px;align-items:center">
        <div class="search"><span>🔍</span><input id="adminSearch" placeholder="搜索内容 / 事项 / 姓名…" value="${esc(S.search)}" /></div>
        <button class="btn subtle btn-sm" id="exportBtn">导出 CSV</button>
      </div>
    </div>
    <div class="list" id="adminList"></div>
  `;
  $('#adminSearch').addEventListener('input', (e) => { S.search = e.target.value; renderAdminList(); });
  $('#exportBtn').addEventListener('click', () => downloadCsv('/api/admin/reimbursements.csv'));
  $('#adminBody').querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { S.filter = t.dataset.f; renderAdminOverview(); }));
  renderAdminList();
}

function renderAdminList() {
  const box = $('#adminList'); if (!box) return;
  const list = filteredItems();
  if (!list.length) { box.innerHTML = `<div class="empty"><div class="big">🗂️</div><div>${S.filter === 'all' ? '暂无报销申请' : '当前筛选下暂无申请'}</div></div>`; return; }
  box.innerHTML = list.map(renderItem).join('');
  box.querySelectorAll('.reimb').forEach(el => el.addEventListener('click', (e) => { if (e.target.closest('.btn')) return; openDetail(Number(el.dataset.id)); }));
}

async function renderAdminAccounts() {
  $('#adminBody').innerHTML = `<div class="skeleton" style="height:280px"></div>`;
  const { ok, data } = await api('GET', '/api/admin/users');
  if (!ok) { $('#adminBody').innerHTML = `<div class="empty">加载账号失败</div>`; return; }
  const items = data.items || []; ACCT_USERS = items;
  const activeCount = items.filter(u => u.active).length;
  $('#adminBody').innerHTML = `
    <div class="acct-toolbar">
      <div class="acct-count">账号总数 <b>${items.length}</b>　·　启用 <b>${activeCount}</b>　·　停用 <b>${items.length - activeCount}</b></div>
      <button class="btn primary btn-sm" id="addUserBtn">＋ 新增账号</button>
    </div>
    <div class="acct-table-wrap"><table class="acct-table">
      <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>
        ${items.map(u => `
          <tr data-id="${u.id}">
            <td><b>${esc(u.username)}</b></td>
            <td>${esc(u.name)}</td>
            <td><span class="role-badge">${ROLE_NAMES[u.role] || u.role}</span></td>
            <td>${u.active ? '<span class="badge paid"><span class="dot"></span>正常</span>' : '<span class="badge rejected"><span class="dot"></span>已停用</span>'}</td>
            <td class="muted">${fmtTime(u.created_at)}</td>
            <td class="acct-ops">
              <button class="btn ghost btn-sm" data-act="edit">编辑</button>
              <button class="btn subtle btn-sm" data-act="pwd">重置密码</button>
              <button class="btn ${u.active ? 'danger' : 'success'} btn-sm" data-act="toggle">${u.active ? '停用' : '启用'}</button>
              <button class="btn danger btn-sm" data-act="del">删除</button>
            </td>
          </tr>`).join('')}
      </tbody></table>
      ${items.length ? '' : '<div class="empty"><div class="big">👥</div><div>暂无账号</div></div>'}
    </div>
  `;
  $('#addUserBtn').addEventListener('click', () => openUserModal(null));
  $('#adminBody').querySelector('.acct-table tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    if (btn.dataset.act === 'edit') openUserModal(id);
    else if (btn.dataset.act === 'pwd') openPwdModal(id);
    else if (btn.dataset.act === 'toggle') toggleUser(id);
    else if (btn.dataset.act === 'del') deleteUser(id);
  });
}

function openUserModal(id) {
  const isEdit = !!id;
  const u = id ? ACCT_USERS.find(x => x.id === id) : null;
  const roles = [['employee', '员工'], ['finance', '财务审核'], ['cashier', '出纳'], ['admin', '管理员']];
  $('#userModalBody').innerHTML = `
    <div class="modal-head"><h3>${isEdit ? '编辑账号' : '新增账号'}</h3><button class="close" onclick="closeModal('userModal')">✕</button></div>
    <div class="modal-body">
      <div class="field" id="um_u"><label>账号（登录名）</label><input id="umUser" ${isEdit ? 'disabled' : ''} value="${esc(u ? u.username : '')}" placeholder="至少3位，仅字母/数字/_ . -" /><div class="err"></div></div>
      <div class="field" id="um_n"><label>姓名</label><input id="umName" value="${esc(u ? u.name : '')}" placeholder="请输入姓名" /><div class="err"></div></div>
      <div class="field" id="um_r"><label>角色</label><select id="umRole">${roles.map(([v, l]) => `<option value="${v}" ${u && u.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select><div class="err"></div></div>
      ${isEdit ? '' : '<div class="field" id="um_p"><label>初始密码</label><input id="umPass" type="password" placeholder="至少 6 位" /><div class="err"></div></div>'}
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal('userModal')">取消</button><button class="btn primary" id="umSave">${isEdit ? '保存' : '创建'}</button></div>
  `;
  $('#userModal').hidden = false;
  $('#umSave').addEventListener('click', async () => {
    const name = $('#umName').value.trim(), role = $('#umRole').value;
    let valid = true;
    setFieldErr('um_n', name ? '' : '请输入姓名'); if (!name) valid = false;
    if (!isEdit) {
      const username = $('#umUser').value.trim(), pw = $('#umPass').value;
      const uok = username.length >= 3 && /^[A-Za-z0-9_.-]+$/.test(username);
      setFieldErr('um_u', uok ? '' : '至少3位，仅限字母/数字/_ . -'); if (!uok) valid = false;
      setFieldErr('um_p', pw.length >= 6 ? '' : '密码至少 6 位'); if (pw.length < 6) valid = false;
    }
    if (!valid) { toast('请完善信息', 'error'); return; }
    const btn = $('#umSave'); btn.disabled = true;
    const body = isEdit ? { name, role } : { username: $('#umUser').value.trim(), name, role, password: $('#umPass').value };
    const res = await api(isEdit ? 'PUT' : 'POST', isEdit ? `/api/admin/users/${id}` : '/api/admin/users', body);
    btn.disabled = false;
    if (!res.ok) { toast(res.data.error || '保存失败', 'error'); return; }
    await closeModal('userModal');
    toast(isEdit ? '账号已更新' : '账号已创建', 'success');
    renderAdminAccounts();
  });
}

function openPwdModal(id) {
  const u = ACCT_USERS.find(x => x.id === id);
  $('#userModalBody').innerHTML = `
    <div class="modal-head"><h3>重置密码</h3><button class="close" onclick="closeModal('userModal')">✕</button></div>
    <div class="modal-body">
      <p style="margin:0 0 12px;color:var(--ink-soft);font-size:13px">为账号 <b>${esc(u ? u.username : '')}</b>（${esc(u ? u.name : '')}）设置新密码，重置后其所有登录会话将失效。</p>
      <div class="field" id="pm_p"><label>新密码</label><input id="pmPass" type="password" placeholder="至少 6 位" /><div class="err"></div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal('userModal')">取消</button><button class="btn primary" id="pmSave">确认重置</button></div>
  `;
  $('#userModal').hidden = false;
  $('#pmSave').addEventListener('click', async () => {
    const p = $('#pmPass').value;
    setFieldErr('pm_p', p.length >= 6 ? '' : '密码至少 6 位'); if (p.length < 6) return;
    const btn = $('#pmSave'); btn.disabled = true;
    const res = await api('POST', `/api/admin/users/${id}/password`, { password: p });
    btn.disabled = false;
    if (!res.ok) { toast(res.data.error || '重置失败', 'error'); return; }
    await closeModal('userModal'); toast('密码已重置，该账号旧会话已失效', 'success'); renderAdminAccounts();
  });
}

async function toggleUser(id) {
  const u = ACCT_USERS.find(x => x.id === id); if (!u) return;
  const verb = u.active ? '停用' : '启用';
  if (!confirm(`确定${verb}账号「${u.name}」吗？${u.active ? '停用后该账号将无法登录，会话会被强制退出。' : ''}`)) return;
  const res = await api('POST', `/api/admin/users/${id}/toggle`);
  if (!res.ok) { toast(res.data.error || '操作失败', 'error'); return; }
  toast(`已${verb}账号`, 'success'); renderAdminAccounts();
}
async function deleteUser(id) {
  const u = ACCT_USERS.find(x => x.id === id); if (!u) return;
  if (!confirm(`确定删除账号「${u.name}」吗？该账号的报销与相关记录将一并删除，不可恢复。`)) return;
  const res = await api('DELETE', `/api/admin/users/${id}`);
  if (!res.ok) { toast(res.data.error || '删除失败', 'error'); return; }
  toast('账号已删除', 'success'); renderAdminAccounts();
}

async function renderAdminAudit() {
  $('#adminBody').innerHTML = `<div class="skeleton" style="height:280px"></div>`;
  const { ok, data } = await api('GET', '/api/admin/audit');
  if (!ok) { $('#adminBody').innerHTML = `<div class="empty">加载审计失败</div>`; return; }
  const operators = data.operators || [];
  const acts = Object.keys(AUDIT_ACTION_LABELS);
  $('#adminBody').innerHTML = `
    <div class="audit-bar">
      <select id="audOp"><option value="all">全部操作人</option>${operators.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
      <select id="audAct"><option value="all">全部动作</option>${acts.map(a => `<option value="${a}">${AUDIT_ACTION_LABELS[a]}</option>`).join('')}</select>
      <span class="muted" id="audCount">共 ${data.items.length} 条</span>
    </div>
    <div class="audit-list" id="auditList"></div>
  `;
  $('#audOp').addEventListener('change', loadAudit);
  $('#audAct').addEventListener('change', loadAudit);
  renderAuditList(data.items);
}
function renderAuditList(items) {
  const box = $('#auditList'); if (!box) return;
  if (!items.length) { box.innerHTML = `<div class="empty"><div class="big">📋</div><div>暂无操作记录</div></div>`; return; }
  box.innerHTML = items.map(i => `
    <div class="audit-item">
      <div class="audit-time">${fmtTime(i.time)}</div>
      <div class="audit-mid">
        <div class="audit-line"><span class="badge ${AUDIT_BADGE[i.action] || 'gray'}"><span class="dot"></span>${AUDIT_ACTION_LABELS[i.action] || i.action}</span>
          <b>${esc(i.operatorName)}</b>${i.target ? ` <span class="muted">→ ${esc(i.target)}</span>` : ''}</div>
        <div class="audit-detail">${esc(i.detail || '')}</div>
      </div>
    </div>`).join('');
}
async function loadAudit() {
  const op = $('#audOp').value, ac = $('#audAct').value;
  const q = new URLSearchParams();
  if (op !== 'all') q.set('operator', op);
  if (ac !== 'all') q.set('action', ac);
  const { data } = await api('GET', '/api/admin/audit?' + q.toString());
  const cnt = $('#audCount'); if (cnt) cnt.textContent = `共 ${data.items.length} 条`;
  renderAuditList(data.items);
}

async function renderAdminChat() {
  const { ok, data } = await api('GET', '/api/admin/chat/config');
  const configured = !!(ok && data.configured);
  const model = ok ? data.model : '';
  $('#adminBody').innerHTML = `
    <div class="chat-wrap">
      <div class="chat-panel">
        <div class="chat-head">
          <span class="chat-title">💬 智能问答</span>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="chat-meta">${configured ? '已连接 ' + esc(model) : '未配置 DeepSeek Key'}</span>
            <button class="btn ghost btn-sm" id="chatCfgBtn">⚙ 配置</button>
          </div>
        </div>
        <div class="chat-body" id="chatBody"></div>
        ${configured ? `
        <div class="chat-input">
          <textarea id="chatInput" rows="2" placeholder="请问报销数据、系统运行情况…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button class="btn primary" id="chatSend">发送</button>
        </div>` : `<div class="chat-empty">尚未配置 DeepSeek API Key，暂时无法对话。<button class="btn subtle btn-sm" id="chatCfgEmpty" style="margin-left:8px">去配置</button></div>`}
      </div>
    </div>
  `;
  const cfgBtn = $('#chatCfgBtn'); if (cfgBtn) cfgBtn.addEventListener('click', () => openChatConfig());
  const cfgEmpty = $('#chatCfgEmpty'); if (cfgEmpty) cfgEmpty.addEventListener('click', () => openChatConfig());
  if (!configured) return;

  const body = $('#chatBody'), input = $('#chatInput'), send = $('#chatSend');
  const history = [];
  const addMsg = (role, text) => {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
    div.innerHTML = `<div class="chat-bubble">${esc(text)}</div>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  };
  addMsg('bot', '您好，我是报销云管理员智能助手。可以问我：现在有多少待审核报销？最近谁做了什么操作？报销单 #6 的流程？系统运行得怎么样？');
  const sendMsg = () => {
    const text = input.value.trim(); if (!text) return;
    input.value = '';
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    send.disabled = true;
    const loading = document.createElement('div');
    loading.className = 'chat-msg bot';
    loading.innerHTML = `<div class="chat-bubble typing">思考中…</div>`;
    body.appendChild(loading); body.scrollTop = body.scrollHeight;
    api('POST', '/api/admin/chat', { messages: history })
      .then(({ data }) => {
        loading.remove();
        const reply = (data && data.reply) || (data && data.error) || '（无回复）';
        addMsg('bot', reply);
        history.push({ role: 'assistant', content: reply });
      })
      .catch(() => { loading.remove(); addMsg('bot', '请求失败，请稍后重试。'); })
      .finally(() => { send.disabled = false; input.focus(); });
  };
  send.addEventListener('click', sendMsg);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  input.focus();
}

async function openChatConfig() {
  const cfg = await api('GET', '/api/admin/chat/config');
  const cur = cfg.data || {};
  const configured = !!(cfg.ok && cur.configured);
  $('#chatConfigModalBody').innerHTML = `
    <div class="modal-head"><h3>⚙ 对话配置</h3><button class="close" onclick="closeModal('chatConfigModal')">✕</button></div>
    <div class="modal-body">
      <p style="margin:0 0 12px;color:var(--ink-soft);font-size:13px">这项配置管理「智能问答」所连接的 DeepSeek 模型。密钥仅保存在服务端，不会回显。${configured ? ' 当前<b>已配置</b>（模型：' + esc(cur.model) + '、接口：' + esc(cur.baseUrl) + '），密钥框留空则保持不变。' : ' 当前<b>未配置</b>。'}</p>
      <div class="field" id="cc_k"><label>API Key（DeepSeek）</label><input id="ccKey" type="password" placeholder="${configured ? '已配置，输入新值可覆盖' : 'sk-...'}" autocomplete="off" /><div class="err"></div></div>
      <div class="field"><label>模型</label><input id="ccModel" value="${esc(cur.model || 'deepseek-v4-flash-vision-exp')}" placeholder="deepseek-v4-flash-vision-exp" /></div>
      <div class="field"><label>接口地址 Base URL</label><input id="ccBase" value="${esc(cur.baseUrl || 'https://api.deepseek.com')}" placeholder="https://api.deepseek.com" /></div>
      <div class="field"><label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" id="ccClear" ${configured ? '' : 'disabled'} /> 清空当前密钥（恢复未配置）</label></div>
      <div class="dup-warn" id="ccMsg" style="display:none"></div>
    </div>
    <div class="modal-foot" style="justify-content:space-between">
      <span style="font-size:12px;color:var(--ink-faint)">保存后立即生效，无需重启。</span>
      <div style="display:flex;gap:10px">
        <button class="btn ghost" id="ccTest">测试连接</button>
        <button class="btn ghost" onclick="closeModal('chatConfigModal')">取消</button>
        <button class="btn primary" id="ccSave">保存</button>
      </div>
    </div>
  `;
  $('#chatConfigModal').hidden = false;
  const keyInput = $('#ccKey'), model = $('#ccModel'), base = $('#ccBase');
  const msg = $('#ccMsg');
  const showMsg = (text, ok) => {
    msg.style.display = 'block';
    msg.style.background = ok ? 'var(--green-soft)' : 'var(--red-soft)';
    msg.style.color = ok ? 'var(--green-ink)' : 'var(--red-ink)';
    msg.style.borderColor = 'transparent';
    msg.innerHTML = (ok ? '✅ ' : '⚠️ ') + text;
  };
  $('#ccTest').addEventListener('click', async () => {
    const btn = $('#ccTest'); btn.disabled = true; btn.textContent = '测试中…';
    const res = await api('POST', '/api/admin/chat/config/test', { apiKey: keyInput.value.trim() || undefined, model: model.value.trim() || undefined, baseUrl: base.value.trim() || undefined });
    btn.disabled = false; btn.textContent = '测试连接';
    if (res.ok) showMsg(res.data.message || '连接成功', true);
    else showMsg(res.data.error || '连接失败', false);
  });
  $('#ccSave').addEventListener('click', async () => {
    const body = { model: model.value.trim(), baseUrl: base.value.trim() };
    if ($('#ccClear').checked) body.apiKey = '';
    else if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
    const res = await api('POST', '/api/admin/chat/config', body);
    if (!res.ok) { showMsg(res.data.error || '保存失败', false); return; }
    await closeModal('chatConfigModal');
    toast('对话配置已保存', 'success');
    renderAdminChat();
  });
}

function downloadCsv(path) {
  fetch(path, { headers: { Authorization: 'Bearer ' + S.token } })
    .then(r => { if (!r.ok) throw new Error('导出失败'); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'reimbursements.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })
    .catch(e => toast(e.message || '导出失败', 'error'));
}

/* ============ 启动 ============ */
(async function init() {
  if (!S.token || !S.user) { renderLogin(); return; }
  const res = await api('GET', '/api/me');
  if (res.ok && res.data.user) { S.user = res.data.user; localStorage.setItem('rm_user', JSON.stringify(S.user)); enterApp(); }
  else renderLogin();
})();
