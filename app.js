'use strict';
/* TT Money: หน้าแอพ (PWA) คุยกับ Apps Script API */

const APP_VERSION = '1.0.0';
const TYPE_LABEL = { Expense: 'รายจ่าย', Income: 'รายรับ', Transfer: 'โอนย้าย' };
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const RENT_CATEGORY = 'ค่าห้องรายเดือน';

// ------------------------------------------------------------ storage (ทนกรณี localStorage ใช้ไม่ได้)
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

const S = {
  cfg: LS.get('ttm_cfg', null),          // { url, token }
  boot: LS.get('ttm_boot', null),        // ผล bootstrap ล่าสุด (ใช้ตอนออฟไลน์)
  queue: LS.get('ttm_queue', []),        // รายการที่ยังส่งไม่ได้
  view: 'home',
  month: null,
  list: null,
  form: null,
  sending: 0,
  lastRefresh: 0,
  installEvt: null,
  openWallets: new Set(),  // กระเป๋าที่กางอยู่ (คงไว้หลังรีเฟรช)
  drafts: {}               // ค่าที่พิมพ์ค้างในหน้ากระเป๋า (ไม่หายเมื่อหน้ารีเฟรชเอง)
};

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
const money = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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

function setSync(text) { $('#sync').textContent = text; }
function updateSync() {
  const parts = [];
  if (S.sending) parts.push('กำลังบันทึก…');
  if (S.queue.length) parts.push(`รอส่ง ${S.queue.length}`);
  if (!navigator.onLine) parts.push('ออฟไลน์');
  setSync(parts.join('  '));
}

async function refresh(silent) {
  if (!S.cfg) return;
  setSync('กำลังโหลด…');
  try {
    S.boot = await api('bootstrap');
    S.lastRefresh = Date.now();
    LS.set('ttm_boot', S.boot);
    if (S.view === 'list') await loadList();
  } catch (e) {
    if (!silent) toast(e.message);
  }
  updateSync();
  render();
}

let flushing = false;
async function flushQueue() {
  if (flushing || !S.queue.length || !S.cfg) return;
  flushing = true;
  try {
    while (S.queue.length) {
      const batch = S.queue[0];
      try {
        await api('addTransactions', { clientId: batch.clientId, items: batch.items });
      } catch (e) {
        if (e.offline) break;
        toast('ส่งรายการที่ค้างไม่สำเร็จ: ' + e.message);
      }
      S.queue.shift();
      LS.set('ttm_queue', S.queue);
    }
  } finally {
    flushing = false;
    updateSync();
  }
}

// ------------------------------------------------------------ toast
let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(h('span', null, msg));
  if (action) t.append(h('button', { type: 'button', onclick: () => { t.hidden = true; action.fn(); } }, action.label));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3500);
}

// ------------------------------------------------------------ navigation / render
function go(view) {
  S.view = view;
  if (view === 'list' && !S.month) S.month = curMonth();
  render();
  if (view === 'list') loadList().then(render);
  window.scrollTo(0, 0);
}

function render() {
  const setup = !S.cfg || S.view === 'setup';
  for (const v of ['setup', 'home', 'list', 'wallets']) $('#v-' + v).hidden = (setup ? 'setup' : S.view) !== v;
  $('#tabs').hidden = setup;
  $('#btn-add').hidden = setup || !S.boot;
  document.querySelectorAll('.tab').forEach((b) => b.toggleAttribute('aria-current', b.dataset.view === S.view));
  document.querySelectorAll('.tab').forEach((b) => { if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page'); });
  if (setup) return renderSetup();
  if (!S.boot) { $('#v-' + S.view).replaceChildren(h('p', { class: 'muted' }, 'กำลังโหลดข้อมูลครั้งแรก…')); return; }
  if (S.view === 'home') renderHome();
  if (S.view === 'list') renderList();
  if (S.view === 'wallets') renderWallets();
}

// ------------------------------------------------------------ setup
function renderSetup() {
  const url = h('input', { class: 'input', id: 'cfg-url', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://script.google.com/macros/s/.../exec', value: S.cfg ? S.cfg.url : '' });
  const token = h('input', { class: 'input', id: 'cfg-token', type: 'password', autocomplete: 'off', value: S.cfg ? S.cfg.token : '' });
  const err = h('p', { class: 'err', hidden: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'เชื่อมต่อ');
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const u = url.value.trim(), t = token.value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(u)) { err.textContent = 'URL ต้องเป็นลิงก์ Web app ของ Apps Script ที่ลงท้ายด้วย /exec'; err.hidden = false; return; }
    if (t.length < 20) { err.textContent = 'Token สั้นเกินไป คัดลอกมาจาก Execution log ให้ครบ'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'กำลังเชื่อมต่อ…'; err.hidden = true;
    const prev = S.cfg;
    S.cfg = { url: u, token: t };
    try {
      S.boot = await api('bootstrap');
      LS.set('ttm_cfg', S.cfg); LS.set('ttm_boot', S.boot);
      S.view = 'home'; render(); toast('เชื่อมต่อแล้ว');
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
      h('h2', { style: 'font-size:22px;color:var(--ink)' }, 'เชื่อมแอพกับ Google Sheet'),
      h('p', { class: 'muted' }, 'ใส่ Web app URL และ Token จาก Apps Script ครั้งเดียว แอพจะจำไว้ในเครื่องนี้')),
    form);
}

// ------------------------------------------------------------ home
function renderHome() {
  const b = S.boot;
  const ws = wallets();
  const total = ws.reduce((s, w) => s + w.balance, 0);
  const savings = ws.filter((w) => w.type === 'Savings').reduce((s, w) => s + w.balance, 0);
  const notStarted = ws.every((w) => !w.opening);
  const sm = b.summary;
  const maxCat = Math.max(1, ...sm.expenseByCategory.map((c) => c.amount));

  const els = [
    h('div', { class: 'total' },
      h('div', { class: 'total-label' }, 'ยอดคงเหลือรวม'),
      h('div', { class: 'total-amount num' }, h('small', null, '฿'), money(total)),
      h('div', { class: 'total-sub' },
        h('span', null, 'ใช้ได้ ', h('b', { class: 'num' }, money(total - savings))),
        h('span', null, 'เงินเก็บ ', h('b', { class: 'num' }, money(savings))))),
  ];
  if (notStarted) els.push(h('div', { class: 'notice' },
    'ยังไม่ได้ใส่ยอดตั้งต้นของกระเป๋า ยอดคงเหลือจะยังไม่ตรงกับเงินจริง',
    h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => go('wallets') }, 'ตั้งยอดตั้งต้น'))));
  if (S.queue.length) els.push(h('div', { class: 'notice' },
    `มี ${S.queue.length} รายการที่ยังไม่ได้ส่งขึ้น Google Sheet (บันทึกไว้ในเครื่องแล้ว)`,
    h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => flushQueue().then(() => refresh(true)) }, 'ส่งตอนนี้'))));

  els.push(h('section', null, h('h2', null, 'กระเป๋า'),
    h('div', { class: 'ledger' }, ws.map((w) => h('div', { class: 'ledger-row' },
      h('span', { class: 'name' }, w.name),
      w.type === 'Savings' ? h('span', { class: 'tag' }, 'เงินเก็บ') : null,
      h('span', { class: 'amt num' + (w.balance < 0 ? ' neg' : '') }, money(w.balance)))))));

  els.push(h('section', null,
    h('h2', null, 'เดือนนี้ (' + monthLabel(sm.month) + ')'),
    h('div', { class: 'month-head' },
      h('span', null, 'จ่าย ', h('span', { class: 'big num neg' }, money(sm.expenseTotal))),
      h('span', null, 'รับ ', h('span', { class: 'big num pos' }, money(sm.incomeTotal)))),
    sm.expenseByCategory.length
      ? h('ul', { class: 'bars' }, sm.expenseByCategory.slice(0, 6).map((c) => h('li', null,
          h('span', null, c.category), h('span', { class: 'num' }, money(c.amount)),
          h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(2, c.amount / maxCat * 100)}%` })))))
      : h('p', { class: 'muted' }, 'ยังไม่มีรายจ่ายเดือนนี้')));

  els.push(h('section', null, h('h2', null, 'ล่าสุด'),
    b.recent.length ? h('ul', { class: 'tx-list' }, b.recent.slice(0, 8).map(txItem)) : h('p', { class: 'muted' }, 'ยังไม่มีรายการ กดปุ่ม จด เพื่อเริ่ม'),
    h('button', { class: 'link', type: 'button', onclick: () => go('list') }, 'ดูทั้งหมด')));
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
  if (t.dateTime && t.source !== 'legacy') meta.push(t.dateTime.slice(11, 16));
  if (t.type === 'Expense' && t.myShare !== t.amount) meta.push(`ส่วนของฉัน ${money(t.myShare)}`);
  return h('li', null, h('button', { class: 'tx', type: 'button', onclick: () => openEntry(t) },
    h('span', { class: 't1' }, title),
    h('span', { class: 'a num ' + cls }, sign + money(t.amount)),
    h('span', { class: 't2' }, meta.filter(Boolean).join(', '))));
}

// ------------------------------------------------------------ list
async function loadList() {
  try {
    S.list = { month: S.month, ...(await api('listTransactions', { month: S.month, limit: 500 })) };
  } catch (e) {
    S.list = { month: S.month, error: e.message, items: [] };
  }
}
function renderList() {
  const head = h('div', { class: 'month-nav' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เดือนก่อน', onclick: () => { S.month = shiftMonth(S.month, -1); S.list = null; render(); loadList().then(render); } }, '‹'),
    h('strong', null, monthLabel(S.month)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เดือนถัดไป', onclick: () => { S.month = shiftMonth(S.month, 1); S.list = null; render(); loadList().then(render); } }, '›'));
  if (!S.list || S.list.month !== S.month) { $('#v-list').replaceChildren(head, h('p', { class: 'muted' }, 'กำลังโหลด…')); return; }
  if (S.list.error) { $('#v-list').replaceChildren(head, h('p', { class: 'err' }, S.list.error)); return; }
  const items = S.list.items;
  if (!items.length) { $('#v-list').replaceChildren(head, h('p', { class: 'muted' }, 'ไม่มีรายการในเดือนนี้')); return; }
  const groups = [];
  for (const t of items) {
    const d = t.dateTime.slice(0, 10);
    if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] });
    groups[groups.length - 1].items.push(t);
  }
  const exp = items.filter((t) => t.type === 'Expense').reduce((s, t) => s + t.myShare, 0);
  $('#v-list').replaceChildren(head,
    h('p', { class: 'muted' }, `${items.length} รายการ  รายจ่ายรวม `, h('b', { class: 'num neg' }, money(exp))),
    ...groups.map((g) => h('section', null,
      h('div', { class: 'day' }, h('span', null, dayLabel(g.d)),
        h('span', { class: 'num' }, 'จ่าย ' + money(g.items.filter((t) => t.type === 'Expense').reduce((s, t) => s + t.myShare, 0)))),
      h('ul', { class: 'tx-list' }, g.items.map(txItem)))));
}

// ------------------------------------------------------------ wallets
function renderWallets() {
  const b = S.boot;
  const busy = (btn, fn, keys) => async () => {
    btn.disabled = true;
    try { await fn(); (keys || []).forEach((k) => { delete S.drafts[k]; }); await refresh(true); }
    catch (e) { toast(e.message); } finally { btn.disabled = false; }
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
    return h('details', { class: 'wallet', open: S.openWallets.has(w.name),
      ontoggle: (e) => { if (e.target.open) S.openWallets.add(w.name); else S.openWallets.delete(w.name); } },
      h('summary', null, h('span', { class: 'name' }, w.name), diff,
        h('span', { class: 'num' + (w.balance < 0 ? ' neg' : '') }, money(w.balance))),
      h('div', { class: 'body stack' },
        h('p', { class: 'hint' }, `ยอดตามระบบ ${money(w.balance)} = ยอดตั้งต้น + รายการตั้งแต่วันเริ่มใช้`),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ยอดตั้งต้น (ณ วันเริ่มใช้)'), opening), openBtn),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ยอดจริงตอนนี้ (ไว้เทียบ)'), counted), cntBtn),
        w.difference && Math.abs(w.difference) >= 0.005
          ? h('p', { class: 'hint' }, w.difference < 0 ? 'เงินจริงน้อยกว่าในระบบ อาจมีรายจ่ายที่ลืมจด' : 'เงินจริงมากกว่าในระบบ อาจมีรายรับที่ลืมจด หรือจดรายจ่ายเกิน')
          : null,
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'ชื่อกระเป๋า'), newName), renBtn)));
  });

  const addName = dIn('add:name', { class: 'input', type: 'text', maxlength: '30', placeholder: 'เช่น SCB' }, '');
  const addType = h('select', { class: 'input' }, ['Bank', 'E-wallet', 'Cash', 'Savings', 'Other'].map((t) => h('option', { value: t }, t)));
  const addBtn = h('button', { class: 'btn', type: 'button' }, 'เพิ่มกระเป๋า');
  addBtn.onclick = busy(addBtn, async () => {
    if (!addName.value.trim()) throw new Error('ใส่ชื่อกระเป๋าก่อน');
    await api('addWallet', { name: addName.value.trim(), type: addType.value, opening: 0 }); toast('เพิ่มกระเป๋าแล้ว');
  }, ['add:name']);

  const els = [
    h('section', null, h('h2', null, 'วันเริ่มใช้แอพ'),
      h('p', { class: 'hint' }, 'ยอดคงเหลือนับเฉพาะรายการตั้งแต่วันนี้ ใส่ยอดตั้งต้นของทุกกระเป๋าเป็นยอดจริงตอนเช้าของวันนั้น'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, startInput), startBtn)),
    h('section', null, h('h2', null, 'กระเป๋าของฉัน'), cards),
    h('section', null, h('h2', null, 'เพิ่มกระเป๋า'),
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

function openEntry(tx) {
  if (!S.boot) return;
  if (tx) {
    S.form = {
      editId: tx.id, legacy: tx.source === 'legacy', type: tx.type, amount: String(tx.amount), category: tx.category,
      subCategory: tx.subCategory || '', wallet: tx.wallet || '', toWallet: tx.toWallet || '', note: tx.note || '',
      dateTime: tx.dateTime ? tx.dateTime.replace(' ', 'T') : nowLocal(), split: tx.type === 'Expense' && tx.myShare !== tx.amount,
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
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSheet();
}
function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; }

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

async function submitEntry() {
  const f = S.form;
  const problem = validate(f);
  if (problem) { const e = $('#entry-err'); e.textContent = problem; e.hidden = false; return; }
  if (f.wallet && f.type !== 'Transfer' && f.category) { const m = LS.get('ttm_catWallet', {}); m[f.category.trim()] = f.wallet; LS.set('ttm_catWallet', m); }

  if (f.editId) {
    const btn = $('#entry-save'); btn.disabled = true; btn.textContent = 'กำลังบันทึก';
    try {
      await api('updateTransaction', { id: f.editId, fields: baseItem(f) });
      closeSheet(); toast('แก้ไขแล้ว'); refresh(true);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'บันทึก';
      const el = $('#entry-err'); el.textContent = e.message; el.hidden = false;
    }
    return;
  }

  const items = [];
  if (f.type === 'Expense' && f.topup) {
    items.push({ type: 'Transfer', category: 'โอนย้าย', subCategory: 'เติมอัตโนมัติ', amount: Number(f.topupAmount),
      wallet: f.topupFrom, toWallet: f.wallet, note: 'เติมเงินเพื่อจ่าย ' + (f.note.trim() || f.category), dateTime: f.dateTime });
  }
  items.push(baseItem(f));
  const batch = { clientId: uid(), items };
  const saved = { ...f };
  closeSheet();                 // ปิดทันที จะได้จดรายการต่อไปเร็ว ๆ
  S.sending++; updateSync();
  try {
    await api('addTransactions', batch);
    toast(`บันทึกแล้ว ${f.type === 'Income' ? '+' : f.type === 'Expense' ? '−' : ''}${money(f.amount)} ${f.note.trim() || f.category || ''}`);
  } catch (e) {
    if (e.offline) {
      S.queue.push(batch); LS.set('ttm_queue', S.queue);
      toast('ยังไม่มีเน็ต เก็บรายการไว้ในเครื่องก่อน จะส่งให้เองเมื่อออนไลน์');
    } else {
      S.form = saved; $('#sheet').hidden = false; renderSheet();
      const el = $('#entry-err'); el.textContent = 'บันทึกไม่สำเร็จ: ' + e.message; el.hidden = false;
    }
  } finally {
    S.sending--; updateSync();
  }
  refresh(true);
}

async function deleteEntry() {
  const id = S.form.editId;
  closeSheet();
  try {
    await api('deleteTransaction', { id });
    toast('ลบรายการแล้ว', { label: 'เลิกทำ', fn: async () => {
      try { await api('restoreTransaction', { id }); toast('กู้คืนแล้ว'); refresh(true); } catch (e) { toast(e.message); }
    } });
    refresh(true);
  } catch (e) { toast(e.message); }
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
  updateAmount();
}
function updateAmount() {
  const d = $('#amount-display');
  if (!d) return;
  const a = S.form.amount;
  d.classList.toggle('empty', !a);
  let shown = '0';
  if (a) {
    const [i, dec] = a.split('.');
    shown = Number(i || 0).toLocaleString('th-TH') + (a.includes('.') ? '.' + (dec || '') : '');
  }
  d.replaceChildren(h('small', null, '฿'), shown);
  $('#entry-err').hidden = true;
}

function renderSheet() {
  const f = S.form;
  const set = (patch, rerender = true) => { Object.assign(f, patch); if (rerender) { const y = $('.sheet-scroll') ? $('.sheet-scroll').scrollTop : 0; renderSheet(); $('.sheet-scroll').scrollTop = y; } };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'ชนิดรายการ' },
    ['Expense', 'Income', 'Transfer'].map((t) => h('button', {
      type: 'button', 'aria-pressed': String(f.type === t), disabled: f.editId && f.legacy ? true : null,
      onclick: () => set({ type: t, category: '', subCategory: '', customCat: false, split: false, topup: false })
    }, TYPE_LABEL[t])));

  const chips = (values, selected, onPick, extra) => h('div', { class: 'chips' },
    values.map((v) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(v === selected), onclick: () => onPick(v) }, v)), extra || null);

  const walletChips = (selected, onPick, exclude) => h('div', { class: 'chips scroll' },
    walletNames().filter((n) => n !== exclude).map((n) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === selected), onclick: () => onPick(n) }, n)));

  const body = [];
  // ปุ่มจดเร็ว
  const presets = (S.boot.presets || []).filter((p) => p.type === f.type);
  if (!f.editId && presets.length) {
    body.push(h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'จดเร็ว' }, presets.map((p) => h('button', {
      type: 'button', class: 'stamp', onclick: () => set({
        category: p.category, subCategory: p.subCategory || '', note: p.label, customCat: false,
        amount: p.amount ? String(p.amount) : f.amount,
        wallet: p.wallet && walletNames().includes(p.wallet) ? p.wallet : (f.walletTouched ? f.wallet : walletForCategory(p.category, f.wallet))
      })
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
    h('button', { type: 'button', class: 'save', id: 'entry-save', onclick: submitEntry }, f.editId ? 'บันทึก' : 'บันทึก'));

  $('#sheet').replaceChildren(
    h('div', { class: 'sheet-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'ปิด', onclick: closeSheet },
        h('svg', null)), seg),
    h('div', { id: 'amount-display', class: 'amount-display num', 'aria-live': 'polite' }),
    h('div', { class: 'sheet-scroll' }, body),
    keypad);
  // ไอคอนปิด (สร้าง svg ด้วย namespace)
  const btnClose = $('.sheet-head .icon-btn');
  btnClose.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>';
  updateAmount();
}

// ------------------------------------------------------------ boot
document.addEventListener('keydown', (e) => {
  if ($('#sheet').hidden) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (/^[0-9]$/.test(e.key)) keyPress(e.key);
  else if (e.key === '.') keyPress('.');
  else if (e.key === 'Backspace') keyPress('del');
  else if (e.key === 'Enter') submitEntry();
  else if (e.key === 'Escape') closeSheet();
});
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
$('#btn-add').addEventListener('click', () => openEntry(null));
$('#btn-refresh').addEventListener('click', () => { flushQueue().then(() => refresh(false)); });
window.addEventListener('online', () => { updateSync(); flushQueue().then(() => refresh(true)); });
window.addEventListener('offline', updateSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.cfg && Date.now() - S.lastRefresh > 60000) flushQueue().then(() => refresh(true));
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.view === 'wallets') render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

render();
updateSync();
if (S.cfg) flushQueue().then(() => refresh(true));
