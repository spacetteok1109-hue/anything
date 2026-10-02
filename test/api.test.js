'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
process.env.ADMIN_PASSWORD = 'admin-pass-1';
const { server } = require('../server.js');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('접근 제어와 권한', async () => {
  assert.equal((await call('GET', '/api/workers')).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'wrong' })).status, 401);
  const admin = (await call('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' })).cookie;
  assert.ok(admin.startsWith('sid='));

  await call('POST', '/api/users', { username: 'viewer1', name: '열람자', password: 'viewerpass1', role: 'viewer' }, admin);
  await call('POST', '/api/users', { username: 'edit1', name: '입력자', password: 'editorpass1', role: 'editor' }, admin);
  const viewer = (await call('POST', '/api/login', { username: 'viewer1', password: 'viewerpass1' })).cookie;
  const editor = (await call('POST', '/api/login', { username: 'edit1', password: 'editorpass1' })).cookie;

  assert.equal((await call('POST', '/api/workers', { name: 'x' }, viewer)).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, editor)).status, 403);

  const w1 = (await call('POST', '/api/workers', { name: '홍길동', trade: '철근' }, editor)).data.id;
  const w2 = (await call('POST', '/api/workers', { name: '=cmd', trade: '목수' }, editor)).data.id;
  const s1 = (await call('POST', '/api/sites', { name: 'A현장' }, editor)).data.id;
  assert.equal((await call('POST', '/api/sites', { name: 'A현장' }, editor)).status, 409);

  let r = await call('POST', '/api/assignments/bulk', { date: '2026-10-01', site_id: s1, worker_ids: [w1, w2], note: '기초' }, editor);
  assert.deepEqual(r.data, { added: 2, skipped: 0 });
  r = await call('POST', '/api/assignments/bulk', { date: '2026-10-01', site_id: s1, worker_ids: [w1] }, editor);
  assert.deepEqual(r.data, { added: 0, skipped: 1 });
  assert.equal((await call('POST', '/api/assignments/bulk', { date: 'bad', site_id: s1, worker_ids: [w1] }, editor)).status, 400);

  const list = await call('GET', '/api/assignments?from=2026-10-01&to=2026-10-31', undefined, viewer);
  assert.equal(list.data.length, 2);
  assert.equal((await call('DELETE', `/api/assignments/${list.data[0].id}`, undefined, viewer)).status, 403);

  const sum = await call('GET', '/api/summary?from=2026-10-01', undefined, viewer);
  assert.equal(sum.data.reduce((a, x) => a + x.days, 0), 2);

  const csv = await call('GET', '/api/export.csv', undefined, viewer);
  assert.ok(csv.data.includes("'=cmd"), 'CSV 수식 주입 방지');

  // 비활성화하면 즉시 로그아웃
  const uid = (await call('GET', '/api/users', undefined, admin)).data.find((u) => u.username === 'viewer1').id;
  await call('PUT', `/api/users/${uid}`, { active: false }, admin);
  assert.equal((await call('GET', '/api/me', undefined, viewer)).status, 401);
});

test('정적 파일 경로 이탈 차단', async () => {
  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('GET', '/..%2Fserver.js')).status, 404);
});
