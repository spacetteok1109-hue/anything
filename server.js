'use strict';
// 인력 배치 기록 서버 — 외부 의존성 없음 (Node 22.13+, 내장 SQLite 사용)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1'; // HTTPS 뒤에서 운영 시 1
const SESSION_HOURS = 12;
const ROLES = ['admin', 'editor', 'viewer'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'manpower.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, trade TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  worker_id INTEGER NOT NULL REFERENCES workers(id), site_id INTEGER NOT NULL REFERENCES sites(id),
  note TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (date, worker_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_date ON assignments(date);
`);

// ---------- 비밀번호 / 세션 ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const DUMMY_HASH = hashPassword('dummy-password');

if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (username,name,pass_hash,role) VALUES (?,?,?,?)')
    .run('admin', '관리자', hashPassword(pw), 'admin');
  console.log('\n[최초 실행] 관리자 계정을 만들었습니다.');
  console.log('  아이디: admin');
  console.log(`  비밀번호: ${process.env.ADMIN_PASSWORD ? '(ADMIN_PASSWORD 환경변수)' : pw}`);
  console.log('  로그인 후 반드시 비밀번호를 변경하세요.\n');
}

const failures = new Map(); // ip -> {n, until}
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return f && f.n >= 5 && f.until > Date.now();
}
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n += 1; f.until = Date.now() + 10 * 60 * 1000;
  failures.set(ip, f);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.username,u.name,u.role,s.expires_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1`).get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

// ---------- 유틸 ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const flag = (v) => (v ? 1 : 0);
const canEdit = (u) => u.role === 'admin' || u.role === 'editor';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, '요청이 너무 큽니다')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, '잘못된 JSON')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 엑셀 수식 주입 방지
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function assignmentQuery(q) {
  const where = []; const args = [];
  if (q.from) { if (!isDate(q.from)) throw new HttpError(400, '시작일 형식 오류'); where.push('a.date >= ?'); args.push(q.from); }
  if (q.to) { if (!isDate(q.to)) throw new HttpError(400, '종료일 형식 오류'); where.push('a.date <= ?'); args.push(q.to); }
  if (q.site_id) { where.push('a.site_id = ?'); args.push(Number(q.site_id)); }
  if (q.worker_id) { where.push('a.worker_id = ?'); args.push(Number(q.worker_id)); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
const ASSIGN_SELECT = `SELECT a.id,a.date,a.worker_id,w.name worker_name,w.trade,a.site_id,s.name site_name,a.note,
  u.name created_by_name,a.created_at FROM assignments a JOIN workers w ON w.id=a.worker_id
  JOIN sites s ON s.id=a.site_id LEFT JOIN users u ON u.id=a.created_by`;

// ---------- API ----------
const routes = []; // {method, re, role, fn}
function route(method, pattern, role, fn) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, role, fn });
}
const needAdmin = 'admin', needEdit = 'edit', anyUser = 'user', open = 'open';

route('POST', '/api/login', open, ({ body, req, res }) => {
  const ip = req.socket.remoteAddress;
  if (tooManyFailures(ip)) throw new HttpError(429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.');
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(str(body.username, 50));
  const ok = verifyPassword(String(body.password ?? ''), u ? u.pass_hash : DUMMY_HASH) && u;
  if (!ok) { noteFailure(ip); throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.'); }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)')
    .run(token, u.id, Date.now() + SESSION_HOURS * 3600e3);
  const cookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${SECURE_COOKIE ? '; Secure' : ''}`;
  send(res, 200, { id: u.id, username: u.username, name: u.name, role: u.role }, { 'Set-Cookie': cookie });
  return null;
});
route('POST', '/api/logout', open, ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  return null;
});
route('GET', '/api/me', anyUser, ({ user }) => user);
route('POST', '/api/password', anyUser, ({ user, body }) => {
  const cur = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(user.id);
  if (!verifyPassword(String(body.current ?? ''), cur.pass_hash)) throw new HttpError(400, '현재 비밀번호가 다릅니다.');
  const pw = String(body.password ?? '');
  if (pw.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(pw), user.id);
  return { ok: true };
});

// 인원
route('GET', '/api/workers', anyUser, () => db.prepare('SELECT * FROM workers ORDER BY active DESC, name').all());
route('POST', '/api/workers', needEdit, ({ body }) => {
  const name = str(body.name, 50); if (!name) throw new HttpError(400, '이름을 입력하세요.');
  const r = db.prepare('INSERT INTO workers (name,trade,phone) VALUES (?,?,?)').run(name, str(body.trade, 50), str(body.phone, 30));
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/workers/:id', needEdit, ({ params, body }) => {
  const name = str(body.name, 50); if (!name) throw new HttpError(400, '이름을 입력하세요.');
  db.prepare('UPDATE workers SET name=?,trade=?,phone=?,active=? WHERE id=?')
    .run(name, str(body.trade, 50), str(body.phone, 30), flag(body.active), Number(params.id));
  return { ok: true };
});
// 현장
route('GET', '/api/sites', anyUser, () => db.prepare('SELECT * FROM sites ORDER BY active DESC, name').all());
route('POST', '/api/sites', needEdit, ({ body }) => {
  const name = str(body.name, 100); if (!name) throw new HttpError(400, '현장명을 입력하세요.');
  try { return { id: Number(db.prepare('INSERT INTO sites (name) VALUES (?)').run(name).lastInsertRowid) }; }
  catch { throw new HttpError(409, '이미 있는 현장명입니다.'); }
});
route('PUT', '/api/sites/:id', needEdit, ({ params, body }) => {
  const name = str(body.name, 100); if (!name) throw new HttpError(400, '현장명을 입력하세요.');
  try { db.prepare('UPDATE sites SET name=?,active=? WHERE id=?').run(name, flag(body.active), Number(params.id)); }
  catch { throw new HttpError(409, '이미 있는 현장명입니다.'); }
  return { ok: true };
});
// 배치 기록
route('GET', '/api/assignments', anyUser, ({ query }) => {
  const { sql, args } = assignmentQuery(query);
  return db.prepare(`${ASSIGN_SELECT} ${sql} ORDER BY a.date DESC, s.name, w.name LIMIT 5000`).all(...args);
});
route('POST', '/api/assignments/bulk', needEdit, ({ user, body }) => {
  if (!isDate(body.date)) throw new HttpError(400, '날짜를 확인하세요.');
  const siteId = Number(body.site_id);
  const ids = Array.isArray(body.worker_ids) ? [...new Set(body.worker_ids.map(Number))] : [];
  if (!ids.length) throw new HttpError(400, '인원을 선택하세요.');
  if (!db.prepare('SELECT 1 FROM sites WHERE id=?').get(siteId)) throw new HttpError(400, '현장을 선택하세요.');
  const ins = db.prepare('INSERT OR IGNORE INTO assignments (date,worker_id,site_id,note,created_by) VALUES (?,?,?,?,?)');
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const wid of ids) {
      if (!db.prepare('SELECT 1 FROM workers WHERE id=?').get(wid)) throw new HttpError(400, '존재하지 않는 인원이 있습니다.');
      added += Number(ins.run(body.date, wid, siteId, str(body.note, 300), user.id).changes);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, skipped: ids.length - added };
});
route('PUT', '/api/assignments/:id', needEdit, ({ params, body }) => {
  const r = db.prepare('UPDATE assignments SET note=? WHERE id=?').run(str(body.note, 300), Number(params.id));
  if (!r.changes) throw new HttpError(404, '기록이 없습니다.');
  return { ok: true };
});
route('DELETE', '/api/assignments/:id', needEdit, ({ params }) => {
  db.prepare('DELETE FROM assignments WHERE id=?').run(Number(params.id));
  return { ok: true };
});
// 집계 / CSV
route('GET', '/api/summary', anyUser, ({ query }) => {
  const { sql, args } = assignmentQuery(query);
  return db.prepare(`SELECT w.id worker_id,w.name worker_name,w.trade,s.id site_id,s.name site_name,COUNT(*) days
    FROM assignments a JOIN workers w ON w.id=a.worker_id JOIN sites s ON s.id=a.site_id ${sql}
    GROUP BY w.id,s.id ORDER BY w.name,s.name`).all(...args);
});
route('GET', '/api/export.csv', anyUser, ({ query, res }) => {
  const { sql, args } = assignmentQuery(query);
  const rows = db.prepare(`${ASSIGN_SELECT} ${sql} ORDER BY a.date, s.name, w.name`).all(...args);
  const lines = [['날짜', '이름', '공종', '현장', '메모', '입력자', '입력시각'].join(',')];
  for (const r of rows) lines.push([r.date, r.worker_name, r.trade, r.site_name, r.note, r.created_by_name, r.created_at].map(csvCell).join(','));
  send(res, 200, '﻿' + lines.join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="manpower.csv"',
  });
  return null;
});
// 사용자 관리 (관리자)
route('GET', '/api/users', needAdmin, () => db.prepare('SELECT id,username,name,role,active,created_at FROM users ORDER BY id').all());
route('POST', '/api/users', needAdmin, ({ body }) => {
  const username = str(body.username, 50), name = str(body.name, 50), pw = String(body.password ?? '');
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) throw new HttpError(400, '아이디는 영문/숫자/._- 3자 이상');
  if (!name) throw new HttpError(400, '이름을 입력하세요.');
  if (!ROLES.includes(body.role)) throw new HttpError(400, '권한이 올바르지 않습니다.');
  if (pw.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
  try {
    return { id: Number(db.prepare('INSERT INTO users (username,name,pass_hash,role) VALUES (?,?,?,?)')
      .run(username, name, hashPassword(pw), body.role).lastInsertRowid) };
  } catch { throw new HttpError(409, '이미 있는 아이디입니다.'); }
});
route('PUT', '/api/users/:id', needAdmin, ({ user, params, body }) => {
  const id = Number(params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!target) throw new HttpError(404, '사용자가 없습니다.');
  const role = body.role ?? target.role;
  const active = body.active === undefined ? target.active : flag(body.active);
  if (!ROLES.includes(role)) throw new HttpError(400, '권한이 올바르지 않습니다.');
  if (id === user.id && (role !== 'admin' || !active)) throw new HttpError(400, '본인의 관리자 권한/활성 상태는 바꿀 수 없습니다.');
  db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(role, active, id);
  if (body.password) {
    if (String(body.password).length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(String(body.password)), id);
  }
  if (!active || body.password) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  return { ok: true };
});

// ---------- 정적 파일 ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, '없는 페이지입니다.');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, decodeURIComponent(url.pathname));
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, '없는 API입니다.');
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json') && url.pathname !== '/api/logout' && req.method !== 'DELETE')
      throw new HttpError(415, 'JSON만 허용됩니다.');
    let user = null;
    if (r.role !== open) {
      user = currentUser(req);
      if (!user) throw new HttpError(401, '로그인이 필요합니다.');
      if (r.role === needAdmin && user.role !== 'admin') throw new HttpError(403, '권한이 없습니다.');
      if (r.role === needEdit && !canEdit(user)) throw new HttpError(403, '권한이 없습니다.');
    }
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const params = url.pathname.match(r.re).groups || {};
    const out = r.fn({ req, res, user, body, params, query: Object.fromEntries(url.searchParams) });
    if (out !== null && !res.writableEnded) send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`인력 배치 기록 서버: http://${HOST}:${PORT}  (데이터: ${DATA_DIR})`));
}
module.exports = { server };
