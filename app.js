'use strict';
/* TT Money: หน้าแอพ (PWA) คุยกับ Apps Script API
 *
 * หลักการ "ลื่นแบบ realtime":
 *  - Optimistic UI: จด/แก้/ลบแล้วเห็นผลทันที (ยอดเงิน, สรุปเดือน, รายการ) ไม่ต้องรอ server
 *    ทุกการเปลี่ยนแปลงเป็น "op" ที่ซ้อนอยู่บนข้อมูลจาก server จนกว่า server จะยืนยันและดึงข้อมูลใหม่มาแล้ว
 *  - Stale-while-revalidate: โชว์ของที่ cache ไว้ก่อนเสมอ แล้วค่อยอัปเดตเบื้องหลัง
 *  - Polling: ดึงข้อมูลใหม่ทุก 30 วิ ตอนเปิดแอพอยู่ (แก้ใน Google Sheet ตรง ๆ ก็เห็นเอง)
 */

const APP_VERSION = '1.2.2';
const TYPE_LABEL = { Expense: 'รายจ่าย', Income: 'รายรับ', Transfer: 'โอนย้าย' };
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const RENT_CATEGORY = 'ค่าห้องรายเดือน';
const VIEWS = ['home', 'list', 'wallets'];
const POLL_MS = 60000;          // ดึงข้อมูลใหม่อัตโนมัติทุก 60 วิ (เฉพาะตอนเปิดแอพอยู่)
const MAX_CACHED_LISTS = 4;

// ------------------------------------------------------------ storage (ทนกรณี localStorage ใช้ไม่ได้)
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};
const clone = (o) => (o == null ? o : (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o))));
const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms || 10); } catch (e) { /* ignore */ } };

const S = {
  cfg: LS.get('ttm_cfg', null),          // { url, token }
  server: LS.get('ttm_boot', null),      // ผล bootstrap ล่าสุดจาก server (ใช้ตอนออฟไลน์)
  serverEpoch: 0,
  lists: {},                             // { 'YYYY-MM': { data, epoch } } cache รายการรายเดือน
  listErr: {},
  queue: LS.get('ttm_queue', []),        // รายการที่ยังส่งไม่ได้ (ออฟไลน์)
  ops: [],                               // การเปลี่ยนแปลงที่ยังไม่สะท้อนในข้อมูล server
  epoch: 0,                              // นับเพิ่มทุกครั้งที่ server ยืนยัน op
  boot: null,                            // = server + ops (สิ่งที่โชว์จริง)
  list: null,
  view: 'home',
  month: null,
  form: null,
  sending: 0,
  refreshing: false,
  lastRefresh: 0,
  lastTry: 0,
  installEvt: null,
  navDir: 'up',
  rendered: '',
  lastKey: '',
  deferRender: false,
  seenTx: new Set(),
  tweenPrev: {},
  barPrev: {},
  segPrev: null,
  openWallets: new Set(),  // กระเป๋าที่กางอยู่ (คงไว้หลังรีเฟรช)
  drafts: {}               // ค่าที่พิมพ์ค้างในหน้ากระเป๋า (ไม่หายเมื่อหน้ารีเฟรชเอง)
};
for (const [m, data] of Object.entries(LS.get('ttm_lists', {}))) S.lists[m] = { data, epoch: 0 };

// ------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const normDT = (s) => String(s || '').replace('T', ' ').slice(0, 16);
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function curMonth() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function monthLabel(m) { const [y, mo] = m.split('-'); return `${TH_MONTHS[+mo - 1]} ${y}`; }
function shiftMonth(m, k) { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const today = new Date(); const yst = new Date(); yst.setDate(today.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(dt, today)) return 'วันนี้';
  if (same(dt, yst)) return 'เมื่อวาน';
  return `${TH_DAYS[dt.getDay()]} ${d} ${TH_MONTHS[m - 1]}`;
}
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
const wallets = () => (S.boot && S.boot.wallets) || [];
const walletNames = () => wallets().map((w) => w.name);

// ------------------------------------------------------------ API
class ApiError extends Error { constructor(msg, offline) { super(msg); this.offline = !!offline; } }
async function api(action, args) {
  if (!S.cfg) throw new ApiError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ');
  let res;
  try {
    res = await fetch(S.cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // ไม่ทำให้เกิด CORS preflight
      body: JSON.stringify({ token: S.cfg.token, action, args: args || {} })
    });
  } catch (e) {
    throw new ApiError('เชื่อมต่อไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่', true);
  }
  if (!res.ok) throw new ApiError(`เซิร์ฟเวอร์ตอบกลับผิดพลาด (${res.status})`, res.status >= 500);
  let body;
  try { body = await res.json(); } catch (e) { throw new ApiError('อ่านคำตอบไม่ได้ ตรวจว่า URL ลงท้ายด้วย /exec และ Deploy แบบ Anyone'); }
  if (!body.ok) throw new ApiError(body.error === 'unauthorized' ? 'Token ไม่ถูกต้อง แก้ได้ที่หน้ากระเป๋า > ตั้งค่าการเชื่อมต่อ' : body.error);
  return body.data;
}

// ------------------------------------------------------------ optimistic ops
// op = { kind: 'add', items } | { kind: 'delete', tx } | { kind: 'update', before, after }
// op.confirmed = epoch ตอน server ยืนยัน (0 = ยังไม่ยืนยัน)
// snapshot ที่ดึงมาตอน epoch E มี op ที่ confirmed <= E อยู่แล้ว ไม่ต้องซ้อนซ้ำ
function localTx(item, key, i) {
  return { ...item, id: `tmp-${key}-${i}`, source: 'app', pending: true, dateTime: normDT(item.dateTime) };
}
const txKey = (t) => `${t.type}|${Number(t.amount)}|${normDT(t.dateTime)}|${t.note || ''}|${t.category || ''}`;
const liveOps = (epoch) => S.ops.filter((o) => !(o.confirmed && o.confirmed <= epoch));
function eachTx(op, fn) {
  if (op.kind === 'add') op.items.forEach((t) => fn(t, 1));
  else if (op.kind === 'delete') fn(op.tx, -1);
  else if (op.kind === 'update') { fn(op.before, -1); fn(op.after, 1); }
}
function upsertTx(arr, t, sign, cap) {
  const out = (arr || []).filter((x) => x.id !== t.id);
  if (sign < 0) return out;
  const k = normDT(t.dateTime);
  if (cap && out.length >= cap && k < normDT(out[out.length - 1].dateTime)) return out;   // เก่ากว่ารายการล่าสุดที่โชว์
  let i = out.findIndex((x) => normDT(x.dateTime) <= k);
  if (i < 0) i = out.length;
  out.splice(i, 0, t);
  return out;
}
function txIntoBoot(b, t, sign) {
  const ymd = normDT(t.dateTime).slice(0, 10);
  const amt = Number(t.amount) || 0;
  if (!b.startDate || ymd >= b.startDate) {
    const adj = (name, d) => {
      const w = (b.wallets || []).find((x) => x.name === name);
      if (!w) return;
      w.balance = round2(Number(w.balance || 0) + d);
      if (w.counted !== null && w.counted !== undefined && w.counted !== '') w.difference = round2(Number(w.counted) - w.balance);
    };
    if (t.type === 'Expense') adj(t.wallet, -amt * sign);
    else if (t.type === 'Income') adj(t.wallet, amt * sign);
    else if (t.type === 'Transfer') { adj(t.wallet, -amt * sign); adj(t.toWallet, amt * sign); }
  }
  const sm = b.summary;
  if (sm && ymd.slice(0, 7) === sm.month) {
    if (t.type === 'Expense') {
      const v = (Number(t.myShare !== undefined && t.myShare !== '' ? t.myShare : amt) || 0) * sign;
      sm.expenseTotal = round2(Number(sm.expenseTotal || 0) + v);
      let c = sm.expenseByCategory.find((x) => x.category === t.category);
      if (!c) { c = { category: t.category, amount: 0 }; sm.expenseByCategory.push(c); }
      c.amount = round2(c.amount + v);
      sm.expenseByCategory = sm.expenseByCategory.filter((x) => x.amount > 0.004).sort((a, z) => z.amount - a.amount);
    } else if (t.type === 'Income') sm.incomeTotal = round2(Number(sm.incomeTotal || 0) + amt * sign);
  }
  b.recent = upsertTx(b.recent, t, sign, 8);
}
function txIntoList(d, month, t, sign) {
  if (normDT(t.dateTime).slice(0, 7) !== month) return;
  d.items = upsertTx(d.items, t, sign);
}
function derive() {
  if (S.server) {
    const b = clone(S.server);
    for (const op of liveOps(S.serverEpoch)) eachTx(op, (t, s) => txIntoBoot(b, t, s));
    S.boot = b;
  } else S.boot = null;
  S.list = S.month ? deriveListFor(S.month) : null;
}
function deriveListFor(m) {
  const L = S.lists[m];
  if (!L) return null;
  const d = clone(L.data) || {};
  d.items = d.items || [];
  for (const op of liveOps(L.epoch)) eachTx(op, (t, s) => txIntoList(d, m, t, s));
  return { ...d, month: m };
}
function confirmOp(op) {
  op.confirmed = ++S.epoch;
  eachTx(op, (t) => { t.pending = false; t.queued = false; });
}
function dropOp(op) { S.ops = S.ops.filter((o) => o !== op); }
// หลังได้ bootstrap ใหม่: ทิ้ง op ที่ server มีแล้ว (list ที่ cache ไว้เก่ากว่านั้น ให้ "อบ" op ลงไปเลยจะได้ไม่หาย)
function pruneOps() {
  const keep = [];
  for (const op of S.ops) {
    if (op.confirmed && op.confirmed <= S.serverEpoch) {
      for (const [m, L] of Object.entries(S.lists)) {
        if (L.epoch < op.confirmed) { L.data = clone(L.data) || {}; L.dirty = true; eachTx(op, (t, s) => txIntoList(L.data, m, { ...t, pending: false }, s)); }
      }
    } else keep.push(op);
  }
  S.ops = keep;
}
function addOpFromBatch(batch, queued) {
  const op = { kind: 'add', key: batch.clientId, items: batch.items.map((it, i) => localTx(it, batch.clientId, i)), confirmed: 0 };
  if (queued) op.items.forEach((t) => { t.queued = true; });
  S.ops.push(op);
  return op;
}
S.queue.forEach((b) => addOpFromBatch(b, true));

// ------------------------------------------------------------ sync
function updateSync() {
  const el = $('#sync');
  let state = 'ok', text = '';
  if (!S.cfg) { el.textContent = ''; el.dataset.state = ''; return; }
  if (!navigator.onLine) { state = 'off'; text = 'ออฟไลน์'; }
  else if (S.sending) { state = 'busy'; text = 'กำลังบันทึก…'; }
  else if (S.refreshing) { state = 'busy'; text = 'กำลังซิงค์…'; }
  else if (S.lastRefresh) text = 'ล่าสุด ' + hhmm(S.lastRefresh);
  if (S.queue.length) { if (state !== 'off') state = 'pending'; text += (text ? ' · ' : '') + `รอส่ง ${S.queue.length}`; }
  el.dataset.state = state;
  el.textContent = text;
  $('#btn-refresh').classList.toggle('spin', !!S.refreshing);
}

let refreshP = null, refreshAgain = false;
function refresh(silent) {
  if (!S.cfg) return Promise.resolve();
  if (refreshP) { refreshAgain = true; return refreshP; }
  refreshP = (async () => {
    S.refreshing = true; updateSync();
    do {
      refreshAgain = false;
      const ep = S.epoch;
      S.lastTry = Date.now();
      try {
        const boot = await api('bootstrap');
        S.server = boot; S.serverEpoch = ep; S.lastRefresh = Date.now();
        LS.set('ttm_boot', boot);
        pruneOps();
      } catch (e) {
        if (!silent) toast(e.message);
      }
    } while (refreshAgain);
    S.refreshing = false; refreshP = null;
    updateSync();
    render({ bg: true });
    if (S.view === 'list' && S.month) loadList(S.month, true);
    else if (!S.lists[curMonth()] || S.lists[curMonth()].dirty) loadList(curMonth(), true);   // เตรียมไว้ สลับแท็บแล้วขึ้นทันที
  })();
  return refreshP;
}

const listLoading = {};
function saveLists() {
  const keep = Object.keys(S.lists).sort().reverse().slice(0, MAX_CACHED_LISTS);
  const out = {};
  for (const m of keep) out[m] = S.lists[m].data;
  LS.set('ttm_lists', out);
}
function loadList(month, bg) {
  if (!S.cfg) return Promise.resolve();
  if (listLoading[month]) return listLoading[month];
  const ep = S.epoch;
  listLoading[month] = (async () => {
    try {
      const r = await api('listTransactions', { month, limit: 500 });
      S.lists[month] = { data: r, epoch: ep };
      delete S.listErr[month];
      saveLists();
    } catch (e) {
      if (!S.lists[month]) S.listErr[month] = e.message;
      else if (!bg) toast(e.message);
    } finally {
      delete listLoading[month];
    }
    if (S.view === 'list' && S.month === month) render({ bg: true });
  })();
  return listLoading[month];
}

let flushing = false;
async function flushQueue() {
  if (flushing || !S.queue.length || !S.cfg) return;
  flushing = true;
  updateSync();
  try {
    while (S.queue.length) {
      const batch = S.queue[0];
      const op = S.ops.find((o) => o.key === batch.clientId);
      try {
        await api('addTransactions', { clientId: batch.clientId, items: batch.items });
        if (op) confirmOp(op);
      } catch (e) {
        if (e.offline) break;
        toast('ส่งรายการที่ค้างไม่สำเร็จ: ' + e.message);
        if (op) dropOp(op);
      }
      S.queue.shift();
      LS.set('ttm_queue', S.queue);
    }
  } finally {
    flushing = false;
    updateSync();
    render({ bg: true });
  }
}
const syncNow = (silent) => flushQueue().then(() => refresh(silent));

// ------------------------------------------------------------ toast
let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(h('span', null, msg));
  if (action) t.append(h('button', { type: 'button', onclick: () => { hideToast(); action.fn(); } }, action.label));
  clearTimeout(toastTimer);
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;            // ให้ animation เริ่มใหม่
  t.classList.add('show');
  toastTimer = setTimeout(hideToast, action ? 6000 : 3500);
}
function hideToast() {
  const t = $('#toast');
  t.classList.remove('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, reduceMotion() ? 0 : 260);
}

// ------------------------------------------------------------ animation helpers
function tween(el, from, to) {
  if (el._tw) cancelAnimationFrame(el._tw);
  const ints = Number.isInteger(from) && Number.isInteger(to);
  const t0 = performance.now(), dur = 700;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    const v = from + (to - from) * e;
    el.textContent = money(p < 1 && ints ? Math.round(v) : (p < 1 ? round2(v) : to));
    if (p < 1) el._tw = requestAnimationFrame(step);
  };
  el._tw = requestAnimationFrame(step);
}
function flash(el, up) {
  if (!el) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(up ? 'flash-up' : 'flash-down');
}
// ตัวเลขที่เปลี่ยน: นับขึ้น/ลงให้เห็น, แถบกราฟ: ยืดจากค่าเดิม, รายการใหม่: เลื่อนเข้ามา
function animateDynamic(root, entering) {
  const rm = reduceMotion();
  root.querySelectorAll('[data-tw]').forEach((el) => {
    const k = el.dataset.tw, to = Number(el.dataset.v);
    const from = S.tweenPrev[k];
    S.tweenPrev[k] = to;
    if (rm) return;
    if (from === undefined) { if (el.dataset.count === '1' && to) tween(el, 0, to); }
    else if (Math.abs(from - to) > 0.004) { tween(el, from, to); flash(el.closest('[data-flash]') || el, to > from); }
  });
  root.querySelectorAll('[data-bar]').forEach((el) => {
    const k = el.dataset.bar, w = Number(el.dataset.w);
    const from = entering ? 0 : (S.barPrev[k] !== undefined ? S.barPrev[k] : 0);
    S.barPrev[k] = w;
    if (rm) { el.style.width = w + '%'; return; }
    el.style.width = from + '%';
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = w + '%'; }));
  });
  root.querySelectorAll('[data-txk]').forEach((el) => {
    const k = el.dataset.txk;
    if (!entering && !rm && !S.seenTx.has(k)) el.classList.add('tx-new');
    S.seenTx.add(k);
  });
}
function skeleton(kind) {
  const rows = (n) => Array.from({ length: n }, () => h('div', { class: 'sk-row' }, h('span', { class: 'sk sk-a' }), h('span', { class: 'sk sk-b' })));
  if (kind === 'home') return [h('div', { class: 'sk sk-hero' }), h('div', { class: 'card' }, rows(3)), h('div', { class: 'card' }, rows(4))];
  return [h('div', { class: 'card' }, rows(7))];
}

// ------------------------------------------------------------ navigation / render
function go(view) {
  $('#btn-add').classList.remove('tuck');
  if (view === S.view && !$('#v-' + view).hidden) { window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); return; }
  const a = VIEWS.indexOf(S.view), b = VIEWS.indexOf(view);
  S.navDir = a < 0 || b < 0 ? 'up' : (b > a ? 'r' : 'l');
  S.view = view;
  if (view === 'list' && !S.month) S.month = curMonth();
  window.scrollTo(0, 0);
  render();
  if (view === 'list') loadList(S.month, !!S.lists[S.month]);
}
function moveMonth(k) {
  S.month = shiftMonth(S.month, k);
  S.navDir = k > 0 ? 'r' : 'l';
  buzz(6);
  render();
  loadList(S.month, !!S.lists[S.month]).then(() => {
    const next = shiftMonth(S.month, k);                       // ดึงเดือนถัดไปในทิศเดียวกันรอไว้
    if (!S.lists[next] && next <= curMonth()) loadList(next, true);
  });
}

function isEditingMain() {
  const a = document.activeElement;
  return !!(a && a !== document.body && $('#main').contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName));
}
function moveTabInk() {
  const i = VIEWS.indexOf(S.view);
  const ink = $('.tab-ink');
  if (ink) { ink.style.transform = `translateX(${Math.max(0, i) * 100}%)`; ink.style.opacity = i < 0 ? 0 : 1; }
}

function render(opts) {
  opts = opts || {};
  // กำลังพิมพ์อยู่ในหน้า: เลื่อนการวาดใหม่ไปหลังพิมพ์เสร็จ จะได้ไม่หลุดโฟกัส
  if (opts.bg && isEditingMain()) { S.deferRender = true; return; }
  S.deferRender = false;
  derive();
  const setup = !S.cfg || S.view === 'setup';
  const cur = setup ? 'setup' : S.view;
  const key = [cur, S.month, S.queue.length, !!S.installEvt, JSON.stringify(S.boot), JSON.stringify(S.list), S.listErr[S.month] || ''].join('|');
  if (opts.bg && key === S.lastKey) return;          // ข้อมูลไม่เปลี่ยน ไม่ต้องวาดใหม่ (ไม่กระพริบ)
  S.lastKey = key;

  for (const v of ['setup', 'home', 'list', 'wallets']) $('#v-' + v).hidden = cur !== v;
  $('#tabs').hidden = setup;
  $('#btn-add').hidden = setup || !S.boot;
  document.querySelectorAll('.tab').forEach((b) => {
    if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  moveTabInk();

  const el = $('#v-' + cur);
  const sig = cur + '|' + (cur === 'list' ? S.month : '');
  const entering = S.rendered !== sig;
  el.classList.remove('enter', 'enter-l', 'enter-r', 'enter-up');

  let ready = true;
  if (setup) renderSetup();
  else if (!S.boot) { el.replaceChildren(...skeleton(cur === 'home' ? 'home' : 'list')); ready = false; }
  else if (cur === 'home') renderHome();
  else if (cur === 'list') ready = renderList();
  else if (cur === 'wallets') renderWallets();

  if (entering && !reduceMotion()) {
    [...el.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 8)));
    void el.offsetWidth;
    el.classList.add('enter', 'enter-' + (S.navDir || 'up'));
  }
  if (ready) { S.rendered = sig; S.navDir = 'up'; }
  animateDynamic(el, entering);
}

// ------------------------------------------------------------ setup
function renderSetup() {
  const url = h('input', { class: 'input', id: 'cfg-url', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://script.google.com/macros/s/.../exec', value: S.cfg ? S.cfg.url : '' });
  const token = h('input', { class: 'input', id: 'cfg-token', type: 'password', autocomplete: 'off', value: S.cfg ? S.cfg.token : '' });
  const err = h('p', { class: 'err', hidden: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'เชื่อมต่อ');
  const form = h('form', { class: 'stack card', onsubmit: async (e) => {
    e.preventDefault();
    const u = url.value.trim(), t = token.value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(u)) { err.textContent = 'URL ต้องเป็นลิงก์ Web app ของ Apps Script ที่ลงท้ายด้วย /exec'; err.hidden = false; return; }
    if (t.length < 20) { err.textContent = 'Token สั้นเกินไป คัดลอกมาจาก Execution log ให้ครบ'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'กำลังเชื่อมต่อ…'; err.hidden = true;
    const prev = S.cfg;
    S.cfg = { url: u, token: t };
    try {
      const boot = await api('bootstrap');
      S.server = boot; S.serverEpoch = S.epoch; S.lastRefresh = S.lastTry = Date.now();
      LS.set('ttm_cfg', S.cfg); LS.set('ttm_boot', boot);
      S.view = 'home'; render(); updateSync(); toast('เชื่อมต่อแล้ว');
      flushQueue();
    } catch (ex) {
      S.cfg = prev; err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'เชื่อมต่อ';
    }
  } },
    h('div', { class: 'field' }, h('label', { for: 'cfg-url' }, 'Web app URL'), url),
    h('div', { class: 'field' }, h('label', { for: 'cfg-token' }, 'Token'), token,
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', onchange: (e) => { token.type = e.target.checked ? 'text' : 'password'; } }), 'แสดง token')),
    err, btn,
    S.cfg ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.view = 'wallets'; render(); } }, 'ยกเลิก') : null
  );
  $('#v-setup').replaceChildren(
    h('div', null,
      h('h2', { class: 'setup-title' }, 'เชื่อมแอพกับ Google Sheet'),
      h('p', { class: 'muted' }, 'ใส่ Web app URL และ Token จาก Apps Script ครั้งเดียว แอพจะจำไว้ในเครื่องนี้')),
    form);
}

// ------------------------------------------------------------ home
const tw = (key, value, cls, count) => h('span', { class: cls || null, 'data-tw': key, 'data-v': value, 'data-count': count ? '1' : null }, money(value));

function renderHome() {
  const b = S.boot;
  const ws = wallets();
  const total = round2(ws.reduce((s, w) => s + Number(w.balance || 0), 0));
  const savings = round2(ws.filter((w) => w.type === 'Savings').reduce((s, w) => s + Number(w.balance || 0), 0));
  const notStarted = ws.every((w) => !w.opening);
  const sm = b.summary;
  const maxCat = Math.max(1, ...sm.expenseByCategory.map((c) => c.amount));

  const els = [
    h('div', { class: 'hero', 'data-flash': '' },
      h('div', { class: 'hero-label' }, 'ยอดคงเหลือรวม'),
      h('div', { class: 'hero-amount num' }, h('small', null, '฿'), tw('total', total, null, true)),
      h('div', { class: 'hero-sub' },
        h('span', null, 'ใช้ได้ ', h('b', { class: 'num' }, tw('avail', round2(total - savings)))),
        h('span', null, 'เงินเก็บ ', h('b', { class: 'num' }, tw('sav', savings)))),
      dailyBox(ws, round2(total - savings))),
  ];
  if (notStarted) els.push(h('div', { class: 'notice' },
    'ยังไม่ได้ใส่ยอดตั้งต้นของกระเป๋า ยอดคงเหลือจะยังไม่ตรงกับเงินจริง',
    h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => go('wallets') }, 'ตั้งยอดตั้งต้น'))));
  if (S.queue.length) els.push(h('div', { class: 'notice' },
    `มี ${S.queue.length} รายการที่ยังไม่ได้ส่งขึ้น Google Sheet (บันทึกไว้ในเครื่องแล้ว)`,
    h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => syncNow(false) }, 'ส่งตอนนี้'))));

  els.push(h('section', null, h('h2', null, 'กระเป๋า'),
    h('div', { class: 'ledger' }, ws.map((w) => h('div', { class: 'ledger-row', 'data-flash': '' },
      h('span', { class: 'name' }, w.name),
      w.type === 'Savings' ? h('span', { class: 'tag' }, 'เงินเก็บ') : null,
      tw('w:' + w.name, Number(w.balance || 0), 'amt num' + (w.balance < 0 ? ' neg' : '')))))));

  els.push(h('section', { class: 'card' },
    h('h2', null, 'เดือนนี้ (' + monthLabel(sm.month) + ')'),
    h('div', { class: 'month-head' },
      h('span', { 'data-flash': '' }, 'จ่าย ', tw('exp', Number(sm.expenseTotal || 0), 'big num neg')),
      h('span', { 'data-flash': '' }, 'รับ ', tw('inc', Number(sm.incomeTotal || 0), 'big num pos'))),
    sm.expenseByCategory.length
      ? h('ul', { class: 'bars' }, sm.expenseByCategory.slice(0, 6).map((c) => h('li', null,
          h('span', null, c.category), h('span', { class: 'num' }, money(c.amount)),
          h('span', { class: 'bar', 'aria-hidden': 'true' },
            h('span', { 'data-bar': 'c:' + c.category, 'data-w': Math.max(2, c.amount / maxCat * 100) })))))
      : h('p', { class: 'muted' }, 'ยังไม่มีรายจ่ายเดือนนี้')));

  els.push(h('section', { class: 'card' }, h('h2', null, 'ล่าสุด'),
    b.recent.length ? h('ul', { class: 'tx-list' }, b.recent.slice(0, 8).map(txItem)) : h('p', { class: 'muted' }, 'ยังไม่มีรายการ กดปุ่ม จด เพื่อเริ่ม'),
    h('button', { class: 'link', type: 'button', onclick: () => go('list') }, 'ดูทั้งหมด →')));
  $('#v-home').replaceChildren(...els);
}

// งบวันนี้ = (เงินที่ใช้ได้ + ที่จ่ายไปแล้ววันนี้) ÷ จำนวนวันที่เหลือในเดือน (นับวันนี้ด้วย)
// บวกที่จ่ายวันนี้กลับเข้าไป จะได้ไม่ใช่ว่ายิ่งจ่าย งบวันนี้ยิ่งหด
function dailyBox(ws, avail) {
  const now = new Date();
  const today = ymdOf(now);
  const saving = new Set(ws.filter((w) => w.type === 'Savings').map((w) => w.name));
  const cm = deriveListFor(curMonth());
  const src = cm ? cm.items : (S.boot.recent || []);
  const spent = round2(src.filter((t) => t.type === 'Expense' && normDT(t.dateTime).slice(0, 10) === today && !saving.has(t.wallet))
    .reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = dim - now.getDate() + 1;
  if (avail + spent <= 0) return h('div', { class: 'daily over' }, h('div', { class: 'd-top' }, 'เงินที่ใช้ได้หมดแล้ว'),
    h('div', { class: 'd-sub' }, 'ลองโอนจากเงินเก็บ หรือรอรายรับเข้า'));
  const perDay = Math.floor((avail + spent) / daysLeft);
  const left = round2(perDay - spent);
  const pct = perDay > 0 ? Math.min(100, spent / perDay * 100) : 100;
  return h('div', { class: 'daily' + (left < 0 ? ' over' : pct >= 80 ? ' near' : '') },
    h('div', { class: 'd-top' },
      left >= 0
        ? [h('span', null, 'วันนี้ใช้ได้อีก'), h('b', { class: 'num' }, '฿', tw('dleft', left))]
        : [h('span', null, 'วันนี้ใช้เกินงบ'), h('b', { class: 'num' }, '฿', tw('dover', Math.abs(left)))]),
    h('div', { class: 'd-bar', 'aria-hidden': 'true' }, h('span', { 'data-bar': 'daily', 'data-w': pct })),
    h('div', { class: 'd-sub num' }, `จ่ายวันนี้ ${money(spent)} จากงบวันละ ${money(perDay)} · เหลือ ${daysLeft} วันในเดือน`));
}

function txItem(t, opts) {
  const sign = t.type === 'Expense' ? '−' : t.type === 'Income' ? '+' : '';
  const cls = t.type === 'Expense' ? 'neg' : t.type === 'Income' ? 'pos' : '';
  const title = t.type === 'Transfer'
    ? `${t.wallet || 'ไม่ระบุ'} ไป ${t.toWallet || 'ไม่ระบุ'}`
    : (t.note || t.category);
  const meta = [];
  if (t.type === 'Transfer') meta.push(t.category);
  else { meta.push(t.subCategory ? `${t.category} / ${t.subCategory}` : t.category); }
  meta.push(t.source === 'legacy' ? 'ประวัติเดิม' : t.wallet);
  if (t.dateTime && t.source !== 'legacy') meta.push(normDT(t.dateTime).slice(11, 16));
  if (t.type === 'Expense' && t.myShare !== undefined && Number(t.myShare) !== Number(t.amount)) meta.push(`ส่วนของฉัน ${money(t.myShare)}`);
  const status = t.queued ? 'รอส่ง' : t.pending ? 'กำลังบันทึก' : null;
  const busy = t.pending || t.queued;
  const li = h('li', { class: (busy ? 'is-pending' : '') + (opts && opts.del ? ' has-del' : '') || null, 'data-txk': txKey(t) },
    h('button', { class: 'tx', type: 'button', onclick: () => openEntry(t) },
      h('span', { class: 'tx-dot ' + (t.type || '').toLowerCase(), 'aria-hidden': 'true' }),
      h('span', { class: 't1' }, title),
      h('span', { class: 'a num ' + cls }, sign + money(t.amount)),
      h('span', { class: 't2' }, status ? h('span', { class: 'pend' }, status) : null, meta.filter(Boolean).join(', '))));
  if (opts && opts.del && !busy && !String(t.id || '').startsWith('tmp-')) li.append(delButton(t, li));
  return li;
}
// ปุ่มลบข้างรายการ: กดครั้งแรกเป็น "ลบ?" กดซ้ำภายใน 3 วิถึงจะลบจริง (กันนิ้วลั่น) แล้วยังกดเลิกทำได้อีก
const TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
function delButton(t, li) {
  const b = h('button', { type: 'button', class: 'tx-del', 'aria-label': 'ลบรายการ ' + (t.note || t.category || '') });
  b.innerHTML = TRASH;
  let timer = null;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!b.classList.contains('arm')) {
      buzz(8);
      b.classList.add('arm'); b.textContent = 'ลบ?'; b.setAttribute('aria-label', 'แตะอีกครั้งเพื่อยืนยันการลบ');
      timer = setTimeout(() => { b.classList.remove('arm'); b.innerHTML = TRASH; }, 3000);
      return;
    }
    clearTimeout(timer);
    li.classList.add('removing');
    setTimeout(() => deleteTx(t), reduceMotion() ? 0 : 220);
  });
  return b;
}

// ------------------------------------------------------------ list (+ ค้นหา)
const SEARCH_MONTHS = 12;
const share = (t) => Number(t.myShare !== undefined && t.myShare !== '' ? t.myShare : t.amount) || 0;
function txMatches(t, words) {
  const hay = [t.note, t.category, t.subCategory, t.wallet, t.toWallet, TYPE_LABEL[t.type], String(t.amount), money(t.amount)]
    .filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}
function groupByDay(items) {
  const groups = [];
  for (const t of items) {
    const d = normDT(t.dateTime).slice(0, 10);
    if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] });
    groups[groups.length - 1].items.push(t);
  }
  return groups.map((g) => {
    const dayExp = round2(g.items.filter((t) => t.type === 'Expense').reduce((s, t) => s + share(t), 0));
    const y = g.d.slice(0, 4) !== String(new Date().getFullYear()) ? ' ' + g.d.slice(0, 4) : '';
    return h('section', { class: 'card day-card' },
      h('div', { class: 'day' }, h('span', null, dayLabel(g.d) + y), dayExp ? h('span', { class: 'num' }, 'จ่าย ' + money(dayExp)) : null),
      h('ul', { class: 'tx-list' }, g.items.map((t) => txItem(t, { del: true }))));
  });
}

function renderList() {
  const el = $('#v-list');
  const head = h('div', { class: 'month-nav' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เดือนก่อน', onclick: () => moveMonth(-1) }, '‹'),
    h('strong', null, monthLabel(S.month)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เดือนถัดไป', onclick: () => moveMonth(1) }, '›'));
  const input = h('input', { class: 'search-in', id: 'search', type: 'search', enterkeyhint: 'search', autocomplete: 'off',
    placeholder: 'ค้นหา เช่น grab, กาแฟ, 55', value: S.q || '', 'aria-label': 'ค้นหารายการ' });
  const clear = h('button', { type: 'button', class: 'search-x', 'aria-label': 'ล้างคำค้น', hidden: !S.q }, '×');
  input.addEventListener('input', () => { S.q = input.value; clear.hidden = !S.q; fillListResults(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  clear.addEventListener('click', () => { S.q = ''; input.value = ''; clear.hidden = true; fillListResults(); input.focus(); });
  const bar = h('div', { class: 'search' },
    h('span', { class: 'search-ico', 'aria-hidden': 'true' }, '⌕'), input, clear);
  el.replaceChildren(head, bar, h('div', { id: 'list-results', class: 'list-results' }));
  return fillListResults();
}

// วาดเฉพาะผลลัพธ์ (ไม่แตะช่องค้นหา พิมพ์ไปเรื่อย ๆ คีย์บอร์ดจะไม่หุบ)
function fillListResults() {
  const box = $('#list-results');
  if (!box) return true;
  const q = (S.q || '').trim().toLowerCase();
  if (q) return fillSearch(box, q.split(/\s+/));
  S.list = deriveListFor(S.month);
  if (!S.list) {
    if (S.listErr[S.month]) {
      box.replaceChildren(h('div', { class: 'card stack' }, h('p', { class: 'err' }, S.listErr[S.month]),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { delete S.listErr[S.month]; render(); loadList(S.month); } }, 'ลองใหม่')));
      return true;
    }
    box.replaceChildren(...skeleton('list'));
    return false;
  }
  const items = S.list.items;
  if (!items.length) { box.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '🗒️'), h('p', { class: 'muted' }, 'ไม่มีรายการในเดือนนี้'))); return true; }
  const exp = round2(items.filter((t) => t.type === 'Expense').reduce((s, t) => s + share(t), 0));
  box.replaceChildren(
    h('p', { class: 'muted list-sum' }, `${items.length} รายการ · รายจ่ายรวม `, h('b', { class: 'num neg' }, tw('lexp:' + S.month, exp))),
    ...groupByDay(items));
  return true;
}

function fillSearch(box, words) {
  const scopeAll = S.searchScope === 'all';
  const months = scopeAll ? Array.from({ length: SEARCH_MONTHS }, (_, i) => shiftMonth(curMonth(), -i)) : [S.month];
  let items = [];
  let missing = 0;
  for (const m of months) {
    const L = deriveListFor(m);
    if (L) items = items.concat(L.items.filter((t) => txMatches(t, words)));
    else missing++;
  }
  items.sort((a, z) => normDT(z.dateTime).localeCompare(normDT(a.dateTime)));
  const scope = h('div', { class: 'chips' },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!scopeAll), onclick: () => { S.searchScope = 'month'; fillListResults(); } }, 'เฉพาะ ' + monthLabel(S.month)),
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(scopeAll), onclick: () => { S.searchScope = 'all'; loadSearchRange(); fillListResults(); } }, `ย้อนหลัง ${SEARCH_MONTHS} เดือน`));
  const exp = round2(items.filter((t) => t.type === 'Expense').reduce((s, t) => s + share(t), 0));
  const inc = round2(items.filter((t) => t.type === 'Income').reduce((s, t) => s + Number(t.amount || 0), 0));
  const summary = h('div', { class: 'card search-sum' },
    h('div', null, h('b', null, `พบ ${items.length} รายการ`), missing ? h('span', { class: 'muted loading-dots' }, ` กำลังโหลดอีก ${missing} เดือน`) : null),
    items.length ? h('div', { class: 'num' },
      exp ? h('span', null, 'จ่ายรวม ', h('b', { class: 'neg' }, money(exp))) : null,
      inc ? h('span', null, 'รับรวม ', h('b', { class: 'pos' }, money(inc))) : null) : null);
  const shown = items.slice(0, 200);
  box.replaceChildren(scope, summary,
    ...(items.length ? groupByDay(shown) : [h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '🔍'),
      h('p', { class: 'muted' }, scopeAll ? 'ไม่เจอรายการที่ตรงกัน' : 'ไม่เจอในเดือนนี้ ลองกด "ย้อนหลัง 12 เดือน"'))]),
    items.length > shown.length ? h('p', { class: 'muted' }, `แสดง 200 รายการล่าสุด พิมพ์คำค้นให้เจาะจงขึ้นเพื่อดูที่เหลือ`) : null);
  return true;
}

let rangeLoading = false;
async function loadSearchRange() {
  if (rangeLoading) return;
  const months = Array.from({ length: SEARCH_MONTHS }, (_, i) => shiftMonth(curMonth(), -i)).filter((m) => !S.lists[m]);
  if (!months.length) return;
  rangeLoading = true;
  // backend เวอร์ชันใหม่: ขอทุกเดือนในคำขอเดียว (อ่านชีตรอบเดียว)
  const ep = S.epoch;
  try {
    const r = await api('listTransactions', { months, limit: 500 });
    if (r && r.months) {
      for (const m of months) if (r.months[m]) { S.lists[m] = { data: r.months[m], epoch: ep }; delete S.listErr[m]; }
      saveLists();
      rangeLoading = false;
      if (S.view === 'list' && S.q) fillListResults();
      return;
    }
  } catch (e) { /* ใช้วิธีเดิมด้านล่าง */ }
  // backend เวอร์ชันเก่า: ขอทีละเดือน
  let i = 0;
  const worker = async () => {
    while (i < months.length) {
      const m = months[i++];
      await loadList(m, true);
      if (S.view === 'list' && S.q) fillListResults();
    }
  };
  await Promise.all([worker(), worker(), worker()]);   // โหลดทีละ 3 เดือนพร้อมกัน
  rangeLoading = false;
  if (S.view === 'list' && S.q) fillListResults();
}

// ------------------------------------------------------------ wallets
function renderWallets() {
  const b = S.boot;
  const busy = (btn, fn, keys) => async () => {
    btn.disabled = true; btn.classList.add('loading');
    try { await fn(); (keys || []).forEach((k) => { delete S.drafts[k]; }); await refresh(true); }
    catch (e) { toast(e.message); } finally { btn.disabled = false; btn.classList.remove('loading'); }
  };
  const dIn = (key, attrs, def) => h('input', { ...attrs, value: key in S.drafts ? S.drafts[key] : def,
    oninput: (e) => { S.drafts[key] = e.target.value; } });

  const startInput = dIn('start', { class: 'input', type: 'date', id: 'start-date' }, b.startDate || '');
  const startBtn = h('button', { class: 'btn ghost', type: 'button' }, 'บันทึก');
  startBtn.onclick = busy(startBtn, async () => {
    if (!startInput.value) throw new Error('เลือกวันที่ก่อน');
    await api('setStartDate', { date: startInput.value }); toast('บันทึกวันเริ่มใช้แล้ว');
  }, ['start']);

  const cards = wallets().map((w) => {
    const opening = dIn(w.name + ':opening', { class: 'input num', type: 'number', inputmode: 'decimal', step: '0.01' }, w.opening);
    const openBtn = h('button', { class: 'btn ghost', type: 'button' }, 'บันทึก');
    openBtn.onclick = busy(openBtn, async () => {
      if (opening.value === '' || !isFinite(Number(opening.value))) throw new Error('ใส่ยอดตั้งต้นเป็นตัวเลข');
      await api('setWalletOpening', { name: w.name, opening: Number(opening.value) }); toast('บันทึกยอดตั้งต้นแล้ว');
    }, [w.name + ':opening']);
    const counted = dIn(w.name + ':counted', { class: 'input num', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'ยอดในแอพธนาคารตอนนี้' }, w.counted === null ? '' : w.counted);
    const cntBtn = h('button', { class: 'btn ghost', type: 'button' }, 'เทียบ');
    cntBtn.onclick = busy(cntBtn, async () => {
      if (counted.value === '' || !isFinite(Number(counted.value))) throw new Error('ใส่ยอดจริงเป็นตัวเลข');
      await api('setCounted', { name: w.name, counted: Number(counted.value) });
    }, [w.name + ':counted']);
    const newName = dIn(w.name + ':name', { class: 'input', type: 'text', maxlength: '30' }, w.name);
    const renBtn = h('button', { class: 'btn ghost', type: 'button' }, 'เปลี่ยนชื่อ');
    renBtn.onclick = busy(renBtn, async () => {
      const to = newName.value.trim();
      if (!to || to === w.name) throw new Error('พิมพ์ชื่อใหม่ก่อน');
      const r = await api('renameWallet', { from: w.name, to });
      const m = LS.get('ttm_catWallet', {}); for (const k in m) if (m[k] === w.name) m[k] = to; LS.set('ttm_catWallet', m);
      S.openWallets.delete(w.name); S.openWallets.add(to);
      toast(`เปลี่ยนชื่อแล้ว อัปเดต ${r.transactionsUpdated} รายการ`);
    }, [w.name + ':name']);
    let diff = null;
    if (w.difference !== null && w.difference !== undefined) {
      diff = Math.abs(w.difference) < 0.005
        ? h('span', { class: 'diff-ok' }, 'ยอดตรง')
        : h('span', { class: 'diff-bad num' }, `ต่าง ${w.difference > 0 ? '+' : '−'}${money(Math.abs(w.difference))}`);
    }
    const body = h('div', { class: 'body stack' },
      h('p', { class: 'hint' }, `ยอดตามระบบ ${money(w.balance)} = ยอดตั้งต้น + รายการตั้งแต่วันเริ่มใช้`),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ยอดตั้งต้น (ณ วันเริ่มใช้)'), opening), openBtn),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ยอดจริงตอนนี้ (ไว้เทียบ)'), counted), cntBtn),
      w.difference && Math.abs(w.difference) >= 0.005
        ? h('p', { class: 'hint' }, w.difference < 0 ? 'เงินจริงน้อยกว่าในระบบ อาจมีรายจ่ายที่ลืมจด' : 'เงินจริงมากกว่าในระบบ อาจมีรายรับที่ลืมจด หรือจดรายจ่ายเกิน')
        : null,
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ชื่อกระเป๋า'), newName), renBtn));
    return h('details', { class: 'wallet', open: S.openWallets.has(w.name),
      ontoggle: (e) => {
        if (e.target.open) { S.openWallets.add(w.name); if (!reduceMotion()) { body.classList.remove('opening'); void body.offsetWidth; body.classList.add('opening'); } }
        else S.openWallets.delete(w.name);
      } },
      h('summary', { 'data-flash': '' }, h('span', { class: 'name' }, w.name), diff,
        tw('ww:' + w.name, Number(w.balance || 0), 'num' + (w.balance < 0 ? ' neg' : '')),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      body);
  });

  const addName = dIn('add:name', { class: 'input', type: 'text', maxlength: '30', placeholder: 'เช่น SCB' }, '');
  const addType = h('select', { class: 'input' }, ['Bank', 'E-wallet', 'Cash', 'Savings', 'Other'].map((t) => h('option', { value: t }, t)));
  const addBtn = h('button', { class: 'btn', type: 'button' }, 'เพิ่มกระเป๋า');
  addBtn.onclick = busy(addBtn, async () => {
    if (!addName.value.trim()) throw new Error('ใส่ชื่อกระเป๋าก่อน');
    await api('addWallet', { name: addName.value.trim(), type: addType.value, opening: 0 }); toast('เพิ่มกระเป๋าแล้ว');
  }, ['add:name']);

  const els = [
    h('section', { class: 'card' }, h('h2', null, 'วันเริ่มใช้แอพ'),
      h('p', { class: 'hint' }, 'ยอดคงเหลือนับเฉพาะรายการตั้งแต่วันนี้ ใส่ยอดตั้งต้นของทุกกระเป๋าเป็นยอดจริงตอนเช้าของวันนั้น'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, startInput), startBtn)),
    h('section', null, h('h2', null, 'กระเป๋าของฉัน'), cards),
    h('section', { class: 'card' }, h('h2', null, 'เพิ่มกระเป๋า'),
      h('div', { class: 'stack' }, addName, addType, addBtn)),
    h('section', { class: 'stack' }, h('h2', null, 'อื่น ๆ'),
      S.installEvt ? h('button', { class: 'btn', type: 'button', onclick: async () => { S.installEvt.prompt(); S.installEvt = null; render(); } }, 'ติดตั้งเป็นแอพบนหน้าจอ') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.view = 'setup'; render(); } }, 'ตั้งค่าการเชื่อมต่อ'),
      h('p', { class: 'hint' }, `TT Money ${APP_VERSION}`))
  ];
  $('#v-wallets').replaceChildren(...els);
}

// ------------------------------------------------------------ entry sheet (จด / แก้ไข)
// กระเป๋าเริ่มต้น = เงินสด; ถ้าหมวดนั้นเคยจ่ายด้วยกระเป๋าไหน จะเลือกกระเป๋านั้นให้ (เช่น Subscriptions = TrueMoney)
function defaultWallet() {
  const names = walletNames();
  return names.includes('เงินสด') ? 'เงินสด' : (names[0] || '');
}
function walletForCategory(cat, fallback) {
  const map = LS.get('ttm_catWallet', {});
  return map[cat] && walletNames().includes(map[cat]) ? map[cat] : fallback;
}

let sheetTimer = null;
const sheetOpen = () => !$('#sheet').hidden && !$('#sheet').classList.contains('closing');
function showSheet() {
  const s = $('#sheet');
  clearTimeout(sheetTimer);
  s.classList.remove('closing');
  s.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  const s = $('#sheet');
  if (s.hidden) return;
  document.body.style.overflow = '';
  if (reduceMotion()) { s.hidden = true; return; }
  s.classList.add('closing');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => { s.hidden = true; s.classList.remove('closing'); }, 230);
}

function openEntry(tx) {
  if (!S.boot) return;
  if (tx && (tx.pending || tx.queued || String(tx.id || '').startsWith('tmp-'))) { toast('รายการนี้กำลังซิงค์ แก้ได้ในอีกแป๊บนึงนะ'); return; }
  if (tx) {
    S.form = {
      editId: tx.id, orig: tx, legacy: tx.source === 'legacy', type: tx.type, amount: String(tx.amount), category: tx.category,
      subCategory: tx.subCategory || '', wallet: tx.wallet || '', toWallet: tx.toWallet || '', note: tx.note || '',
      dateTime: tx.dateTime ? normDT(tx.dateTime).replace(' ', 'T') : nowLocal(), split: tx.type === 'Expense' && Number(tx.myShare) !== Number(tx.amount),
      myShare: String(tx.myShare), topup: false, topupFrom: '', topupAmount: '', rentForMonth: tx.rentForMonth || '',
      customCat: false, timeNow: false, whenOpen: false
    };
  } else {
    S.form = {
      editId: null, legacy: false, type: 'Expense', amount: '', category: '', subCategory: '', wallet: defaultWallet(),
      toWallet: '', note: '', dateTime: nowLocal(), split: false, myShare: '', topup: false, topupFrom: '', topupAmount: '',
      rentForMonth: curMonth(), customCat: false, timeNow: true, whenOpen: false
    };
  }
  S.segPrev = null;
  showSheet();
  renderSheet();
}

function categoriesFor(type) {
  const list = (S.boot.categories || []).filter((c) => c.type === type).map((c) => c.category);
  if (type === 'Transfer' && !list.includes('โอนย้าย')) list.unshift('โอนย้าย');
  return [...new Set(list)];
}

function validate(f) {
  const amt = Number(f.amount);
  const names = walletNames();
  if (!(amt > 0) || !isFinite(amt)) return 'ใส่จำนวนเงินก่อน';
  if (f.type !== 'Transfer' && !f.category.trim()) return 'เลือกหมวดก่อน';
  if (!(f.legacy && !f.wallet) && !names.includes(f.wallet)) return 'เลือกกระเป๋าก่อน';
  if (f.type === 'Transfer') {
    if (!(f.legacy && !f.toWallet) && !names.includes(f.toWallet)) return 'เลือกกระเป๋าปลายทาง';
    if (f.toWallet && f.toWallet === f.wallet) return 'กระเป๋าต้นทางกับปลายทางต้องต่างกัน';
  }
  if (f.type === 'Expense' && f.split) {
    const m = Number(f.myShare);
    if (f.myShare === '' || !(m >= 0) || m > amt) return 'ส่วนของฉันต้องอยู่ระหว่าง 0 ถึงจำนวนเงิน';
  }
  if (f.type === 'Expense' && f.topup && !f.editId) {
    const ta = Number(f.topupAmount);
    if (!names.includes(f.topupFrom)) return 'เลือกกระเป๋าที่ถูกดึงเงินมาเติม';
    if (f.topupFrom === f.wallet) return 'กระเป๋าที่เติมต้องไม่ใช่กระเป๋าเดียวกับที่จ่าย';
    if (!(ta > 0)) return 'ใส่ยอดที่ถูกเติม';
  }
  if (!f.dateTime) return 'ใส่วันเวลา';
  return null;
}

function baseItem(f) {
  const amt = Number(f.amount);
  const it = {
    type: f.type, category: f.type === 'Transfer' ? (f.category || 'โอนย้าย') : f.category.trim(),
    subCategory: f.subCategory.trim(), amount: amt, wallet: f.wallet, note: f.note.trim(), dateTime: f.dateTime
  };
  it.toWallet = f.type === 'Transfer' ? f.toWallet : '';
  it.myShare = f.type === 'Expense' && f.split ? Number(f.myShare) : amt;
  it.rentForMonth = f.category === RENT_CATEGORY ? (f.rentForMonth || '') : '';
  return it;
}

function showEntryError(msg) {
  const el = $('#entry-err');
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  const d = $('#amount-display');
  if (d && !reduceMotion()) { d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }
  buzz([10, 40, 10]);
}
function reopenWithError(saved, msg) {
  S.form = saved; showSheet(); renderSheet();
  showEntryError(msg);
}

async function submitEntry() {
  const f = S.form;
  if (!f || !sheetOpen()) return;
  const problem = validate(f);
  if (problem) { showEntryError(problem); return; }
  if (f.wallet && f.type !== 'Transfer' && f.category) { const m = LS.get('ttm_catWallet', {}); m[f.category.trim()] = f.wallet; LS.set('ttm_catWallet', m); }
  if (f.timeNow) f.dateTime = f.dateTime.slice(0, 11) + nowHM();   // 'ตอนนี้' = เวลาตอนกดบันทึก
  const saved = { ...f };
  buzz(12);

  if (f.editId) {
    // แก้ไข: โชว์ผลทันที ถ้า server ไม่รับค่อยย้อนกลับ
    const op = { kind: 'update', before: f.orig, after: { ...f.orig, ...baseItem(f), dateTime: normDT(f.dateTime), pending: true }, confirmed: 0 };
    closeSheet();
    S.ops.push(op); render();
    S.sending++; updateSync();
    try {
      await api('updateTransaction', { id: f.editId, fields: baseItem(f) });
      confirmOp(op);
      toast('แก้ไขแล้ว');
    } catch (e) {
      dropOp(op); render();
      reopenWithError(saved, 'แก้ไขไม่สำเร็จ: ' + e.message);
    } finally { S.sending--; updateSync(); }
    refresh(true);
    return;
  }

  const items = [];
  if (f.type === 'Expense' && f.topup) {
    items.push({ type: 'Transfer', category: 'โอนย้าย', subCategory: 'เติมอัตโนมัติ', amount: Number(f.topupAmount),
      wallet: f.topupFrom, toWallet: f.wallet, note: 'เติมเงินเพื่อจ่าย ' + (f.note.trim() || f.category), dateTime: f.dateTime });
  }
  items.push(baseItem(f));
  const batch = { clientId: uid(), items };
  closeSheet();                 // ปิดทันที จะได้จดรายการต่อไปเร็ว ๆ
  const op = addOpFromBatch(batch, false);
  render();                     // ยอดเงิน/สรุป/รายการ อัปเดตทันทีไม่ต้องรอ server
  toast(`จดแล้ว ${f.type === 'Income' ? '+' : f.type === 'Expense' ? '−' : ''}${money(f.amount)} ${f.note.trim() || f.category || ''}`);
  S.sending++; updateSync();
  try {
    await api('addTransactions', batch);
    confirmOp(op);
    render({ bg: true });
  } catch (e) {
    if (e.offline) {
      S.queue.push(batch); LS.set('ttm_queue', S.queue);
      op.items.forEach((t) => { t.queued = true; });
      render({ bg: true });
      toast('ยังไม่มีเน็ต เก็บรายการไว้ในเครื่องก่อน จะส่งให้เองเมื่อออนไลน์');
    } else {
      dropOp(op); render();
      reopenWithError(saved, 'บันทึกไม่สำเร็จ: ' + e.message);
    }
  } finally {
    S.sending--; updateSync();
  }
  refresh(true);
}

async function deleteEntry() {
  const tx = S.form.orig;
  closeSheet();
  deleteTx(tx);
}
async function deleteTx(tx) {
  const id = tx.id;
  const op = { kind: 'delete', tx, confirmed: 0 };
  S.ops.push(op); render();
  buzz(15);
  const done = api('deleteTransaction', { id }).then(() => { confirmOp(op); return true; }, (e) => {
    dropOp(op); render(); toast('ลบไม่สำเร็จ: ' + e.message); return false;
  });
  toast('ลบรายการแล้ว', { label: 'เลิกทำ', fn: async () => {
    const back = { kind: 'add', items: [{ ...tx, pending: true }], confirmed: 0 };
    S.ops.push(back); render();
    try {
      if (await done) await api('restoreTransaction', { id });
      confirmOp(back); toast('กู้คืนแล้ว');
    } catch (e) { dropOp(back); render(); toast(e.message); }
    refresh(true);
  } });
  if (await done) refresh(true);
}

function keyPress(k) {
  const f = S.form;
  let a = f.amount;
  if (k === 'del') a = a.slice(0, -1);
  else if (k === '.') { if (!a.includes('.')) a = (a || '0') + '.'; }
  else {
    if (a.includes('.') && a.split('.')[1].length >= 2) return;
    if (a.replace('.', '').length >= 9) return;
    a = a === '0' ? k : a + k;
  }
  f.amount = a;
  updateAmount(true);
}
function updateAmount(bump) {
  const d = $('#amount-display');
  if (!d) return;
  const a = S.form.amount;
  d.classList.toggle('empty', !a);
  let shown = '0';
  if (a) {
    const [i, dec] = a.split('.');
    shown = Number(i || 0).toLocaleString('th-TH') + (a.includes('.') ? '.' + (dec || '') : '');
  }
  d.replaceChildren(h('small', null, '฿'), h('span', { class: 'amt' }, shown));
  if (bump && !reduceMotion()) { d.classList.remove('bump', 'shake'); void d.offsetWidth; d.classList.add('bump'); }
  const save = $('#entry-save');
  if (save) save.replaceChildren(...[h('span', null, 'บันทึก'), Number(a) > 0 ? h('small', { class: 'num' }, '฿' + shown) : null].filter(Boolean));
  $('#entry-err').hidden = true;
}

// ไอคอนหมวด: ไอคอนเส้นสไตล์เดียวกับแท็บด้านล่าง + สีประจำหมวด (h = hue)
// เดาจากชื่อหมวด เรียงจากเจาะจงไปกว้าง (ข้อแรกที่ตรงชนะ) ไม่เจอใช้ตัวอักษรแรกของชื่อ
const ICONS = {
  food: { h: 22, d: '<path d="M3.5 12h17a8.5 8.5 0 0 1-17 0z"/><path d="M13 9.5 16 3M15.5 9.5 20.5 4.5"/>' },
  coffee: { h: 30, d: '<path d="M5 9h11v4.5A5.5 5.5 0 0 1 10.5 19h0A5.5 5.5 0 0 1 5 13.5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3.5c-.8 1 .8 2 0 3M12.5 3.5c-.8 1 .8 2 0 3"/>' },
  drink: { h: 15, d: '<path d="M6.5 8h11l-1.3 12.5H7.8z"/><path d="M5.5 8h13M13 8l1.5-5H17"/>' },
  car: { h: 210, d: '<path d="M5 11l2-5h10l2 5"/><rect x="3" y="11" width="18" height="6" rx="2"/><path d="M6.5 17v2M17.5 17v2"/><circle cx="7.5" cy="14" r=".7" fill="currentColor"/><circle cx="16.5" cy="14" r=".7" fill="currentColor"/>' },
  home: { h: 265, d: '<path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z"/>' },
  bill: { h: 45, d: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>' },
  phone: { h: 215, d: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>' },
  sub: { h: 330, d: '<rect x="3" y="4.5" width="18" height="13" rx="2.5"/><path d="M10 8.5v5l4.2-2.5z"/><path d="M8 21h8"/>' },
  game: { h: 275, d: '<path d="M7 8h10a4 4 0 0 1 4 4v1.5a2.8 2.8 0 0 1-5 1.7L14.8 14H9.2L8 15.2a2.8 2.8 0 0 1-5-1.7V12a4 4 0 0 1 4-4z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11" r=".7" fill="currentColor"/><circle cx="17" cy="13" r=".7" fill="currentColor"/>' },
  shop: { h: 340, d: '<path d="M5 8h14l-1 12.5H6z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/>' },
  study: { h: 195, d: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v13H6.5A1.5 1.5 0 0 0 5 18.5z"/><path d="M5 18.5A1.5 1.5 0 0 0 6.5 20H19v-3"/><path d="M9 8h6"/>' },
  health: { h: 0, d: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/>' },
  gadget: { h: 185, d: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.5"/>' },
  gift: { h: 350, d: '<rect x="4" y="9" width="16" height="11.5" rx="1.5"/><path d="M3 9h18M12 9v11.5"/><path d="M12 9C10 5 6.5 4.5 6.5 7S10 9 12 9c2 0 5.5-.5 5.5-2S14 5 12 9z"/>' },
  fun: { h: 300, d: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3 9.5h4.5M3 14.5h4.5M16.5 9.5H21M16.5 14.5H21"/>' },
  pet: { h: 35, d: '<circle cx="6" cy="10" r="1.8"/><circle cx="9.5" cy="6" r="1.8"/><circle cx="14.5" cy="6" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M12 11c-3 0-5.5 4-5.5 6.5 0 1.5 1.5 2.5 3 2l2.5-.8 2.5.8c1.5.5 3-.5 3-2C17.5 15 15 11 12 11z"/>' },
  salary: { h: 145, d: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>' },
  work: { h: 160, d: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18"/>' },
  refund: { h: 175, d: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>' },
  transfer: { h: 225, d: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>' },
  saving: { h: 150, d: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v5.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 11.5V17c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5.5"/>' },
  more: { h: 220, d: '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>' },
  plus: { h: 220, d: '<path d="M12 5v14M5 12h14"/>' }
};
const CAT_ICON_RULES = [
  [/ชาบู|หมูกระทะ|ปิ้งย่าง|บุฟเฟ่ต์/i, 'food'],
  [/กาแฟ|coffee|cafe|คาเฟ่|ลาเต้|อเมริกาโน่/i, 'coffee'],
  [/ชานม|ชาไข่มุก|ชาเย็น|เครื่องดื่ม|น้ำปั่น|drink|^ชา/i, 'drink'],
  [/อาหาร|ข้าว|กิน|ก๋วยเตี๋ยว|food|ขนม|ของกิน|มื้อ/i, 'food'],
  [/เดินทาง|grab|bolt|วิน|รถ|bts|mrt|แท็กซี่|taxi|น้ำมัน|ทางด่วน/i, 'car'],
  [/ห้อง|เช่า|หอพัก|บ้าน|rent/i, 'home'],
  [/มือถือ|โทรศัพท์|ค่าโทร|ซิม|เน็ต|internet|wifi/i, 'phone'],
  [/ค่าไฟ|ไฟฟ้า|ค่าน้ำ|ประปา|บิล|bill/i, 'bill'],
  [/subscri|spotify|netflix|youtube|icloud|สมาชิก|premium/i, 'sub'],
  [/เกม|game|steam/i, 'game'],
  [/หูฟัง|gadget|อุปกรณ์|ไอที|\bit\b|คอม|มือถือใหม่/i, 'gadget'],
  [/ช้อป|shop|ของใช้|เสื้อ|ผ้า|lazada|shopee|ของแต่ง/i, 'shop'],
  [/เรียน|หนังสือ|ค่าเทอม|การศึกษา|study|ติว/i, 'study'],
  [/ยา|หมอ|โรงพยาบาล|สุขภาพ|health|คลินิก|ฟิตเนส/i, 'health'],
  [/ของขวัญ|gift|ทำบุญ|บริจาค|ให้เพื่อน/i, 'gift'],
  [/เที่ยว|travel|ตั๋ว|หนัง|บันเทิง|คอนเสิร์ต/i, 'fun'],
  [/แมว|หมา|สัตว์|pet/i, 'pet'],
  [/เงินเดือน|salary|ที่บ้าน|ค่าขนม|พ่อ|แม่/i, 'salary'],
  [/เสริม|ฟรีแลนซ์|freelance|ขาย|งาน|โบนัส/i, 'work'],
  [/คืน|refund|ดอกเบี้ย|ปันผล|cashback/i, 'refund'],
  [/โอน|transfer/i, 'transfer'],
  [/ออม|เก็บ|saving|ลงทุน/i, 'saving'],
  [/^อื่น/i, 'more']
];
function catIconKey(name) {
  for (const [re, key] of CAT_ICON_RULES) if (re.test(name || '')) return key;
  return null;
}
function svgIcon(key, size) {
  const s = size || 22;
  const span = h('span', { class: 'svg-ic', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key].d}</svg>`;
  return span;
}
// กล่องไอคอนของหมวด: ไอคอน + สี ถ้าไม่รู้จักหมวดใช้ตัวอักษรแรกบนสีที่คำนวณจากชื่อ (หมวดเดิมได้สีเดิมเสมอ)
function catBadge(name, key) {
  key = key || catIconKey(name);
  let hue = key ? ICONS[key].h : 0;
  if (!key) for (const ch of String(name || '')) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  const box = h('span', { class: 'ci', style: `--h:${hue}` });
  if (key) box.append(svgIcon(key));
  else box.append(h('b', null, (String(name || '?').trim().replace(/^[เแโใไ]+/, '') || '?').slice(0, 1)));   // ข้ามสระหน้า
  return box;
}

// วันเวลา: แถบวันให้จิ้ม + ช่วงเวลาสำเร็จรูป แทน datetime picker ของมือถือ
const TIME_SLOTS = [['เช้า', '08:00'], ['เที่ยง', '12:00'], ['บ่าย', '15:00'], ['เย็น', '18:00'], ['ค่ำ', '21:00']];
const ymdOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowHM = () => nowLocal().slice(11, 16);
function whenLabel(f) {
  const [d, t] = f.dateTime.split('T');
  const day = dayLabel(d);
  if (f.timeNow && d === ymdOf(new Date())) return `${day} · ตอนนี้`;
  const slot = TIME_SLOTS.find((s) => s[1] === t);
  return `${day} · ${slot ? slot[0] + ' ' : ''}${t} น.`;
}
function shiftTime(t, mins) {
  const [hh, mm] = t.split(':').map(Number);
  let x = (hh * 60 + mm + mins) % 1440; if (x < 0) x += 1440;
  return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
}
function whenPanel(f, set) {
  const [d, t] = f.dateTime.split('T');
  const today = new Date();
  const days = [];
  for (let i = 0; i < 14; i++) { const x = new Date(); x.setDate(today.getDate() - i); days.push(x); }
  const dayBtn = (x) => {
    const ymd = ymdOf(x);
    const i = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(x.getFullYear(), x.getMonth(), x.getDate())) / 864e5);
    return h('button', { type: 'button', class: 'day-chip', 'aria-pressed': String(ymd === d),
      onclick: () => set({ dateTime: ymd + 'T' + (f.timeNow && i !== 0 ? '12:00' : f.dateTime.slice(11, 16)), timeNow: f.timeNow && i === 0 }) },
      h('span', { class: 'dw' }, i === 0 ? 'วันนี้' : i === 1 ? 'เมื่อวาน' : TH_DAYS[x.getDay()]),
      h('b', { class: 'num' }, x.getDate()),
      h('span', { class: 'dm' }, TH_MONTHS[x.getMonth()]));
  };
  const strip = h('div', { class: 'day-strip' }, days.map(dayBtn));
  if (!days.some((x) => ymdOf(x) === d)) {        // วันที่เลือกเก่ากว่า 2 สัปดาห์: โชว์ไว้หน้าสุด
    const [y, m, dd] = d.split('-').map(Number);
    strip.prepend(dayBtn(new Date(y, m - 1, dd)));
  }
  const other = h('input', { type: 'date', class: 'sr-date', 'aria-label': 'เลือกวันอื่น', max: ymdOf(today), value: d,
    onchange: (e) => { if (e.target.value) set({ dateTime: e.target.value + 'T' + f.dateTime.slice(11, 16), timeNow: false }); } });
  strip.append(h('label', { class: 'day-chip other' }, h('span', { class: 'dw' }, 'วันอื่น'), h('b', null, '📅'), h('span', { class: 'dm' }, 'ปฏิทิน'), other));
  other.addEventListener('click', () => { try { other.showPicker(); } catch (e) { /* บาง browser เปิดเอง */ } });

  const isToday = d === ymdOf(today);
  const slots = h('div', { class: 'chips' },
    isToday ? h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!f.timeNow), onclick: () => set({ dateTime: d + 'T' + nowHM(), timeNow: true }) }, 'ตอนนี้') : null,
    TIME_SLOTS.map(([lbl, hm]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!f.timeNow && t === hm),
      onclick: () => set({ dateTime: d + 'T' + hm, timeNow: false }) }, `${lbl} ${hm.slice(0, 2)}`)));
  const step = (mins, label) => h('button', { type: 'button', class: 'step', 'aria-label': label,
    onclick: () => set({ dateTime: f.dateTime.slice(0, 11) + shiftTime(f.dateTime.slice(11, 16), mins), timeNow: false }) }, mins > 0 ? '+' : '−');
  // ช่องชั่วโมง/นาที แตะแล้วพิมพ์ได้เลย (ชั่วโมงครบ 2 หลักจะข้ามไปช่องนาทีให้)
  const tin = (val, label) => h('input', { class: 'tf-in num', type: 'text', inputmode: 'numeric', autocomplete: 'off', 'aria-label': label, value: val });
  const hIn = tin(t.slice(0, 2), 'ชั่วโมง'), mIn = tin(t.slice(3, 5), 'นาที');
  const commit = () => {
    const hh = Math.min(23, Math.max(0, parseInt(hIn.value, 10) || 0));
    const mm = Math.min(59, Math.max(0, parseInt(mIn.value, 10) || 0));
    f.dateTime = d + 'T' + pad(hh) + ':' + pad(mm);
    f.timeNow = false;
    const pill = $('.when-pill span:nth-child(2)');
    if (pill) pill.textContent = whenLabel(f);
  };
  for (const inp of [hIn, mIn]) {
    // แตะแล้วพิมพ์ทับได้เลย: ตัวเลขตัวแรกที่พิมพ์จะล้างค่าเดิมก่อน
    inp.addEventListener('focus', () => { inp._fresh = true; try { inp.select(); } catch (e) { /* ignore */ } });
    inp.addEventListener('beforeinput', (e) => {
      if (inp._fresh && e.inputType === 'insertText') { inp.value = ''; }
      inp._fresh = false;
    });
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 2);
      commit();
      if (inp === hIn && inp.value.length === 2) mIn.focus();
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('blur', () => { commit(); inp.value = pad(inp === hIn ? f.dateTime.slice(11, 13) : f.dateTime.slice(14, 16)); });
  }
  const fine = h('div', { class: 'time-fine' },
    h('div', { class: 'tf-group' }, step(-60, 'ลดชั่วโมง'), h('div', { class: 'tf-val' }, hIn, h('span', null, 'ชม.')), step(60, 'เพิ่มชั่วโมง')),
    h('b', { class: 'tf-colon' }, ':'),
    h('div', { class: 'tf-group' }, step(-5, 'ลด 5 นาที'), h('div', { class: 'tf-val' }, mIn, h('span', null, 'นาที')), step(5, 'เพิ่ม 5 นาที')));
  return h('div', { class: 'when-panel' },
    h('span', { class: 'lbl' }, 'วันไหน'), strip,
    h('span', { class: 'lbl' }, 'กี่โมง'), slots, fine, h('p', { class: 'hint tf-hint' }, 'แตะตัวเลขเพื่อพิมพ์เวลาเองได้'),
    h('button', { type: 'button', class: 'btn when-done', onclick: () => set({ whenOpen: false }) }, 'เสร็จ'));
}

function renderSheet() {
  const f = S.form;
  const set = (patch, rerender = true) => { Object.assign(f, patch); if (rerender) { const y = $('.sheet-scroll') ? $('.sheet-scroll').scrollTop : 0; renderSheet(); $('.sheet-scroll').scrollTop = y; } };
  const types = ['Expense', 'Income', 'Transfer'];
  const idx = types.indexOf(f.type);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'ชนิดรายการ', 'data-type': f.type },
    h('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
    types.map((t) => h('button', {
      type: 'button', 'aria-pressed': String(f.type === t), disabled: f.editId && f.legacy ? true : null,
      onclick: () => { if (f.type !== t) { buzz(6); set({ type: t, category: '', subCategory: '', customCat: false, split: false, topup: false }); } }
    }, TYPE_LABEL[t])));
  const from = S.segPrev === null ? idx : S.segPrev;
  seg.style.setProperty('--i', from);
  if (from !== idx) requestAnimationFrame(() => requestAnimationFrame(() => seg.style.setProperty('--i', idx)));
  S.segPrev = idx;

  const section = (label, ...kids) => h('div', { class: 'sec' }, h('span', { class: 'lbl' }, label), ...kids);
  const walletChips = (selected, onPick, exclude) => h('div', { class: 'chips scroll' },
    walletNames().filter((n) => n !== exclude).map((n) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === selected), onclick: () => { buzz(5); onPick(n); } }, n)));

  const body = [];
  // วันเวลา: แสดงเป็นปุ่มเดียว แตะแล้วกางให้เลือก
  body.push(h('button', { type: 'button', class: 'when-pill' + (f.whenOpen ? ' open' : ''), 'aria-expanded': String(!!f.whenOpen), onclick: () => set({ whenOpen: !f.whenOpen }) },
    h('span', { 'aria-hidden': 'true' }, '🕒'), h('span', null, whenLabel(f)), h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
  if (f.whenOpen) body.push(whenPanel(f, set));

  // ปุ่มจดเร็ว
  const presets = (S.boot.presets || []).filter((p) => p.type === f.type);
  if (!f.editId && presets.length) {
    body.push(section('จดเร็ว', h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'จดเร็ว' }, presets.map((p) => h('button', {
      type: 'button', class: 'stamp', onclick: () => { buzz(6); set({
        category: p.category, subCategory: p.subCategory || '', note: p.label, customCat: false,
        amount: p.amount ? String(p.amount) : f.amount,
        wallet: p.wallet && walletNames().includes(p.wallet) ? p.wallet : (f.walletTouched ? f.wallet : walletForCategory(p.category, f.wallet))
      }); }
    }, h('b', null, catIconKey(p.category) ? svgIcon(catIconKey(p.category), 16) : null, p.label), h('span', { class: 'num' }, p.amount ? '฿' + money(p.amount) : p.category))))));
  }

  if (f.type === 'Transfer') {
    body.push(section('จากกระเป๋า', walletChips(f.wallet, (n) => set({ wallet: n }))));
    body.push(section('ไปกระเป๋า', walletChips(f.toWallet, (n) => set({ toWallet: n }), f.wallet)));
    const tc = categoriesFor('Transfer');
    if (tc.length > 1) body.push(section('หมวด', h('div', { class: 'chips' }, tc.map((c) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(c === (f.category || 'โอนย้าย')), onclick: () => set({ category: c }) }, c)))));
  } else {
    // หมวด: ช่องไอคอนใหญ่ จิ้มง่าย
    const all = categoriesFor(f.type);
    if (f.category && !f.customCat && !all.includes(f.category)) all.unshift(f.category);
    const TOP = 7;   // หมวดเรียงตามที่ใช้บ่อยที่สุด
    let cats = f.showAllCats ? all : all.slice(0, TOP);
    if (!f.showAllCats && f.category && !cats.includes(f.category) && all.includes(f.category)) cats = [...cats, f.category];
    const tile = (label, badge, pressed, onclick, cls) => h('button', { type: 'button', class: 'cat' + (cls ? ' ' + cls : ''), 'aria-pressed': pressed === null ? null : String(pressed), onclick },
      badge, h('span', { class: 'cl' }, label));
    const grid = h('div', { class: 'cat-grid' },
      cats.map((c) => tile(c, catBadge(c), !f.customCat && c === f.category, () => { buzz(5); set({
        category: c, subCategory: f.category === c ? f.subCategory : '', customCat: false,
        wallet: f.walletTouched || f.editId ? f.wallet : walletForCategory(c, f.wallet) }); })),
      all.length > cats.length ? tile(`อื่น ๆ (${all.length - cats.length})`, catBadge('', 'more'), null, () => set({ showAllCats: true }), 'ghost') : null,
      tile('หมวดใหม่', catBadge('', 'plus'), !!f.customCat, () => set({ customCat: true, category: '' }), 'ghost'));
    body.push(section('หมวด', grid,
      f.customCat ? h('input', { class: 'input', type: 'text', placeholder: 'พิมพ์ชื่อหมวดใหม่', value: f.category, oninput: (e) => { f.category = e.target.value; } }) : null));
    body.push(section(f.type === 'Income' ? 'เข้ากระเป๋า' : 'จ่ายจากกระเป๋า',
      f.legacy && !f.wallet ? h('p', { class: 'hint' }, 'ประวัติเดิมไม่มีข้อมูลกระเป๋า เลือกได้ถ้าจำได้') : null,
      walletChips(f.wallet, (n) => set({ wallet: n, walletTouched: true }))));
  }
  if (f.category === RENT_CATEGORY) {
    body.push(h('div', { class: 'field' }, h('label', { for: 'rent-month', class: 'lbl' }, 'เป็นค่าห้องของเดือน'),
      h('input', { class: 'input', id: 'rent-month', type: 'month', value: f.rentForMonth, onchange: (e) => { f.rentForMonth = e.target.value; } })));
  }
  body.push(h('div', { class: 'field' }, h('label', { for: 'note', class: 'lbl' }, 'โน้ต (ไม่ใส่ก็ได้)'),
    h('input', { class: 'input', id: 'note', type: 'text', maxlength: '120', enterkeyhint: 'done', placeholder: 'เช่น ข้าวมันไก่ หน้ามอ', value: f.note, oninput: (e) => { f.note = e.target.value; } })));

  // ตัวเลือกเสริม: เป็นปุ่มเปิด/ปิด แทนลิงก์ยาว ๆ
  if (f.type !== 'Transfer') {
    const opt = (key, label, on, patch) => h('button', { type: 'button', class: 'chip opt', 'aria-pressed': String(!!on), onclick: () => set(patch) }, label);
    const opts = [opt('sub', 'หมวดย่อย', f.showSub || !!f.subCategory, { showSub: !(f.showSub || f.subCategory) })];
    if (f.type === 'Expense') {
      opts.push(opt('split', 'หารกับเพื่อน', f.split, { split: !f.split, myShare: !f.split && !f.myShare ? String(Math.round(Number(f.amount || 0) / 2 * 100) / 100) : f.myShare }));
      if (!f.editId) opts.push(opt('topup', 'เงินไม่พอ ดึงจากกระเป๋าอื่น', f.topup, { topup: !f.topup }));
    }
    body.push(section('ตัวเลือกเสริม', h('div', { class: 'chips' }, opts)));
    if (f.showSub || f.subCategory) {
      const subs = (S.boot.subCategories || []).filter((s) => s.type === f.type && s.category === f.category).map((s) => s.subCategory);
      body.push(h('div', { class: 'field sub-box' }, h('label', { for: 'sub', class: 'lbl' }, 'หมวดย่อย'),
        subs.length ? h('div', { class: 'chips' }, subs.map((s) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(s === f.subCategory), onclick: () => set({ subCategory: s === f.subCategory ? '' : s }) }, s))) : null,
        h('input', { class: 'input', id: 'sub', type: 'text', placeholder: 'หรือพิมพ์เอง', value: f.subCategory, oninput: (e) => { f.subCategory = e.target.value; } })));
    }
    if (f.type === 'Expense' && f.split) {
      const amt = Number(f.amount || 0);
      body.push(h('div', { class: 'field sub-box' }, h('label', { for: 'share', class: 'lbl' }, 'ส่วนของฉัน (บาท)'),
        amt > 0 ? h('div', { class: 'chips' }, [2, 3, 4].map((n) => {
          const v = String(Math.round(amt / n * 100) / 100);
          return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.myShare === v), onclick: () => set({ myShare: v }) }, `หาร ${n} = ${money(v)}`);
        })) : null,
        h('input', { class: 'input num', id: 'share', type: 'number', inputmode: 'decimal', step: '0.01', value: f.myShare, oninput: (e) => { f.myShare = e.target.value; } }),
        h('p', { class: 'hint' }, 'ยอดในกระเป๋าลดตามจำนวนเงินเต็ม ส่วนสรุปรายจ่ายนับแค่ส่วนของฉัน')));
    }
    if (f.type === 'Expense' && f.topup && !f.editId) {
      body.push(h('div', { class: 'field sub-box' }, h('span', { class: 'lbl' }, 'ดึงเงินมาจาก'), walletChips(f.topupFrom, (n) => set({ topupFrom: n }), f.wallet),
        h('label', { for: 'topup', class: 'lbl' }, 'ยอดที่ถูกเติม (บาท)'),
        h('input', { class: 'input num', id: 'topup', type: 'number', inputmode: 'decimal', step: '0.01', value: f.topupAmount, oninput: (e) => { f.topupAmount = e.target.value; } }),
        h('p', { class: 'hint' }, `บันทึกเป็น 2 รายการ: โอนย้าย ${f.topupFrom || '...'} ไป ${f.wallet || '...'} และรายจ่ายจาก ${f.wallet || '...'}`)));
    }
  }
  if (f.editId) body.push(h('button', { type: 'button', class: 'btn danger', onclick: deleteEntry }, 'ลบรายการนี้'));
  body.push(h('p', { class: 'err', id: 'entry-err', hidden: true }));

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
  const keypad = h('div', { class: 'keypad' },
    keys.map((k) => h('button', { type: 'button', 'aria-label': k === 'del' ? 'ลบตัวเลข' : null, onclick: () => keyPress(k) }, k === 'del' ? '⌫' : k)),
    h('button', { type: 'button', class: 'save', id: 'entry-save', onclick: submitEntry }, 'บันทึก'));

  const btnClose = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'ปิด', onclick: closeSheet });
  btnClose.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>';
  const sheet = $('#sheet');
  sheet.dataset.type = f.type;
  sheet.classList.remove('typing');
  sheet.replaceChildren(
    h('div', { class: 'sheet-head' }, btnClose, seg),
    h('div', { id: 'amount-display', class: 'amount-display num', 'aria-live': 'polite' }),
    h('div', { class: 'sheet-scroll' }, body),
    keypad);
  updateAmount(false);
}

// ตอนพิมพ์ข้อความ (โน้ต ฯลฯ) ซ่อนแป้นตัวเลข จะได้ไม่เบียดกับคีย์บอร์ดมือถือ
$('#sheet').addEventListener('focusin', (e) => {
  if (e.target.matches('input[type="text"], input[type="number"]')) $('#sheet').classList.add('typing');
});
$('#sheet').addEventListener('focusout', () => {
  setTimeout(() => { if (!$('#sheet').contains(document.activeElement) || !document.activeElement.matches('input')) $('#sheet').classList.remove('typing'); }, 50);
});

// ------------------------------------------------------------ gestures
// ดึงลงเพื่อรีเฟรช
(function pullToRefresh() {
  const ind = $('#ptr');
  const TH = 64;
  let y0 = null, dist = 0;
  const reset = () => { ind.classList.add('back'); ind.style.transform = ''; ind.style.opacity = '0'; ind.classList.remove('ready'); };
  window.addEventListener('touchstart', (e) => {
    y0 = null;
    if (!S.cfg || S.view === 'setup' || !$('#sheet').hidden || window.scrollY > 0 || e.touches.length !== 1) return;
    y0 = e.touches[0].clientY; dist = 0;
    ind.classList.remove('back');
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || window.scrollY > 0) { dist = 0; ind.style.opacity = '0'; ind.style.transform = ''; return; }
    dist = Math.min(110, dy * 0.5);
    ind.style.opacity = String(Math.min(1, dist / TH));
    ind.style.transform = `translate(-50%, ${dist}px) rotate(${dist * 4}deg)`;
    const ready = dist >= TH;
    if (ready && !ind.classList.contains('ready')) buzz(8);
    ind.classList.toggle('ready', ready);
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    if (dist >= TH) {
      ind.classList.add('back', 'loading');
      ind.style.transform = `translate(-50%, ${TH * 0.8}px)`;
      syncNow(false).finally(() => { ind.classList.remove('loading'); reset(); });
    } else reset();
    dist = 0;
  });
})();

// ปัดซ้าย/ขวาที่หน้ารายการ = เปลี่ยนเดือน
(function swipeMonths() {
  const v = $('#v-list');
  let x0 = null, y0 = 0;
  v.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  v.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) moveMonth(dx < 0 ? 1 : -1);
  });
})();

// เลื่อนลงแล้วซ่อนปุ่มจด / หัวแอพมีเงาเมื่อเลื่อน
(function scrollChrome() {
  let lastY = 0, ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const fab = $('#btn-add');
      if (y > lastY + 6 && y > 120) fab.classList.add('tuck');
      else if (y < lastY - 6 || y < 40) fab.classList.remove('tuck');
      $('.top').classList.toggle('scrolled', y > 4);
      lastY = y; ticking = false;
    });
  }, { passive: true });
})();

// ------------------------------------------------------------ boot
document.addEventListener('keydown', (e) => {
  if (!sheetOpen()) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (/^[0-9]$/.test(e.key)) keyPress(e.key);
  else if (e.key === '.') keyPress('.');
  else if (e.key === 'Backspace') keyPress('del');
  else if (e.key === 'Enter') submitEntry();
  else if (e.key === 'Escape') closeSheet();
});
$('#main').addEventListener('focusout', () => {
  setTimeout(() => { if (S.deferRender && !isEditingMain()) render({ bg: true }); }, 0);
});
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { buzz(5); go(b.dataset.view); }));
$('#btn-add').addEventListener('click', () => { buzz(8); openEntry(null); });
$('#btn-refresh').addEventListener('click', () => syncNow(false));
window.addEventListener('online', () => { updateSync(); syncNow(true); });
window.addEventListener('offline', updateSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.cfg && Date.now() - S.lastTry > 5000) syncNow(true);
});
// Polling: เปิดแอพค้างไว้ก็ได้ข้อมูลล่าสุดเอง (รวมถึงที่แก้ใน Google Sheet ตรง ๆ)
setInterval(() => {
  if (document.visibilityState !== 'visible' || !navigator.onLine || !S.cfg || S.view === 'setup') return;
  if (Date.now() - S.lastTry >= POLL_MS) syncNow(true);
  else updateSync();
}, 5000);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.view === 'wallets') render(); });
// อัปเดตแอพ: เช็คเวอร์ชันใหม่ทุกครั้งที่กลับมาเปิดแอพ (มือถือมักไม่ได้ปิดแอพจริง แค่พักไว้เบื้องหลัง)
// พอเวอร์ชันใหม่พร้อม ขึ้นปุ่มให้แตะโหลดใหม่ (ไม่รีโหลดเอง เผื่อกำลังจดอยู่)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('มีเวอร์ชันใหม่ของแอพ', { label: 'โหลดใหม่', fn: () => location.reload() });
    hadController = true;
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});      // เช็คทันทีตอนเปิด (ไม่รอเบราว์เซอร์ ซึ่งอาจเช็คช้าไปหนึ่งรอบ)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

render();
updateSync();
if (S.cfg) syncNow(true);
