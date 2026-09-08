#!/usr/bin/env node
'use strict';
/*
  报销云 · 管理端只读查询脚本
  供 DSH「管理员智能助手」预设的 shell 工具调用，只读，不改动任何数据。
  用法：node admin-query.js <subcommand> [args]
*/

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'data', 'reimburse.db');
const SERVER_URL = 'http://127.0.0.1:3300';

const STATUS_LABELS = { pending: '待审核', approved: '已通过', paid: '已打款', rejected: '已驳回', withdrawn: '已撤回' };
const ROLE_LABELS = { employee: '员工', finance: '财务', cashier: '出纳', admin: '管理员' };
const ACTION_LABELS = {
  login: '登录', login_fail: '登录失败', login_blocked: '登录被阻止',
  user_create: '创建账号', user_update: '更新账号', user_password: '重置密码',
  user_toggle: '启用/停用账号', user_delete: '删除账号',
  submit: '提交报销', update: '修改报销', resubmit: '重新提交', withdraw: '撤回报销',
  approve: '审核通过', reject: '审核驳回', pay: '打款',
};

function openDb() {
  if (!fs.existsSync(DB_PATH)) throw new Error('未找到数据库 ' + DB_PATH + '。请先启动报销系统（node server.js）并完成初始化。');
  return new DatabaseSync(DB_PATH, { readOnly: true });
}
function money(n) { return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmt(iso) { if (!iso) return '--'; const d = new Date(iso); return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function cmdSummary(db) {
  const st = db.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(amount),0) s FROM reimbursements GROUP BY status').all();
  const total = st.reduce((a, r) => a + r.n, 0);
  const out = ['【报销总额】共 ' + total + ' 笔'];
  for (const r of st) out.push('  ' + (STATUS_LABELS[r.status] || r.status) + ': ' + r.n + ' 笔 · ' + money(r.s));
  const users = db.prepare('SELECT role, COUNT(*) n, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) a FROM users GROUP BY role').all();
  out.push('【账号】');
  for (const r of users) out.push('  ' + (ROLE_LABELS[r.role] || r.role) + ': ' + r.n + '（启用 ' + r.a + '）');
  out.push('  合计 ' + users.reduce((a, r) => a + r.n, 0));
  return out.join('\n');
}

function cmdReimb(db, args) {
  const status = (args[0] || 'all').toLowerCase();
  const limit = Math.max(parseInt(args[1] || '20', 10) || 20, 1);
  let sql = 'SELECT r.id, u.name applicant, r.amount, r.invoice_content, r.reason, r.status, r.created_at FROM reimbursements r JOIN users u ON u.id=r.applicant_id';
  const params = [];
  if (status !== 'all') { sql += ' WHERE r.status=?'; params.push(status); }
  sql += ' ORDER BY r.id DESC LIMIT ?'; params.push(limit);
  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return '没有符合条件的报销记录。';
  const out = ['【报销列表】' + (status === 'all' ? '' : '（' + (STATUS_LABELS[status] || status) + '）')];
  for (const r of rows) out.push('#' + r.id + ' ' + money(r.amount) + ' ' + r.invoice_content + ' [' + (STATUS_LABELS[r.status] || r.status) + '] ' + r.applicant + ' ' + fmt(r.created_at));
  return out.join('\n');
}

function cmdDetail(db, args) {
  const id = parseInt(args[0], 10); if (!id) return '请提供报销单 ID，如：detail 4';
  const r = db.prepare('SELECT r.*, u.name applicant FROM reimbursements r JOIN users u ON u.id=r.applicant_id WHERE r.id=?').get(id);
  if (!r) return '未找到报销单 #' + id;
  const hist = db.prepare('SELECT * FROM history WHERE reimbursement_id=? ORDER BY id ASC').all(id);
  const out = [];
  out.push('【报销单 #' + id + '】');
  out.push(' 申请人：' + r.applicant);
  out.push(' 金额：' + money(r.amount));
  out.push(' 发票内容：' + r.invoice_content);
  out.push(' 申请事项：' + r.reason);
  out.push(' 状态：' + (STATUS_LABELS[r.status] || r.status));
  out.push(' 提交：' + fmt(r.created_at) + '　更新：' + fmt(r.updated_at));
  out.push(' 流程记录：');
  for (const h of hist) out.push('   ' + fmt(h.created_at) + ' ' + (ACTION_LABELS[h.action] || h.action) + ' · ' + h.operator_name + (h.note ? ' · ' + h.note : ''));
  return out.join('\n');
}

function cmdAccounts(db) {
  const rows = db.prepare('SELECT username, name, role, active, created_at FROM users ORDER BY id').all();
  if (!rows.length) return '暂无账号。';
  const out = ['【账号列表】'];
  for (const u of rows) out.push(u.username + ' ' + u.name + ' [' + (ROLE_LABELS[u.role] || u.role) + '] ' + (u.active ? '正常' : '已停用') + ' ' + fmt(u.created_at));
  return out.join('\n');
}

function cmdAudit(db, args) {
  const limit = Math.max(parseInt(args[0] || '15', 10) || 15, 1);
  const logs = db.prepare('SELECT action, operator_name, target, detail, created_at FROM audit_logs').all();
  const hist = db.prepare('SELECT h.action, h.operator_name, h.note, h.created_at, r.id reimb_id FROM history h LEFT JOIN reimbursements r ON r.id=h.reimbursement_id').all();
  const items = [];
  for (const l of logs) items.push({ t: l.created_at, action: l.action, op: l.operator_name, target: l.target || '', detail: l.detail || '' });
  for (const h of hist) items.push({ t: h.created_at, action: h.action, op: h.operator_name, target: h.reimb_id ? ('报销 #' + h.reimb_id) : '', detail: h.note || '' });
  items.sort((a, b) => (a.t < b.t ? 1 : -1));
  if (!items.length) return '暂无审计记录。';
  const out = ['【最近操作】'];
  for (const r of items.slice(0, limit)) out.push(fmt(r.t) + ' ' + (ACTION_LABELS[r.action] || r.action) + ' · ' + r.op + (r.target ? ' → ' + r.target : '') + (r.detail ? ' · ' + r.detail : ''));
  return out.join('\n');
}

function cmdSearch(db, args) {
  const q = (args.join(' ') || '').trim(); if (!q) return '请提供关键词，如：search 高铁';
  const rows = db.prepare("SELECT r.id, u.name applicant, r.amount, r.invoice_content, r.reason, r.status, r.created_at FROM reimbursements r JOIN users u ON u.id=r.applicant_id WHERE (r.invoice_content LIKE ? OR r.reason LIKE ? OR u.name LIKE ?) ORDER BY r.id DESC LIMIT 20").all('%' + q + '%', '%' + q + '%', '%' + q + '%');
  if (!rows.length) return '未找到匹配记录。';
  const out = ['【搜索：' + q + '】'];
  for (const r of rows) out.push('#' + r.id + ' ' + money(r.amount) + ' ' + r.invoice_content + ' [' + (STATUS_LABELS[r.status] || r.status) + '] ' + r.applicant);
  return out.join('\n');
}

async function cmdStatus(db) {
  const out = ['【系统运行情况】'];
  if (!db) { out.push(' 数据库：不存在（' + DB_PATH + '）'); out.push(' 请先启动报销系统（node server.js）完成初始化。'); try { await pingServer(s => out.push(' 报销服务：' + s)); } catch {} return out.join('\n'); }
  let size = 0; try { size = fs.statSync(DB_PATH).size; } catch {}
  out.push(' 数据库：存在（' + (size / 1024).toFixed(1) + ' KB）');
  const u = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) a FROM users').get();
  out.push(' 账号：' + u.n + '（启用 ' + u.a + '）');
  const rec = db.prepare('SELECT COUNT(*) n FROM reimbursements').get();
  out.push(' 报销单：' + rec.n);
  const last = db.prepare('SELECT MAX(created_at) m FROM reimbursements').get().m;
  out.push(' 最近报销：' + (last ? fmt(last) : '无'));
  const lastA = db.prepare('SELECT MAX(created_at) m FROM audit_logs').get().m;
  out.push(' 最近操作：' + (lastA ? fmt(lastA) : '无'));
  try { await pingServer(s => out.push(' 报销服务：' + s)); } catch {}
  return out.join('\n');
}

function pingServer(push) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    fetch(SERVER_URL + '/', { signal: ctrl.signal })
      .then(r => { clearTimeout(t); push(r.ok ? '在线' : '响应异常(' + r.status + ')'); resolve(); })
      .catch(() => { clearTimeout(t); push('无响应（或尚未启动）'); resolve(); });
  });
}

function usage() {
  return [
    '报销云管理端只读查询。用法：node admin-query.js <subcommand> [args]',
    '  summary         报销/账号汇总统计',
    '  reimb [status|all] [n]   报销列表（默认全部，最多 n 条）',
    '  detail <id>     单笔报销详情 + 流程记录',
    '  accounts        账号列表',
    '  audit [n]       最近操作审计（n 条）',
    '  search <词>     按内容/事项/申请人搜索报销',
    '  status          系统运行情况',
  ].join('\n');
}

const args = process.argv.slice(2);
const cmd = (args.shift() || '').trim().toLowerCase();

(async () => {
  let db = null;
  try { db = openDb(); } catch (e) { if (cmd !== 'status') { console.log('错误：' + e.message); process.exit(1); } }
  try {
    let out;
    switch (cmd) {
      case 'summary': out = cmdSummary(db); break;
      case 'reimb': out = cmdReimb(db, args); break;
      case 'detail': out = cmdDetail(db, args); break;
      case 'accounts': out = cmdAccounts(db); break;
      case 'audit': out = cmdAudit(db, args); break;
      case 'search': out = cmdSearch(db, args); break;
      case 'status': out = await cmdStatus(db); break;
      default: out = usage();
    }
    console.log(out);
    if (db) db.close();
  } catch (e) {
    console.log('错误：' + e.message);
    process.exitCode = 1;
  }
})();
