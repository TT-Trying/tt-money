'use strict';
/* TT Money: หน้าแอพ (PWA) คุยกับ Apps Script API
 *
 * หลักการ "ลื่นแบบ realtime":
 *  - Optimistic UI: จด/แก้/ลบแล้วเห็นผลทันที (ยอดเงิน, สรุปเดือน, รายการ) ไม่ต้องรอ server
 *    ทุกการเปลี่ยนแปลงเป็น "op" ที่ซ้อนอยู่บนข้อมูลจาก server จนกว่า server จะยืนยันและดึงข้อมูลใหม่มาแล้ว
 *  - Stale-while-revalidate: โชว์ของที่ cache ไว้ก่อนเสมอ แล้วค่อยอัปเดตเบื้องหลัง
 *  - Polling: ดึงข้อมูลใหม่ทุก 30 วิ ตอนเปิดแอพอยู่ (แก้ใน Google Sheet ตรง ๆ ก็เห็นเอง)
 */

const APP_VERSION = '1.1.0';
const TYPE_LABEL = { Expense: 'รายจ่าย', Income: 'รายรับ', Transfer: 'โอนย้าย' };
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const RENT_CATEGORY = 'ค่าห้องรายเดือน';
const VIEWS = ['home', 'list', 'wallets'];
const POLL_MS = 30000;          // ดึงข้อมูลใหม่อัตโนมัติทุก 30 วิ (เฉพาะตอนเปิดแอพอยู่)
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
  const L = S.month && S.lists[S.month];
  if (L) {
    const d = clone(L.data) || {};
    d.items = d.items || [];
    for (const op of liveOps(L.epoch)) eachTx(op, (t, s) => txIntoList(d, S.month, t, s));
    S.list = { ...d, month: S.month };
  } else S.list = null;
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
  for (const m of Object.keys(S.lists)) if (!keep.includes(m)) delete S.lists[m];
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
        h('span', null, 'เงินเก็บ ', h('b', { class: 'num' }, tw('sav', savings))))),
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

function txItem(t) {
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
  return h('li', { class: t.pending || t.queued ? 'is-pending' : null, 'data-txk': txKey(t) },
    h('button', { class: 'tx', type: 'button', onclick: () => openEntry(t) },
      h('span', { class: 'tx-dot ' + (t.type || '').toLowerCase(), 'aria-hidden': 'true' }),
      h('span', { class: 't1' }, title),
      h('span', { class: 'a num ' + cls }, sign + money(t.amount)),
      h('span', { class: 't2' }, status ? h('span', { class: 'pend' }, status) : null, meta.filter(Boolean).join(', '))));
}

// ------------------------------------------------------------ list
function renderList() {
  const el = $('#v-list');
  const head = h('div', { class: 'month-nav' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เดือนก่อน', onclick: () => moveMonth(-1) }, '‹'),
    h('strong', null, monthLabel(S.month)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เดือนถัดไป', onclick: () => moveMonth(1) }, '›'));
  if (!S.list) {
    if (S.listErr[S.month]) {
      el.replaceChildren(head, h('div', { class: 'card stack' }, h('p', { class: 'err' }, S.listErr[S.month]),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { delete S.listErr[S.month]; render(); loadList(S.month); } }, 'ลองใหม่')));
      return true;
    }
    el.replaceChildren(head, ...skeleton('list'));
    return false;
  }
  const items = S.list.items;
  if (!items.length) { el.replaceChildren(head, h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '🗒️'), h('p', { class: 'muted' }, 'ไม่มีรายการในเดือนนี้'))); return true; }
  const groups = [];
  for (const t of items) {
    const d = normDT(t.dateTime).slice(0, 10);
    if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] });
    groups[groups.length - 1].items.push(t);
  }
  const share = (t) => Number(t.myShare !== undefined && t.myShare !== '' ? t.myShare : t.amount) || 0;
  const exp = round2(items.filter((t) => t.type === 'Expense').reduce((s, t) => s + share(t), 0));
  el.replaceChildren(head,
    h('p', { class: 'muted list-sum' }, `${items.length} รายการ · รายจ่ายรวม `, h('b', { class: 'num neg' }, tw('lexp:' + S.month, exp))),
    ...groups.map((g) => {
      const dayExp = round2(g.items.filter((t) => t.type === 'Expense').reduce((s, t) => s + share(t), 0));
      return h('section', { class: 'card day-card' },
        h('div', { class: 'day' }, h('span', null, dayLabel(g.d)), dayExp ? h('span', { class: 'num' }, 'จ่าย ' + money(dayExp)) : null),
        h('ul', { class: 'tx-list' }, g.items.map(txItem)));
    }));
  return true;
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
      more: false, customCat: false
    };
  } else {
    S.form = {
      editId: null, legacy: false, type: 'Expense', amount: '', category: '', subCategory: '', wallet: defaultWallet(),
      toWallet: '', note: '', dateTime: nowLocal(), split: false, myShare: '', topup: false, topupFrom: '', topupAmount: '',
      rentForMonth: curMonth(), more: false, customCat: false
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
  const id = S.form.editId;
  closeSheet();
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
  $('#entry-err').hidden = true;
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
  // ให้ปุ่มเลื่อนจากตำแหน่งเดิมไปตำแหน่งใหม่
  const from = S.segPrev === null ? idx : S.segPrev;
  seg.style.setProperty('--i', from);
  if (from !== idx) requestAnimationFrame(() => requestAnimationFrame(() => seg.style.setProperty('--i', idx)));
  S.segPrev = idx;

  const chips = (values, selected, onPick, extra) => h('div', { class: 'chips' },
    values.map((v) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(v === selected), onclick: () => onPick(v) }, v)), extra || null);

  const walletChips = (selected, onPick, exclude) => h('div', { class: 'chips scroll' },
    walletNames().filter((n) => n !== exclude).map((n) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === selected), onclick: () => onPick(n) }, n)));

  const body = [];
  // ปุ่มจดเร็ว
  const presets = (S.boot.presets || []).filter((p) => p.type === f.type);
  if (!f.editId && presets.length) {
    body.push(h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'จดเร็ว' }, presets.map((p) => h('button', {
      type: 'button', class: 'stamp', onclick: () => { buzz(6); set({
        category: p.category, subCategory: p.subCategory || '', note: p.label, customCat: false,
        amount: p.amount ? String(p.amount) : f.amount,
        wallet: p.wallet && walletNames().includes(p.wallet) ? p.wallet : (f.walletTouched ? f.wallet : walletForCategory(p.category, f.wallet))
      }); }
    }, h('b', null, p.label), h('span', { class: 'num' }, p.amount ? '฿' + money(p.amount) : p.category)))));
  }

  if (f.type === 'Transfer') {
    body.push(h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'จากกระเป๋า'), walletChips(f.wallet, (n) => set({ wallet: n }))));
    body.push(h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ไปกระเป๋า'), walletChips(f.toWallet, (n) => set({ toWallet: n }), f.wallet)));
    body.push(h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'หมวด'),
      chips(categoriesFor('Transfer'), f.category || 'โอนย้าย', (c) => set({ category: c }))));
  } else {
    // กระเป๋าก่อน (เห็นทันทีไม่ต้องเลื่อน) แล้วค่อยหมวด
    body.push(h('div', { class: 'field' }, h('span', { class: 'lbl' }, f.type === 'Income' ? 'เข้ากระเป๋า' : 'จ่ายจากกระเป๋า'),
      f.legacy && !f.wallet ? h('p', { class: 'hint' }, 'ประวัติเดิมไม่มีข้อมูลกระเป๋า เลือกได้ถ้าจำได้') : null,
      walletChips(f.wallet, (n) => set({ wallet: n, walletTouched: true }))));
    const all = categoriesFor(f.type);
    if (f.category && !f.customCat && !all.includes(f.category)) all.unshift(f.category);
    const TOP = 10;   // หมวดเรียงตามที่ใช้บ่อยที่สุด
    let cats = f.showAllCats ? all : all.slice(0, TOP);
    if (!f.showAllCats && f.category && !cats.includes(f.category) && all.includes(f.category)) cats = [...cats, f.category];
    const customInput = h('input', { class: 'input', type: 'text', placeholder: 'ชื่อหมวดใหม่', value: f.customCat ? f.category : '',
      oninput: (e) => { f.category = e.target.value; } });
    body.push(h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'หมวด'),
      chips(cats, f.customCat ? null : f.category, (c) => set({ category: c, subCategory: f.category === c ? f.subCategory : '', customCat: false,
        wallet: f.walletTouched || f.editId ? f.wallet : walletForCategory(c, f.wallet) }),
        [all.length > TOP && !f.showAllCats ? h('button', { type: 'button', class: 'chip', onclick: () => set({ showAllCats: true }) }, `หมวดอื่น ๆ (${all.length - cats.length})`) : null,
         h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!f.customCat), onclick: () => set({ customCat: true, category: '' }) }, '+ หมวดใหม่')]),
      f.customCat ? customInput : null));
  }
  if (f.category === RENT_CATEGORY) {
    body.push(h('div', { class: 'field' }, h('label', { for: 'rent-month', class: 'lbl' }, 'เป็นค่าห้องของเดือน'),
      h('input', { class: 'input', id: 'rent-month', type: 'month', value: f.rentForMonth, onchange: (e) => { f.rentForMonth = e.target.value; } })));
  }
  body.push(h('div', { class: 'field' }, h('label', { for: 'note', class: 'lbl' }, 'โน้ต'),
    h('input', { class: 'input', id: 'note', type: 'text', maxlength: '120', placeholder: 'เช่น ข้าวมันไก่ หน้ามอ', value: f.note, oninput: (e) => { f.note = e.target.value; } })));

  // ตัวเลือกเพิ่มเติม
  const subs = (S.boot.subCategories || []).filter((s) => s.type === f.type && s.category === f.category).map((s) => s.subCategory);
  const more = [];
  more.push(h('div', { class: 'field' }, h('label', { for: 'dt', class: 'lbl' }, 'วันเวลา'),
    h('input', { class: 'input', id: 'dt', type: 'datetime-local', value: f.dateTime, onchange: (e) => { f.dateTime = e.target.value; } })));
  if (f.type !== 'Transfer') {
    more.push(h('div', { class: 'field' }, h('label', { for: 'sub', class: 'lbl' }, 'หมวดย่อย (ไม่ใส่ก็ได้)'),
      h('input', { class: 'input', id: 'sub', type: 'text', list: 'sub-list', value: f.subCategory, oninput: (e) => { f.subCategory = e.target.value; } }),
      h('datalist', { id: 'sub-list' }, subs.map((s) => h('option', { value: s })))));
  }
  if (f.type === 'Expense') {
    more.push(h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: f.split ? true : null,
      onchange: (e) => set({ split: e.target.checked, myShare: e.target.checked && !f.myShare ? String(Math.round(Number(f.amount || 0) / 2 * 100) / 100) : f.myShare }) }),
      'หารกับเพื่อน (ใส่เฉพาะส่วนของฉัน)'));
    if (f.split) more.push(h('div', { class: 'field' }, h('label', { for: 'share', class: 'lbl' }, 'ส่วนของฉัน (บาท)'),
      h('input', { class: 'input num', id: 'share', type: 'number', inputmode: 'decimal', step: '0.01', value: f.myShare, oninput: (e) => { f.myShare = e.target.value; } }),
      h('p', { class: 'hint' }, 'ยอดในกระเป๋าลดตามจำนวนเงินเต็ม ส่วนสรุปรายจ่ายนับแค่ส่วนของฉัน')));
    if (!f.editId) {
      more.push(h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: f.topup ? true : null, onchange: (e) => set({ topup: e.target.checked }) }),
        'เงินในกระเป๋าไม่พอ ถูกดึงจากกระเป๋าอื่นมาเติม'));
      if (f.topup) {
        more.push(h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ดึงเงินมาจาก'), walletChips(f.topupFrom, (n) => set({ topupFrom: n }), f.wallet)));
        more.push(h('div', { class: 'field' }, h('label', { for: 'topup', class: 'lbl' }, 'ยอดที่ถูกเติม (บาท)'),
          h('input', { class: 'input num', id: 'topup', type: 'number', inputmode: 'decimal', step: '0.01', value: f.topupAmount, oninput: (e) => { f.topupAmount = e.target.value; } }),
          h('p', { class: 'hint' }, `บันทึกเป็น 2 รายการ: โอนย้าย ${f.topupFrom || '...'} ไป ${f.wallet || '...'} และรายจ่ายจาก ${f.wallet || '...'}`)));
      }
    }
  }
  const moreOpen = f.more || f.split || f.topup || !!f.editId;
  body.push(moreOpen
    ? h('div', { class: 'more stack' }, more)
    : h('button', { type: 'button', class: 'link', onclick: () => set({ more: true }) }, 'เพิ่มเติม: เวลา, หมวดย่อย, หาร, เติมจากกระเป๋าอื่น'));
  if (f.editId) body.push(h('button', { type: 'button', class: 'btn danger', onclick: deleteEntry }, 'ลบรายการนี้'));
  body.push(h('p', { class: 'err', id: 'entry-err', hidden: true }));

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
  const keypad = h('div', { class: 'keypad' },
    keys.map((k) => h('button', { type: 'button', 'aria-label': k === 'del' ? 'ลบตัวเลข' : null, onclick: () => keyPress(k) }, k === 'del' ? '⌫' : k)),
    h('button', { type: 'button', class: 'save', id: 'entry-save', onclick: submitEntry }, 'บันทึก'));

  const btnClose = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'ปิด', onclick: closeSheet });
  btnClose.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>';
  $('#sheet').dataset.type = f.type;
  $('#sheet').replaceChildren(
    h('div', { class: 'sheet-head' }, btnClose, seg),
    h('div', { id: 'amount-display', class: 'amount-display num', 'aria-live': 'polite' }),
    h('div', { class: 'sheet-scroll' }, body),
    keypad);
  updateAmount(false);
}

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
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

render();
updateSync();
if (S.cfg) syncNow(true);
