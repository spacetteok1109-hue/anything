'use strict';
const $app = document.getElementById('app');
const state = { me: null, tab: 'input', workers: [], sites: [] };
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const monthStart = () => today().slice(0, 8) + '01';

// DOM 헬퍼 (사용자 입력은 항상 textContent로만 삽입)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && url !== '/api/login') { state.me = null; render(); throw new Error('로그인이 필요합니다.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '오류가 발생했습니다.');
  return data;
}
const canEdit = () => state.me && state.me.role !== 'viewer';
const isAdmin = () => state.me && state.me.role === 'admin';
function msg(el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
const guard = (box, fn) => async (...a) => { try { await fn(...a); } catch (e) { msg(box, e.message, false); } };
const opt = (items, label = (x) => x.name) => items.map((x) => h('option', { value: x.id }, label(x)));

async function loadLists() {
  [state.workers, state.sites] = await Promise.all([api('GET', '/api/workers'), api('GET', '/api/sites')]);
}

function render() {
  $app.replaceChildren();
  if (!state.me) return renderLogin();
  const tabs = [['input', '배치 입력', canEdit()], ['list', '조회', true], ['summary', '월별 집계', true],
    ['people', '인원 / 현장', canEdit()], ['users', '사용자', isAdmin()], ['account', '내 계정', true]].filter((t) => t[2]);
  if (!tabs.some((t) => t[0] === state.tab)) state.tab = 'list';
  const main = h('main');
  $app.append(
    h('header', {}, h('h1', {}, '인력 배치 기록'),
      h('span', { class: 'who' }, `${state.me.name} (${{ admin: '관리자', editor: '입력', viewer: '열람' }[state.me.role]})`),
      h('button', { class: 'btn ghost', onclick: async () => { await api('POST', '/api/logout'); state.me = null; render(); } }, '로그아웃')),
    h('nav', {}, tabs.map(([k, label]) => h('button', { class: k === state.tab ? 'on' : '', onclick: () => { state.tab = k; render(); } }, label))),
    main);
  ({ input: viewInput, list: viewList, summary: viewSummary, people: viewPeople, users: viewUsers, account: viewAccount })[state.tab](main);
}

function renderLogin() {
  const box = h('div', { class: 'msg' });
  const u = h('input', { autocomplete: 'username', required: true }), p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card login', onsubmit: guard(box, async (e) => {
    e.preventDefault();
    state.me = await api('POST', '/api/login', { username: u.value, password: p.value });
    state.tab = canEdit() ? 'input' : 'list';
    await loadLists(); render();
  }) }, h('h2', {}, '인력 배치 기록 로그인'), h('label', {}, '아이디', u), h('label', {}, '비밀번호', p), h('button', { class: 'btn', type: 'submit' }, '로그인'), box);
  $app.append(form);
}

// ---- 배치 입력 ----
function viewInput(main) {
  const box = h('div', { class: 'msg' });
  const date = h('input', { type: 'date', value: today() });
  const site = h('select', {}, opt(state.sites.filter((s) => s.active)));
  const note = h('input', { placeholder: '메모 (선택)', maxlength: 300 });
  const search = h('input', { placeholder: '이름 검색' });
  const chipBox = h('div', { class: 'chips' });
  const checked = new Set();
  const active = state.workers.filter((w) => w.active);
  function drawChips() {
    chipBox.replaceChildren(...active.filter((w) => w.name.includes(search.value.trim())).map((w) => {
      const cb = h('input', { type: 'checkbox', checked: checked.has(w.id), onchange: () => (cb.checked ? checked.add(w.id) : checked.delete(w.id)) });
      return h('label', { class: 'chip' }, cb, w.name, h('small', {}, w.trade));
    }));
  }
  search.addEventListener('input', drawChips); drawChips();
  const existing = h('div');
  async function showDay() {
    const rows = await api('GET', `/api/assignments?from=${date.value}&to=${date.value}`);
    existing.replaceChildren(h('h2', {}, `${date.value} 입력된 배치 (${rows.length}명)`), rowsTable(rows, showDay, box));
  }
  date.addEventListener('change', guard(box, showDay));
  main.append(
    h('div', { class: 'card' }, h('h2', {}, '배치 입력'),
      h('div', { class: 'row' }, h('label', {}, '날짜', date), h('label', {}, '현장', site), h('label', {}, '메모', note), h('label', {}, '인원 찾기', search)),
      chipBox,
      h('button', { class: 'btn', onclick: guard(box, async () => {
        const r = await api('POST', '/api/assignments/bulk', { date: date.value, site_id: Number(site.value), worker_ids: [...checked], note: note.value });
        msg(box, `${r.added}명 저장${r.skipped ? `, ${r.skipped}명은 이미 같은 현장에 기록되어 있음` : ''}`, true);
        checked.clear(); drawChips(); await showDay();
      }) }, '선택한 인원 저장'), box),
    h('div', { class: 'card' }, existing));
  guard(box, showDay)();
}

function rowsTable(rows, reload, box) {
  if (!rows.length) return h('p', { class: 'muted' }, '기록이 없습니다.');
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('tr', {}, ['날짜', '이름', '공종', '현장', '메모', '입력자', ''].map((c) => h('th', {}, c))),
    rows.map((r) => h('tr', {}, h('td', {}, r.date), h('td', {}, r.worker_name), h('td', {}, r.trade), h('td', {}, r.site_name), h('td', {}, r.note), h('td', {}, r.created_by_name || ''),
      h('td', {}, canEdit() && [
        h('button', { class: 'link', onclick: guard(box, async () => { const n = prompt('메모 수정', r.note); if (n !== null) { await api('PUT', `/api/assignments/${r.id}`, { note: n }); await reload(); } }) }, '메모'),
        h('button', { class: 'link del', onclick: guard(box, async () => { if (confirm(`${r.date} ${r.worker_name} 기록을 삭제할까요?`)) { await api('DELETE', `/api/assignments/${r.id}`); await reload(); } }) }, '삭제')])))));
}

// ---- 필터 공통 ----
function filterBar(onGo, csv) {
  const from = h('input', { type: 'date', value: monthStart() }), to = h('input', { type: 'date', value: today() });
  const site = h('select', {}, h('option', { value: '' }, '전체'), opt(state.sites));
  const worker = h('select', {}, h('option', { value: '' }, '전체'), opt(state.workers));
  const qs = () => new URLSearchParams(Object.entries({ from: from.value, to: to.value, site_id: site.value, worker_id: worker.value }).filter(([, v]) => v)).toString();
  const bar = h('div', { class: 'row' }, h('label', {}, '시작', from), h('label', {}, '끝', to), h('label', {}, '현장', site), h('label', {}, '인원', worker),
    h('button', { class: 'btn', onclick: () => onGo(qs()) }, '조회'),
    csv && h('a', { class: 'btn ghost', style: 'text-decoration:none;display:inline-block', onclick: (e) => { e.currentTarget.href = '/api/export.csv?' + qs(); } }, 'CSV 내려받기'));
  return { bar, qs };
}
function viewList(main) {
  const box = h('div', { class: 'msg' }), out = h('div');
  const go = guard(box, async (qs) => { out.replaceChildren(rowsTable(await api('GET', '/api/assignments?' + qs), () => go(qs), box)); });
  const f = filterBar(go, true);
  main.append(h('div', { class: 'card' }, h('h2', {}, '배치 조회'), f.bar, box, out));
  go(f.qs());
}
function viewSummary(main) {
  const box = h('div', { class: 'msg' }), out = h('div');
  const go = guard(box, async (qs) => {
    const rows = await api('GET', '/api/summary?' + qs);
    if (!rows.length) return out.replaceChildren(h('p', { class: 'muted' }, '기록이 없습니다.'));
    const total = rows.reduce((a, r) => a + r.days, 0);
    out.replaceChildren(h('p', {}, `총 ${total}인일`), h('div', { class: 'table-wrap' }, h('table', {},
      h('tr', {}, ['이름', '공종', '현장', '일수'].map((c) => h('th', {}, c))),
      rows.map((r) => h('tr', {}, h('td', {}, r.worker_name), h('td', {}, r.trade), h('td', {}, r.site_name), h('td', {}, String(r.days)))))));
  });
  const f = filterBar(go, false);
  main.append(h('div', { class: 'card' }, h('h2', {}, '기간 집계 (인원 × 현장별 일수)'), f.bar, box, out));
  go(f.qs());
}

// ---- 인원/현장 ----
function viewPeople(main) {
  const box = h('div', { class: 'msg' });
  const refresh = async () => { await loadLists(); render(); };
  const nm = h('input', { placeholder: '이름', maxlength: 50 }), tr = h('input', { placeholder: '공종 (예: 철근, 목수)', maxlength: 50 }), ph = h('input', { placeholder: '연락처 (선택)', maxlength: 30 });
  const sn = h('input', { placeholder: '현장명', maxlength: 100 });
  const edit = (w) => guard(box, async () => {
    const name = prompt('이름', w.name); if (name === null) return;
    const trade = prompt('공종', w.trade); if (trade === null) return;
    const phone = prompt('연락처', w.phone); if (phone === null) return;
    await api('PUT', `/api/workers/${w.id}`, { name, trade, phone, active: w.active }); await refresh();
  });
  main.append(
    h('div', { class: 'card' }, h('h2', {}, '인원'), h('div', { class: 'row' }, nm, tr, ph,
      h('button', { class: 'btn', onclick: guard(box, async () => { await api('POST', '/api/workers', { name: nm.value, trade: tr.value, phone: ph.value }); await refresh(); }) }, '추가')),
      box, h('div', { class: 'table-wrap' }, h('table', {}, h('tr', {}, ['이름', '공종', '연락처', ''].map((c) => h('th', {}, c))),
        state.workers.map((w) => h('tr', { class: w.active ? '' : 'off' }, h('td', {}, w.name), h('td', {}, w.trade), h('td', {}, w.phone),
          h('td', {}, h('button', { class: 'link', onclick: edit(w) }, '수정'),
            h('button', { class: 'link', onclick: guard(box, async () => { await api('PUT', `/api/workers/${w.id}`, { ...w, active: !w.active }); await refresh(); }) }, w.active ? '비활성' : '활성화'))))))),
    h('div', { class: 'card' }, h('h2', {}, '현장'), h('div', { class: 'row' }, sn,
      h('button', { class: 'btn', onclick: guard(box, async () => { await api('POST', '/api/sites', { name: sn.value }); await refresh(); }) }, '추가')),
      h('div', { class: 'table-wrap' }, h('table', {}, h('tr', {}, h('th', {}, '현장명'), h('th', {})),
        state.sites.map((s) => h('tr', { class: s.active ? '' : 'off' }, h('td', {}, s.name),
          h('td', {}, h('button', { class: 'link', onclick: guard(box, async () => { const n = prompt('현장명', s.name); if (n !== null) { await api('PUT', `/api/sites/${s.id}`, { name: n, active: s.active }); await refresh(); } }) }, '수정'),
            h('button', { class: 'link', onclick: guard(box, async () => { await api('PUT', `/api/sites/${s.id}`, { ...s, active: !s.active }); await refresh(); }) }, s.active ? '종료 처리' : '다시 열기'))))))));
}

// ---- 사용자 (관리자) ----
function viewUsers(main) {
  const box = h('div', { class: 'msg' }), list = h('div');
  const un = h('input', { placeholder: '아이디', autocomplete: 'off' }), nm = h('input', { placeholder: '이름' }), pw = h('input', { type: 'password', placeholder: '초기 비밀번호 (8자 이상)', autocomplete: 'new-password' });
  const role = h('select', {}, h('option', { value: 'viewer' }, '열람'), h('option', { value: 'editor' }, '입력'), h('option', { value: 'admin' }, '관리자'));
  const load = guard(box, async () => {
    const users = await api('GET', '/api/users');
    list.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {}, h('tr', {}, ['아이디', '이름', '권한', '상태', ''].map((c) => h('th', {}, c))),
      users.map((u) => {
        const sel = h('select', { onchange: guard(box, async () => { await api('PUT', `/api/users/${u.id}`, { role: sel.value }); await load(); }) },
          ['viewer', 'editor', 'admin'].map((r) => h('option', { value: r, selected: r === u.role }, { viewer: '열람', editor: '입력', admin: '관리자' }[r])));
        return h('tr', { class: u.active ? '' : 'off' }, h('td', {}, u.username), h('td', {}, u.name), h('td', {}, sel), h('td', {}, u.active ? '사용' : '중지'),
          h('td', {}, h('button', { class: 'link', onclick: guard(box, async () => { await api('PUT', `/api/users/${u.id}`, { active: !u.active }); await load(); }) }, u.active ? '중지' : '재개'),
            h('button', { class: 'link', onclick: guard(box, async () => { const p = prompt('새 비밀번호 (8자 이상)'); if (p) { await api('PUT', `/api/users/${u.id}`, { password: p }); msg(box, '비밀번호를 바꿨습니다.', true); } }) }, '비번 초기화')));
      }))));
  });
  main.append(h('div', { class: 'card' }, h('h2', {}, '사용자 관리'), h('div', { class: 'row' }, un, nm, pw, role,
    h('button', { class: 'btn', onclick: guard(box, async () => { await api('POST', '/api/users', { username: un.value, name: nm.value, password: pw.value, role: role.value }); un.value = nm.value = pw.value = ''; msg(box, '추가했습니다.', true); await load(); }) }, '추가')), box, list));
  load();
}

function viewAccount(main) {
  const box = h('div', { class: 'msg' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), pw = h('input', { type: 'password', autocomplete: 'new-password' });
  main.append(h('div', { class: 'card' }, h('h2', {}, '비밀번호 변경'), h('div', { class: 'row' }, h('label', {}, '현재 비밀번호', cur), h('label', {}, '새 비밀번호 (8자 이상)', pw),
    h('button', { class: 'btn', onclick: guard(box, async () => { await api('POST', '/api/password', { current: cur.value, password: pw.value }); cur.value = pw.value = ''; msg(box, '변경했습니다.', true); }) }, '변경')), box));
}

(async () => {
  try { state.me = await api('GET', '/api/me'); await loadLists(); state.tab = canEdit() ? 'input' : 'list'; } catch { state.me = null; }
  render();
})();
