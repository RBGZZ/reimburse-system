'use strict';

/*
  财务报销管理系统 — 后端（纯 Node 内置模块，无第三方依赖）
  数据层：node:sqlite（Node >= 22.5 内置）
  认证：scrypt 密码散列 + Bearer token 会话
*/

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 3300;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'reimburse.db');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_AMOUNT = 10000000; // 单笔上限，防止误填
const BODY_LIMIT = 15 * 1024 * 1024;

for (const d of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- 配置（DeepSeek 密钥等，均配置化，不写死） ---------------- */
function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || String(file.deepseekApiKey || '').trim(),
    model: process.env.DEEPSEEK_MODEL || String(file.deepseekModel || 'deepseek-v4-flash-vision-exp').trim(),
    baseUrl: (process.env.DEEPSEEK_BASE_URL || String(file.deepseekBaseUrl || 'https://api.deepseek.com')).replace(/\/+$/, ''),
    seedDemoData: String(process.env.DEEPSEEK_SEED_DEMO ?? '').toLowerCase() === '0' ? false : (file.seedDemoData !== false),
  };
}
let CONFIG = loadConfig();
function persistConfig(next) {
  CONFIG = { ...CONFIG, ...next };
  // 只覆盖用户想改的字段；env 优先级更高，重启后仍以 env 为准（若设置了 env）
  try {
    fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
      deepseekApiKey: CONFIG.apiKey,
      deepseekModel: CONFIG.model,
      deepseekBaseUrl: CONFIG.baseUrl,
    }, null, 2));
  } catch {}
}

/* ---------------- 数据库 ---------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('employee','finance','cashier','admin')),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reimbursements (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount         REAL NOT NULL,
    invoice_content TEXT NOT NULL,
    reason         TEXT NOT NULL,
    invoice_image  TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','paid','withdrawn')),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    reimbursement_id INTEGER NOT NULL REFERENCES reimbursements(id) ON DELETE CASCADE,
    action           TEXT NOT NULL,
    operator_id      INTEGER REFERENCES users(id),
    operator_name    TEXT NOT NULL,
    note             TEXT,
    created_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action        TEXT NOT NULL,
    operator_id   INTEGER REFERENCES users(id),
    operator_name TEXT NOT NULL,
    target        TEXT,
    detail        TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reimb_applicant ON reimbursements(applicant_id);
  CREATE INDEX IF NOT EXISTS idx_reimb_status   ON reimbursements(status);
  CREATE INDEX IF NOT EXISTS idx_hist_reimb     ON history(reimbursement_id);
  CREATE INDEX IF NOT EXISTS idx_audit_time     ON audit_logs(created_at);
`);

/* ---------------- 迁移：为旧库升级 users 表（新增 admin 角色与账号状态） ---------------- */
function migrateSchema() {
  const usersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
  const hasActive = db.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === 'active');
  const needs = !usersSql || !usersSql.sql.includes("'admin'") || !hasActive;
  if (!needs) return;
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('employee','finance','cashier','admin')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT
    );
    INSERT INTO users_new (id, username, password_hash, salt, name, role, active, created_at)
      SELECT id, username, password_hash, salt, name, role, 1, datetime('now') FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA foreign_key_check;');
  console.log('[migrate] users 表已升级（新增 admin 角色、账号启用状态与创建时间）');
}
migrateSchema();

/* ---------------- 工具 ---------------- */
function nowISO() { return new Date().toISOString(); }
function hashPassword(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function minutesAgoISO(m) { return new Date(Date.now() - m * 60000).toISOString(); }

/* ---- 简易 PNG 生成（用于生成演示发票占位图） ---- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0, 0);
  return Buffer.concat([len, tb, data, crc]);
}
function makePng(w, h, rowFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { const c = rowFn(x, y); raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2]; } }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function demoInvoiceColor(accent) {
  const W = 160, H = 220, bg = [249, 250, 252], line = [186, 194, 214];
  const hd = accent;
  const textRows = [60, 72, 84, 96, 122, 134, 146, 182];
  return makePng(W, H, (x, y) => {
    if (y < 42) return hd;
    for (const ty of textRows) if (y >= ty && y < ty + 4 && x > 24 && x < W - 24) return line;
    return bg;
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '发票金额必须为大于 0 的数值');
  if (v > MAX_AMOUNT) throw new HttpError(400, `单笔金额不能超过 ${MAX_AMOUNT.toLocaleString()} 元`);
  return Math.round(v * 100) / 100;
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active };
}

/* 图片魔数校验 */
const IMAGE_SIGS = [
  { type: 'image/png',  bytes: [0x89, 0x50, 0x4e, 0x47], ext: 'png' },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff],        ext: 'jpg' },
  { type: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38],  ext: 'gif' },
];
function detectImage(buf) {
  for (const s of IMAGE_SIGS) {
    if (buf.length >= s.bytes.length && s.bytes.every((b, i) => buf[i] === b)) return s;
  }
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return { type: 'image/webp', ext: 'webp' };
  return null;
}

/* 解码前端上传的 base64 data URL 图片并保存到磁盘，返回 URL 路径 */
function saveUploadedImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || '').trim());
  if (!m) throw new HttpError(400, '未识别有效的图片文件，请上传 PNG/JPG/GIF/WebP 图片');
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (buf.length === 0) throw new HttpError(400, '图片内容为空');
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(400, '图片过大（超过 10MB），请压缩后重试');
  const sig = detectImage(buf);
  if (!sig) throw new HttpError(400, '图片内容不合法，请上传真实的图片文件');
  const name = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${sig.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

/* 读取 JSON 请求体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      len += c.length;
      if (len > BODY_LIMIT) { done = true; reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const s = Buffer.concat(chunks).toString('utf8').trim();
        resolve(s ? JSON.parse(s) : {});
      } catch { reject(new HttpError(400, '请求体不是有效的 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 种子数据 ---------------- */
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const ins = db.prepare(
    'INSERT INTO users (username, password_hash, salt, name, role, active, created_at) VALUES (?,?,?,?,?,1,?)'
  );
  const mk = (username, password, name, role) => {
    const salt = randomToken();
    ins.run(username, hashPassword(password, salt), salt, name, role, nowISO());
  };
  mk('zhangwei', '123456', '张伟', 'employee');   // 员工 A
  mk('lina', '123456', '李娜', 'employee');       // 员工 B
  mk('finance', '123456', '王晓财务', 'finance'); // 财务审核
  mk('cashier', '123456', '赵出纳', 'cashier');   // 出纳
  mk('admin', '123456', '系统管理员', 'admin');     // 管理员（运维/管理层）
  console.log('[seed] 已创建演示账号：employees=zhangwei/lina, finance, cashier, admin (密码均为 123456)');
}
seed();

/* 确保至少存在一个管理员账号（旧库迁移后补建） */
function ensureAdmin() {
  const has = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
  if (has > 0) return;
  const salt = randomToken();
  db.prepare('INSERT INTO users (username, password_hash, salt, name, role, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .run('admin', hashPassword('123456', salt), salt, '系统管理员', 'admin', nowISO());
  console.log('[seed] 已补建管理员账号 admin（密码 123456）');
}
ensureAdmin();

/* 演示业务数据（仅在报销单为空时注入，方便直接演示） */
function seedDemo() {
  if (CONFIG.seedDemoData === false) return;
  if (db.prepare('SELECT COUNT(*) AS n FROM reimbursements').get().n > 0) return;
  const uid = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  const ZW = uid('zhangwei'), LN = uid('lina'), FIN = uid('finance'), CAS = uid('cashier');
  const nz = { '张伟': ZW, '李娜': LN, '王晓财务': FIN, '赵出纳': CAS };

  const ins = (applicant, amount, content, reason, status, color, ops) => {
    const imgName = `demo_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
    fs.writeFileSync(path.join(UPLOAD_DIR, imgName), demoInvoiceColor(color));
    const imgUrl = '/uploads/' + imgName;
    const submitAt = ops[0].at;
    const ts = ops[ops.length - 1].at;
    const id = db.prepare(
      `INSERT INTO reimbursements (applicant_id, amount, invoice_content, reason, invoice_image, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(applicant, amount, content, reason, imgUrl, status, submitAt, ts).lastInsertRowid;
    for (const o of ops) {
      db.prepare(
        'INSERT INTO history (reimbursement_id, action, operator_id, operator_name, note, created_at) VALUES (?,?,?,?,?,?)'
      ).run(id, o.a, nz[o.who], o.who, o.note || null, o.at);
    }
    return id;
  };

  // 员工 张伟
  ins(ZW, 580.5, '上海出差高铁票', '赴上海客户现场支持，往返高铁', 'approved', [79,107,255], [
    { a: 'submit', who: '张伟', at: minutesAgoISO(60 * 30) },
    { a: 'approve', who: '王晓财务', at: minutesAgoISO(60 * 26), note: '票据齐全，符合差旅标准' },
  ]);
  ins(ZW, 128, '办公用品打印纸', '采购 A4 打印纸两箱', 'paid', [34,160,107], [
    { a: 'submit', who: '张伟', at: minutesAgoISO(60 * 50) },
    { a: 'approve', who: '王晓财务', at: minutesAgoISO(60 * 44) },
    { a: 'pay', who: '赵出纳', at: minutesAgoISO(60 * 30), note: '已对公转账' },
  ]);
  ins(ZW, 245, '客户接待餐费', '接待来访客户工作餐', 'rejected', [229,72,77], [
    { a: 'submit', who: '张伟', at: minutesAgoISO(60 * 20) },
    { a: 'reject', who: '王晓财务', at: minutesAgoISO(60 * 8), note: '发票抬头不符，请开具公司抬头的发票后重新提交' },
  ]);
  ins(ZW, 86, '市内打车费', '夜间临时加班返程打车', 'withdrawn', [138,147,166], [
    { a: 'submit', who: '张伟', at: minutesAgoISO(60 * 70) },
    { a: 'withdraw', who: '张伟', at: minutesAgoISO(60 * 66), note: '重复提交，撤回' },
  ]);
  // 员工 李娜（待审核，供财务演示）
  ins(LN, 199, '办公电话费', '业务备用号码月度话费', 'pending', [79,107,255], [
    { a: 'submit', who: '李娜', at: minutesAgoISO(60 * 5) },
  ]);
  ins(LN, 1520, '客户拜访机票', '赴广州拜访客户往返机票', 'pending', [79,107,255], [
    { a: 'submit', who: '李娜', at: minutesAgoISO(60 * 2) },
  ]);
  console.log('[seed] 已注入 6 条演示报销单（含多种状态）');
}
seedDemo();

/* ---------------- 认证 ---------------- */
function authRequired(req, roles) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-auth-token'] || '');
  if (!token) throw new HttpError(401, '未登录');
  const row = db.prepare(
    'SELECT s.token, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token);
  if (!row) throw new HttpError(401, '登录已过期，请重新登录');
  if (row.active === 0) throw new HttpError(403, '账号已停用，请联系管理员');
  if (roles && !roles.includes(row.role)) throw new HttpError(403, '无权进行该操作');
  return row;
}

function requireAdmin(req) { return authRequired(req, ['admin']); }

/* 记录系统/账号级操作日志（报销流程发生的事件仍记录在 history 表） */
function logAudit(action, operator, target, detail) {
  db.prepare(
    'INSERT INTO audit_logs (action, operator_id, operator_name, target, detail, created_at) VALUES (?,?,?,?,?,?)'
  ).run(action, operator ? operator.id : null, operator ? operator.name : '系统',
    target == null ? null : String(target), detail == null ? null : String(detail), nowISO());
}

function activeAdminCount(excludeId) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1`).get();
  return row.n - (excludeId ? (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id=?`).get(excludeId).n || 0) : 0);
}

/* ---------------- 业务 helper ---------------- */
function addHistory(reimbId, action, operatorId, operatorName, note) {
  db.prepare(
    'INSERT INTO history (reimbursement_id, action, operator_id, operator_name, note, created_at) VALUES (?,?,?,?,?,?)'
  ).run(reimbId, action, operatorId, operatorName, note == null ? null : String(note), nowISO());
}

function toSummary(r) {
  const applicant = db.prepare('SELECT id, name FROM users WHERE id = ?').get(r.applicant_id);
  return {
    id: r.id,
    applicant: applicant ? { id: applicant.id, name: applicant.name } : null,
    amount: r.amount,
    invoiceContent: r.invoice_content,
    reason: r.reason,
    imageUrl: r.invoice_image,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDetail(r) {
  const history = db.prepare(
    'SELECT * FROM history WHERE reimbursement_id = ? ORDER BY id ASC'
  ).all(r.id);
  return { ...toSummary(r), history };
}

function getReimb(id) {
  const r = db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, '报销申请不存在');
  return r;
}

/* 重复提交检测：同一申请人、同金额、同发票内容，且处于进行中（待审核或已通过） */
function findDuplicates(applicantId, amount, invoiceContent) {
  return db.prepare(
    `SELECT id, amount, status, created_at AS createdAt
       FROM reimbursements
      WHERE applicant_id = ? AND status IN ('pending','approved')
        AND ROUND(amount,2) = ROUND(?,2)
        AND TRIM(invoice_content) = TRIM(?)
      ORDER BY id DESC`
  ).all(applicantId, amount, invoiceContent);
}

/* 对列表按状态过滤 + 角色权限过滤 */
function listReimbursements(user, statusFilter) {
  let rows;
  if (user.role === 'employee') {
    rows = db.prepare('SELECT * FROM reimbursements WHERE applicant_id = ?').all(user.id);
  } else if (user.role === 'finance') {
    // 财务：排除「已撤回」（已撤回不可再审核）
    rows = db.prepare("SELECT * FROM reimbursements WHERE status != 'withdrawn'").all();
  } else if (user.role === 'cashier') {
    // 出纳：只看「已通过（待打款）」与「已打款」，不接触待审/驳回/撤回的评审信息
    rows = db.prepare("SELECT * FROM reimbursements WHERE status IN ('approved','paid')").all();
  } else {
    // admin：管理可见全部（含已撤回，用于留痕）
    rows = db.prepare('SELECT * FROM reimbursements').all();
  }
  let list = rows.map(toSummary);
  if (statusFilter && statusFilter !== 'all') list = list.filter((x) => x.status === statusFilter);
  list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return list;
}

function computeStats(user) {
  const one = (st) => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM reimbursements WHERE status = ?').get(st);
  const oneOwn = (st) => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM reimbursements WHERE applicant_id = ? AND status = ?').get(user.id, st);
  if (user.role === 'employee') {
    return {
      total: db.prepare('SELECT COUNT(*) AS n FROM reimbursements WHERE applicant_id = ?').get(user.id),
      pending: oneOwn('pending'), approved: oneOwn('approved'), rejected: oneOwn('rejected'),
      paid: oneOwn('paid'), withdrawn: oneOwn('withdrawn'),
    };
  }
  if (user.role === 'finance') {
    // 财务：排除已撤回；total = 待审核/已通过/已驳回/已打款 之和
    const pending = one('pending'), approved = one('approved'), rejected = one('rejected'), paid = one('paid');
    return {
      total: { n: pending.n + approved.n + rejected.n + paid.n, s: pending.s + approved.s + rejected.s + paid.s },
      pending, approved, rejected, paid, withdrawn: { n: 0, s: 0 },
    };
  }
  if (user.role === 'cashier') {
    // 出纳：只看待打款 + 已打款
    const approved = one('approved'), paid = one('paid');
    return {
      total: { n: approved.n + paid.n, s: approved.s + paid.s },
      pending: { n: 0, s: 0 }, approved, paid, rejected: { n: 0, s: 0 }, withdrawn: { n: 0, s: 0 },
    };
  }
  // admin：可见全部（含已撤回）
  return {
    total: db.prepare('SELECT COUNT(*) AS n FROM reimbursements').get(),
    pending: one('pending'), approved: one('approved'), rejected: one('rejected'),
    paid: one('paid'), withdrawn: one('withdrawn'),
  };
}

/* ---------------- 路由 ---------------- */
const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}
function match(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const q = pathname.split('/').filter(Boolean);
  if (p.length !== q.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(q[i]);
    else if (p[i] !== q[i]) return null;
  }
  return params;
}

/* ---- 认证 ---- */
route('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) throw new HttpError(400, '请输入用户名和密码');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const fail = (reason) => { logAudit('login_fail', null, username, reason); throw new HttpError(401, '用户名或密码错误'); };
  if (!u) return fail('账号不存在');
  if (hashPassword(password, u.salt) !== u.password_hash) return fail('密码错误');
  if (!u.active) { logAudit('login_blocked', u, username, '账号已停用'); throw new HttpError(403, '账号已停用，请联系管理员'); }
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, u.id, nowISO());
  logAudit('login', u, u.username, '登录成功');
  return { token, user: publicUser(u) };
});

route('POST', '/api/logout', (req) => {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { ok: true };
});

route('GET', '/api/me', (req) => {
  const user = authRequired(req);
  return { user: publicUser(user) };
});

/* ---- 报销申请 ---- */
route('GET', '/api/reimbursements', (req) => {
  const user = authRequired(req);
  const url = new URL(req.url, 'http://localhost');
  return { items: listReimbursements(user, url.searchParams.get('status')) };
});

route('GET', '/api/reimbursements/:id', (req) => {
  const user = authRequired(req);
  const r = getReimb(Number(req.params.id));
  ensureCanView(user, r);
  return { item: toDetail(r) };
});

route('POST', '/api/reimbursements', async (req) => {
  const user = authRequired(req, ['employee']);
  const body = await readBody(req);
  const amount = money(body.amount);
  const invoiceContent = String(body.invoiceContent || '').trim();
  const reason = String(body.reason || '').trim();
  if (!invoiceContent) throw new HttpError(400, '请填写发票内容');
  if (!reason) throw new HttpError(400, '请填写申请事项（报销原因）');

  let imageUrl = null;
  if (body.invoiceImage == null || body.invoiceImage === '') {
    // 允许暂不传图，但给提示 —— 为满足“支持上传、预览”，此处强制校验
    throw new HttpError(400, '请上传发票图片');
  }
  imageUrl = saveUploadedImage(body.invoiceImage);

  const ts = nowISO();
  const id = db.prepare(
    `INSERT INTO reimbursements (applicant_id, amount, invoice_content, reason, invoice_image, status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'pending', ?, ?)`
  ).run(user.id, amount, invoiceContent, reason, imageUrl, ts, ts).lastInsertRowid;
  addHistory(id, 'submit', user.id, user.name, '提交报销申请');

  const duplicates = findDuplicates(user.id, amount, invoiceContent).filter((d) => d.id !== Number(id));
  return { item: toDetail(getReimb(id)), duplicates };
});

route('PUT', '/api/reimbursements/:id', async (req) => {
  const user = authRequired(req, ['employee']);
  const r = getReimb(Number(req.params.id));
  if (r.applicant_id !== user.id) throw new HttpError(403, '只能修改自己的申请');
  if (r.status !== 'pending' && r.status !== 'rejected') throw new HttpError(400, '当前状态不可修改（仅待审核或已驳回可修改）');

  const body = await readBody(req);
  const amount = money(body.amount);
  const invoiceContent = String(body.invoiceContent || '').trim();
  const reason = String(body.reason || '').trim();
  if (!invoiceContent) throw new HttpError(400, '请填写发票内容');
  if (!reason) throw new HttpError(400, '请填写申请事项（报销原因）');

  let imageUrl = r.invoice_image;
  if (body.invoiceImage && typeof body.invoiceImage === 'string' && body.invoiceImage.startsWith('data:')) {
    imageUrl = saveUploadedImage(body.invoiceImage);
  }

  const isResubmit = r.status === 'rejected';
  const newStatus = isResubmit ? 'pending' : 'pending';
  const ts = nowISO();
  db.prepare(
    `UPDATE reimbursements SET amount=?, invoice_content=?, reason=?, invoice_image=?, status=?, updated_at=? WHERE id=?`
  ).run(amount, invoiceContent, reason, imageUrl, newStatus, ts, r.id);
  addHistory(r.id, isResubmit ? 'resubmit' : 'update', user.id, user.name, isResubmit ? '修改后重新提交' : '修改申请内容');

  const duplicates = findDuplicates(user.id, amount, invoiceContent).filter((d) => d.id !== Number(r.id));
  return { item: toDetail(getReimb(r.id)), duplicates };
});

route('POST', '/api/reimbursements/:id/withdraw', (req) => {
  const user = authRequired(req, ['employee']);
  const r = getReimb(Number(req.params.id));
  if (r.applicant_id !== user.id) throw new HttpError(403, '只能撤回自己的申请');
  if (r.status !== 'pending') throw new HttpError(400, '仅待审核状态可撤回');
  db.prepare("UPDATE reimbursements SET status='withdrawn', updated_at=? WHERE id=?").run(nowISO(), r.id);
  addHistory(r.id, 'withdraw', user.id, user.name, '撤回申请');
  return { item: toDetail(getReimb(r.id)) };
});

route('POST', '/api/reimbursements/:id/approve', (req) => {
  const user = authRequired(req, ['finance']);
  const r = getReimb(Number(req.params.id));
  if (r.status !== 'pending') throw new HttpError(400, '仅待审核的申请可审核通过');
  db.prepare("UPDATE reimbursements SET status='approved', updated_at=? WHERE id=?").run(nowISO(), r.id);
  addHistory(r.id, 'approve', user.id, user.name, '审核通过');
  return { item: toDetail(getReimb(r.id)) };
});

route('POST', '/api/reimbursements/:id/reject', async (req) => {
  const user = authRequired(req, ['finance']);
  const r = getReimb(Number(req.params.id));
  if (r.status !== 'pending') throw new HttpError(400, '仅待审核的申请可驳回');
  const body = await readBody(req);
  const note = String(body.note || '').trim();
  if (!note) throw new HttpError(400, '驳回时必须填写原因');
  db.prepare("UPDATE reimbursements SET status='rejected', updated_at=? WHERE id=?").run(nowISO(), r.id);
  addHistory(r.id, 'reject', user.id, user.name, note);
  return { item: toDetail(getReimb(r.id)) };
});

route('POST', '/api/reimbursements/:id/pay', (req) => {
  const user = authRequired(req, ['cashier']);
  const r = getReimb(Number(req.params.id));
  if (r.status !== 'approved') throw new HttpError(400, '仅审核通过的申请可打款');
  db.prepare("UPDATE reimbursements SET status='paid', updated_at=? WHERE id=?").run(nowISO(), r.id);
  addHistory(r.id, 'pay', user.id, user.name, '打款完成');
  return { item: toDetail(getReimb(r.id)) };
});

route('GET', '/api/stats', (req) => {
  const user = authRequired(req);
  return computeStats(user);
});

/* ---------------- 管理员：账号管理 / 审计 / 导出 ---------------- */
const ROLE_LABELS = { employee: '员工', finance: '财务', cashier: '出纳', admin: '管理员' };
const STATUS_LABELS = { pending: '待审核', approved: '已通过', paid: '已打款', rejected: '已驳回', withdrawn: '已撤回' };
const VALID_ROLES = ['employee', 'finance', 'cashier', 'admin'];

function getUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, '账号不存在');
  return u;
}
function userPublic(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, created_at: u.created_at };
}

route('GET', '/api/admin/users', (req) => {
  requireAdmin(req);
  const items = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all();
  return { items };
});

route('POST', '/api/admin/users', async (req) => {
  const admin = requireAdmin(req);
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const name = String(body.name || '').trim();
  const role = String(body.role || 'employee').trim();
  const password = String(body.password || '');
  if (username.length < 3) throw new HttpError(400, '用户名至少 3 位');
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw new HttpError(400, '用户名只能包含字母、数字、下划线、点、短横线');
  if (!name) throw new HttpError(400, '请输入姓名');
  if (!VALID_ROLES.includes(role)) throw new HttpError(400, '角色无效');
  if (password.length < 6) throw new HttpError(400, '密码至少 6 位');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new HttpError(400, '用户名已存在');
  const salt = randomToken();
  const id = db.prepare(
    'INSERT INTO users (username, password_hash, salt, name, role, active, created_at) VALUES (?,?,?,?,?,1,?)'
  ).run(username, hashPassword(password, salt), salt, name, role, nowISO()).lastInsertRowid;
  logAudit('user_create', admin, username, `创建账号 ${name}（${ROLE_LABELS[role] || role}）`);
  return { item: userPublic(getUser(id)) };
});

route('PUT', '/api/admin/users/:id', async (req) => {
  const admin = requireAdmin(req);
  const target = getUser(req.params.id);
  const body = await readBody(req);
  const name = String(body.name ?? target.name).trim();
  const role = String(body.role ?? target.role).trim();
  if (!name) throw new HttpError(400, '请输入姓名');
  if (!VALID_ROLES.includes(role)) throw new HttpError(400, '角色无效');
  if (role !== 'admin' && target.role === 'admin' && activeAdminCount(target.id) < 1)
    throw new HttpError(400, '至少保留一名启用的管理员');
  if (target.id === admin.id && role !== 'admin') throw new HttpError(400, '不能改变当前登录账号的管理员角色');
  db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, target.id);
  logAudit('user_update', admin, target.username, `更新账号 ${target.username}：姓名=${name}，角色=${ROLE_LABELS[role] || role}`);
  return { item: userPublic(getUser(target.id)) };
});

route('POST', '/api/admin/users/:id/password', async (req) => {
  const admin = requireAdmin(req);
  const target = getUser(req.params.id);
  const body = await readBody(req);
  const np = String(body.password || '');
  if (np.length < 6) throw new HttpError(400, '密码至少 6 位');
  const salt = randomToken();
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(np, salt), salt, target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); // 使旧会话失效
  logAudit('user_password', admin, target.username, `重置密码（${target.name}）`);
  return { ok: true };
});

route('POST', '/api/admin/users/:id/toggle', (req) => {
  const admin = requireAdmin(req);
  const target = getUser(req.params.id);
  if (target.id === admin.id) throw new HttpError(400, '不能停用或启用自己');
  const toActive = target.active ? 0 : 1;
  if (toActive === 0 && target.role === 'admin' && activeAdminCount(target.id) < 1)
    throw new HttpError(400, '至少保留一名启用的管理员');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(toActive, target.id);
  if (toActive === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); // 停用即踢下线
  logAudit('user_toggle', admin, target.username, toActive ? '启用账号' : '停用账号');
  return { item: userPublic(getUser(target.id)) };
});

route('DELETE', '/api/admin/users/:id', (req) => {
  const admin = requireAdmin(req);
  const target = getUser(req.params.id);
  if (target.id === admin.id) throw new HttpError(400, '不能删除自己');
  if (target.role === 'admin' && activeAdminCount(target.id) < 1) throw new HttpError(400, '至少保留一名管理员');
  // 冗余存储了 operator_name，这里将引用置空以保留审计可读性
  db.prepare('UPDATE history SET operator_id = NULL WHERE operator_id = ?').run(target.id);
  db.prepare('UPDATE audit_logs SET operator_id = NULL WHERE operator_id = ?').run(target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id); // 级联其会话/报销/历史
  logAudit('user_delete', admin, target.username, `删除账号（${target.name}）`);
  return { ok: true };
});

route('GET', '/api/admin/audit', (req) => {
  requireAdmin(req);
  const url = new URL(req.url, 'http://localhost');
  const operator = (url.searchParams.get('operator') || '').trim();
  const action = (url.searchParams.get('action') || '').trim();
  const from = (url.searchParams.get('from') || '');
  const to = (url.searchParams.get('to') || '');

  const logs = db.prepare('SELECT id, action, operator_id, operator_name, target, detail, created_at FROM audit_logs').all();
  const sys = logs.map(l => ({ key: 'a' + l.id, kind: 'sys', time: l.created_at, operatorId: l.operator_id, operatorName: l.operator_name, action: l.action, target: l.target, detail: l.detail }));

  const hist = db.prepare(`
    SELECT h.action, h.operator_id, h.operator_name, h.note, h.created_at, r.id AS reimb_id, u.name AS applicant
      FROM history h
      LEFT JOIN reimbursements r ON r.id = h.reimbursement_id
      LEFT JOIN users u ON u.id = r.applicant_id
     ORDER BY h.id DESC
  `).all();
  const re = hist.map(h => ({ key: 'h' + h.id, kind: 'reimb', time: h.created_at, operatorId: h.operator_id, operatorName: h.operator_name, action: h.action, target: h.reimb_id ? '报销 #' + h.reimb_id : '', detail: h.note || ('申请人：' + (h.applicant || '未知')) }));

  let items = sys.concat(re);
  if (operator && operator !== 'all') items = items.filter(i => String(i.operatorId) === operator);
  if (action && action !== 'all') items = items.filter(i => i.action === action);
  if (from) items = items.filter(i => i.time >= new Date(from).toISOString());
  if (to) items = items.filter(i => i.time <= new Date(to).toISOString());
  items.sort((a, b) => (a.time < b.time ? 1 : -1));

  const operators = db.prepare('SELECT id, username, name FROM users ORDER BY id').all().map(u => ({ id: u.id, name: u.name, username: u.username }));
  return { items, operators };
});

route('GET', '/api/admin/summary', (req) => {
  requireAdmin(req);
  const byRole = {};
  for (const r of VALID_ROLES) byRole[r] = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(r).n;
  const reimb = {};
  for (const s of Object.keys(STATUS_LABELS)) {
    const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM reimbursements WHERE status = ?').get(s);
    reimb[s] = { n: row.n, s: row.s };
  }
  return {
    users: {
      total: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      active: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n,
      disabled: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 0').get().n,
      byRole,
    },
    reimbursements: { ...reimb, total: db.prepare('SELECT COUNT(*) AS n FROM reimbursements').get().n },
  };
});

function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
function buildReimbCsv() {
  const rows = db.prepare(`
    SELECT r.id, u.name AS applicant, r.amount, r.invoice_content, r.reason, r.status, r.created_at, r.updated_at,
           (SELECT h.operator_name FROM history h WHERE h.reimbursement_id = r.id ORDER BY h.id DESC LIMIT 1) AS last_op,
           (SELECT h.note FROM history h WHERE h.reimbursement_id = r.id ORDER BY h.id DESC LIMIT 1) AS last_note
      FROM reimbursements r JOIN users u ON u.id = r.applicant_id
     ORDER BY r.id DESC
  `).all();
  const lines = [['ID', '申请人', '金额', '发票内容', '申请事项', '状态', '提交时间', '更新时间', '最近操作人', '最近意见']
    .map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([r.id, r.applicant, r.amount, r.invoice_content, r.reason, STATUS_LABELS[r.status] || r.status, r.created_at, r.updated_at, r.last_op || '', r.last_note || ''].map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
function exportCsv(req, res) {
  const csv = buildReimbCsv();
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="reimbursements.csv"',
    'Content-Length': Buffer.byteLength(csv),
  });
  res.end(csv);
}
route('GET', '/api/admin/reimbursements.csv', (req, res) => { requireAdmin(req); exportCsv(req, res); });

/* ---------------- 智能体对话（嵌入管理后台，直连 DeepSeek 真实模型） ---------------- */
const CHAT_SYSTEM = [
  '你是「报销云」系统的管理员智能助手，面向系统运维与管理人员。',
  '你通过内置的只读查询工具（query）访问报销系统数据，只做查询，绝不写入或修改任何数据。',
  '你只就管理员可见的信息作答：报销数据、系统运行状态、账号概览与操作审计。',
  '',
  '查询工具 query 的 cmd 取值：',
  '- summary            报销/账号汇总统计（各状态笔数与金额；账号按角色与启用）。',
  '- reimb [status|all] [n]   报销列表（status: pending/approved/rejected/paid/withdrawn）',
  '- detail <id>        单笔报销详情 + 流程时间线',
  '- accounts           账号列表',
  '- audit [n]          最近操作审计',
  '- search <关键词>     按发票内容/事项/申请人搜索',
  '- status             系统运行情况（含报销服务在线状态）',
  '',
  '使用要点：',
  '- 需要数据时调用 query，并依据返回内容作答；不要凭猜测编造数字。',
  '- 用语简洁、专业；金额用 ¥ 并保留两位小数。',
  '- 若提示“未找到数据库”，说明报销系统尚未初始化，应提示先启动 node server.js。',
].join('\n');

const CHAT_TOOL = {
  type: 'function',
  function: {
    name: 'query',
    description: '查询报销系统数据。cmd 取值：summary / reimb / detail / accounts / audit / search / status；args 为该子命令的可选参数（用空格分隔，例如 reimb 传 args=" pending 10"、detail 传 args="6"、search 传 args="高铁"）。只读，不修改数据。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '子命令名' },
        args: { type: 'string', description: '子命令的可选参数' },
      },
      required: ['cmd'],
    },
  },
};

function runQueryTool(cmd, args) {
  return new Promise((resolve) => {
    const params = [path.join(ROOT, 'admin-query.js'), String(cmd || '').trim()];
    if (args && String(args).trim()) params.push(...String(args).trim().split(/\s+/));
    execFile('node', params, { cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      resolve((stdout || '').trim() || (stderr || '').trim() || (err ? 'ERR: ' + err.message : ''));
    });
  });
}

async function callDeepSeek(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(CONFIG.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CONFIG.apiKey },
      body: JSON.stringify({ model: CONFIG.model, messages, tools: [CHAT_TOOL], temperature: 0.3, stream: false }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || ('LLM 响应异常 ' + res.status));
    return (data.choices && data.choices[0] && data.choices[0].message) || null;
  } finally {
    clearTimeout(timer);
  }
}

async function runAdminAgent(userMessages) {
  const messages = [{ role: 'system', content: CHAT_SYSTEM },
    ...userMessages.map(m => ({ role: m.role, content: String(m.content || '') }))];
  for (let round = 0; round < 5; round++) {
    const msg = await callDeepSeek(messages);
    if (!msg) return '（模型未返回内容）';
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        if (tc.function && tc.function.name === 'query') {
          let arg = {}; try { arg = JSON.parse(tc.function.arguments || '{}'); } catch {}
          const result = await runQueryTool(arg.cmd, arg.args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 6000) });
        } else {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: '未知工具' });
        }
      }
      continue;
    }
    return (msg.content || '').trim() || '（无回复）';
  }
  return '（已达最大轮次，请简化问题或换种问法）';
}

route('GET', '/api/admin/chat/config', (req) => {
  requireAdmin(req);
  return { configured: !!CONFIG.apiKey, model: CONFIG.model, baseUrl: CONFIG.baseUrl };
});

route('POST', '/api/admin/chat/config', async (req) => {
  const admin = requireAdmin(req);
  const body = await readBody(req);
  // 允许只传部分字段；apiKey 传空串表示清空
  const apiKey = body.apiKey !== undefined ? String(body.apiKey).trim() : CONFIG.apiKey;
  const model = body.model !== undefined ? (String(body.model).trim() || 'deepseek-v4-flash-vision-exp') : CONFIG.model;
  const baseUrl = body.baseUrl !== undefined ? (String(body.baseUrl).trim().replace(/\/+$/, '') || 'https://api.deepseek.com') : CONFIG.baseUrl;
  persistConfig({ apiKey, model, baseUrl });
  logAudit('chat_config', admin, 'DeepSeek对话', apiKey ? '更新对话配置（模型 ' + model + '）' : '清空对话配置');
  return { ok: true, configured: !!CONFIG.apiKey, model: CONFIG.model, baseUrl: CONFIG.baseUrl };
});

route('POST', '/api/admin/chat/config/test', async (req) => {
  requireAdmin(req);
  const body = await readBody(req);
  const apiKey = String(body.apiKey || CONFIG.apiKey).trim();
  const model = String(body.model || CONFIG.model).trim() || 'deepseek-v4-flash-vision-exp';
  const baseUrl = String(body.baseUrl || CONFIG.baseUrl).replace(/\/+$/, '') || 'https://api.deepseek.com';
  if (!apiKey) throw new HttpError(400, '请先填写 API Key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
    return { ok: true, message: '连接成功（' + model + '）' };
  } catch (e) {
    throw new HttpError(400, '连接失败：' + e.message);
  } finally {
    clearTimeout(timer);
  }
});

route('POST', '/api/admin/chat', async (req) => {
  requireAdmin(req);
  if (!CONFIG.apiKey) throw new HttpError(400, '尚未配置 DeepSeek API Key。请在管理后台「智能问答 → 配置」中填写，或设置环境变量 DEEPSEEK_API_KEY。');
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const valid = messages.filter(m => m && (m.content || m.content === '') && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: String(m.content) })).slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!valid.length) throw new HttpError(400, '请输入内容');
  try {
    const reply = await runAdminAgent(valid);
    return { reply };
  } catch (e) {
    console.error('[chat]', e);
    throw new HttpError(502, '智能体调用失败：' + e.message);
  }
});

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
function sendFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { sendJson(res, 404, { error: '未找到资源' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/* 校验查看权限：员工只能看自己的，财务/出纳可看全部 */
function ensureCanView(user, r) {
  if (user.role === 'employee' && r.applicant_id !== user.id) throw new HttpError(403, '无权查看其他员工的申请');
  if (user.role === 'finance' && r.status === 'withdrawn') throw new HttpError(403, '已撤回的申请不进入财务审核');
  if (user.role === 'cashier' && !['approved', 'paid'].includes(r.status)) throw new HttpError(403, '出纳仅可查看待打款/已打款申请');
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // 上传图片（需登录鉴权：凭 ?token= 会话令牌；basename 防目录穿越）
  if (pathname.startsWith('/uploads/')) {
    const token = url.searchParams.get('token') || '';
    const user = token
      ? db.prepare("SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1").get(token)
      : null;
    if (!user) return sendJson(res, 401, { error: '未登录或会话已过期' });
    const full = path.join(UPLOAD_DIR, path.basename(pathname));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return sendFile(req, res, full);
    return sendJson(res, 404, { error: '图片不存在' });
  }

  // 挂载路由
  let handled = false;
  for (const { method, pattern, handler } of routes) {
    if (req.method !== method) continue;
    const params = match(pattern, pathname);
    if (!params) continue;
    handled = true;
    try {
      req.params = params;
      const out = await handler(req, res);
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[500]', e);
      if (!res.headersSent) sendJson(res, status, { error: e.message || '服务器错误' });
      else res.end();
    }
    break;
  }
  if (handled) return;

  // 静态前端
  if (pathname === '/') return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
  const staticPath = path.join(PUBLIC_DIR, pathname);
  if (staticPath.startsWith(PUBLIC_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile())
    return sendFile(req, res, staticPath);

  sendJson(res, 404, { error: '接口不存在' });
});

server.listen(PORT, () => {
  console.log(`\n  报销管理系统已启动  →  http://127.0.0.1:${PORT}\n`);
  console.log('  演示账号（密码均为 123456）：');
  console.log('    员工1  zhangwei    张伟');
  console.log('    员工2  lina        李娜');
  console.log('    财务   finance     王晓财务');
  console.log('    出纳   cashier     赵出纳\n');
});
