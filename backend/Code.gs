/**
 * TT Money API  (Google Apps Script, ผูกกับ Google Sheet "expense_tracker_template")
 * - รับคำสั่งแบบ POST (JSON เป็น text/plain) พร้อม token
 * - อ่าน/เขียนแท็บ Transactions, Wallets, Categories, Presets
 * วิธีใช้: ดู backend/README.md (รัน setup() ครั้งเดียว แล้ว Deploy เป็น Web app)
 * ไฟล์นี้ไม่มีความลับ: TOKEN และ SHEET_ID เก็บใน Script Properties ไม่ได้อยู่ในโค้ด
 */

const SHEETS = { TX: 'Transactions', WL: 'Wallets', CAT: 'Categories', PS: 'Presets' };
const TYPES = ['Income', 'Expense', 'Transfer'];
const WALLET_TYPES = ['Cash', 'Bank', 'E-wallet', 'Savings', 'Other'];
const WL_FIRST = 5;   // แถวแรกของกระเป๋าในแท็บ Wallets
const WL_COUNT = 10;  // จำนวนช่อง (แถว 5-14)
const TX_NCOLS = 13;  // ID, DateTime, Type, Category, SubCategory, Amount, MyShare, Wallet, ToWallet, Note, RentForMonth, Source, Deleted
const WRITE_ACTIONS = ['addTransactions', 'updateTransaction', 'deleteTransaction', 'restoreTransaction',
  'addWallet', 'renameWallet', 'setWalletOpening', 'setCounted', 'setStartDate'];

// ------------------------------------------------------------------ setup
/** รันครั้งเดียว: สร้าง token + จำ Sheet + ตั้งรูปแบบคอลัมน์ข้อความ แล้วดู token ใน Execution log */
function setup() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', SpreadsheetApp.getActive().getId());
  let created = false;
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', newToken_());
    created = true;
  }
  // บังคับคอลัมน์ข้อความเป็น plain text กัน Sheets แปลง "2026-09" / "7-11" เป็นวันที่
  const tx = ss_().getSheetByName(SHEETS.TX);
  [1, 4, 5, 8, 9, 10, 11, 12, 13].forEach(function (c) {
    tx.getRange(2, c, tx.getMaxRows() - 1, 1).setNumberFormat('@');
  });
  Logger.log('ตั้งค่าเสร็จ. เขตเวลาของสคริปต์ = ' + Session.getScriptTimeZone() + ' (ควรเป็น Asia/Bangkok)');
  Logger.log(created ? 'TOKEN ของคุณ (คัดลอกเก็บไว้): ' + props.getProperty('TOKEN')
                     : 'มี TOKEN อยู่แล้ว (ไม่สร้างใหม่). ถ้าลืม ให้รัน showToken() หรือ resetToken()');
}

function showToken() { Logger.log('TOKEN: ' + PropertiesService.getScriptProperties().getProperty('TOKEN')); }

/** สร้าง token ใหม่ (token เก่าใช้ไม่ได้ทันที ต้องกรอกใหม่ในแอพ) */
function resetToken() {
  const t = newToken_();
  PropertiesService.getScriptProperties().setProperty('TOKEN', t);
  Logger.log('TOKEN ใหม่: ' + t);
}

/** ทดสอบว่าอ่านชีตได้ถูกต้อง */
function selfTest() {
  const w = readWallets_();
  Logger.log('timezone: ' + Session.getScriptTimeZone());
  Logger.log('กระเป๋า: ' + w.map(function (x) { return x.name; }).join(', '));
  Logger.log('จำนวนรายการ: ' + readTx_().length);
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
}

// ------------------------------------------------------------------ web entry
function doGet() {
  return out_({ ok: true, name: 'TT Money API', note: 'ใช้ POST พร้อม token' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'bad json' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || String(req.token) !== token) return out_({ ok: false, error: 'unauthorized' });
  const fn = ACTIONS[req.action];
  if (!fn) return out_({ ok: false, error: 'unknown action' });
  let lock = null;
  try {
    if (WRITE_ACTIONS.indexOf(req.action) >= 0) {
      lock = LockService.getScriptLock();
      lock.waitLock(15000);
    }
    return out_({ ok: true, data: fn(req.args || {}) });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

const ACTIONS = {
  ping: function () { return { time: fmt_(new Date()) }; },
  bootstrap: bootstrap_,
  listTransactions: listTransactions_,
  summary: summary_,
  addTransactions: addTransactions_,
  updateTransaction: updateTransaction_,
  deleteTransaction: function (a) { return setDeleted_(a.id, 'Y'); },
  restoreTransaction: function (a) { return setDeleted_(a.id, 'N'); },
  addWallet: addWallet_,
  renameWallet: renameWallet_,
  setWalletOpening: setWalletOpening_,
  setCounted: setCounted_,
  setStartDate: setStartDate_
};

// ------------------------------------------------------------------ helpers
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('ยังไม่ได้รัน setup()');
  return SpreadsheetApp.openById(id);
}
function sh_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('ไม่พบแท็บ ' + name);
  return s;
}
function tz_() { return Session.getScriptTimeZone(); }
function fmt_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm'); }
function month_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM'); }
function round2_(n) { return Math.round(n * 100) / 100; }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function safeText_(v) {
  const s = str_(v);
  return /^[=+\-@]/.test(s) ? ' ' + s : s;   // กัน note ที่ขึ้นต้นด้วย = ถูกตีเป็นสูตร
}

function parseDateTime_(v) {
  if (v === undefined || v === null || v === '') return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v));
  if (!m) throw new Error('รูปแบบวันที่ต้องเป็น yyyy-MM-dd หรือ yyyy-MM-ddTHH:mm');
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}

function readWallets_() {
  const rows = sh_(SHEETS.WL).getRange(WL_FIRST, 1, WL_COUNT, 7).getValues();
  const out = [];
  rows.forEach(function (r, i) {
    if (!str_(r[0])) return;
    out.push({
      row: WL_FIRST + i, name: str_(r[0]), type: str_(r[1]),
      opening: Number(r[2]) || 0,
      balance: r[3] === '' ? 0 : Number(r[3]) || 0,
      counted: r[4] === '' ? null : Number(r[4]),
      difference: r[5] === '' ? null : Number(r[5]),
      note: str_(r[6])
    });
  });
  return out;
}

function readTx_() {
  const sh = sh_(SHEETS.TX);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, TX_NCOLS).getValues().map(function (r, i) {
    return {
      row: i + 2, id: str_(r[0]), dt: r[1] instanceof Date ? r[1] : null, type: str_(r[2]),
      category: str_(r[3]), subCategory: str_(r[4]), amount: Number(r[5]) || 0,
      myShare: r[6] === '' ? Number(r[5]) || 0 : Number(r[6]) || 0,
      wallet: str_(r[7]), toWallet: str_(r[8]), note: str_(r[9]), rentForMonth: str_(r[10]),
      source: str_(r[11]), deleted: str_(r[12]) === 'Y'
    };
  });
}

function pub_(t) {
  return {
    id: t.id, dateTime: t.dt ? fmt_(t.dt) : '', type: t.type, category: t.category,
    subCategory: t.subCategory, amount: t.amount, myShare: t.myShare, wallet: t.wallet,
    toWallet: t.toWallet, note: t.note, rentForMonth: t.rentForMonth, source: t.source, deleted: t.deleted
  };
}

function toRow_(n, id, source, deleted) {
  return [id, n.dt, n.type, n.category, n.subCategory, n.amount, n.myShare, n.wallet, n.toWallet,
    n.note, n.rentForMonth, source, deleted];
}

/** ตรวจและจัดรูปรายการ (throw ถ้าไม่ถูกต้อง) */
function normalize_(t, walletNames, allowNoWallet) {
  const type = str_(t.type);
  if (TYPES.indexOf(type) < 0) throw new Error('type ต้องเป็น Income, Expense หรือ Transfer');
  const amount = round2_(Number(t.amount));
  if (!isFinite(amount) || amount <= 0) throw new Error('จำนวนเงินต้องมากกว่า 0');
  let myShare = (t.myShare === undefined || t.myShare === null || t.myShare === '') ? amount : round2_(Number(t.myShare));
  if (type !== 'Expense') myShare = amount;
  if (!isFinite(myShare) || myShare < 0 || myShare > amount) throw new Error('MyShare ต้องอยู่ระหว่าง 0 ถึงจำนวนเงิน');
  const wallet = str_(t.wallet);
  if (!(allowNoWallet && wallet === '') && walletNames.indexOf(wallet) < 0) throw new Error('ไม่พบกระเป๋า: ' + wallet);
  let toWallet = '';
  if (type === 'Transfer') {
    toWallet = str_(t.toWallet);
    if (!(allowNoWallet && toWallet === '') && walletNames.indexOf(toWallet) < 0) throw new Error('ไม่พบกระเป๋าปลายทาง: ' + toWallet);
    if (toWallet !== '' && toWallet === wallet) throw new Error('กระเป๋าต้นทางกับปลายทางต้องต่างกัน');
  }
  let category = str_(t.category);
  if (type === 'Transfer' && !category) category = 'โอนย้าย';
  if (!category) throw new Error('ต้องระบุหมวด');
  const rentForMonth = str_(t.rentForMonth);
  if (rentForMonth && !/^\d{4}-\d{2}$/.test(rentForMonth)) throw new Error('rentForMonth ต้องเป็น yyyy-MM');
  return {
    dt: parseDateTime_(t.dateTime), type: type, category: safeText_(category), subCategory: safeText_(t.subCategory),
    amount: amount, myShare: myShare, wallet: wallet, toWallet: toWallet, note: safeText_(t.note),
    rentForMonth: rentForMonth
  };
}

function walletNames_() { return readWallets_().map(function (w) { return w.name; }); }

// ------------------------------------------------------------------ actions
function bootstrap_() {
  const txs = readTx_();
  const live = txs.filter(function (t) { return !t.deleted; });
  const catSh = sh_(SHEETS.CAT);
  const cl = catSh.getLastRow();
  const categories = cl < 2 ? [] : catSh.getRange(2, 1, cl - 1, 2).getValues()
    .filter(function (r) { return r[0] && r[1]; })
    .map(function (r) { return { type: str_(r[0]), category: str_(r[1]) }; });
  const subSet = {};
  live.forEach(function (t) {
    if (t.subCategory) subSet[t.type + '|' + t.category + '|' + t.subCategory] = { type: t.type, category: t.category, subCategory: t.subCategory };
  });
  const psSh = sh_(SHEETS.PS);
  const pl = psSh.getLastRow();
  const presets = pl < 2 ? [] : psSh.getRange(2, 1, pl - 1, 6).getValues()
    .filter(function (r) { return r[0] && r[1]; })
    .map(function (r) {
      return { label: str_(r[0]), type: str_(r[1]), category: str_(r[2]), subCategory: str_(r[3]),
        amount: r[4] === '' ? null : Number(r[4]), wallet: str_(r[5]) };
    });
  const startRaw = sh_(SHEETS.WL).getRange('B2').getValue();
  return {
    timezone: tz_(),
    now: fmt_(new Date()),
    startDate: startRaw instanceof Date ? Utilities.formatDate(startRaw, tz_(), 'yyyy-MM-dd') : '',
    wallets: readWallets_(),
    categories: categories,
    subCategories: Object.keys(subSet).map(function (k) { return subSet[k]; }),
    presets: presets,
    recent: sortDesc_(live).slice(0, 30).map(pub_),
    summary: summary_({})
  };
}

function sortDesc_(arr) {
  return arr.slice().sort(function (a, b) {
    return (b.dt ? b.dt.getTime() : 0) - (a.dt ? a.dt.getTime() : 0) || b.row - a.row;
  });
}

function listTransactions_(a) {
  let list = readTx_();
  if (!a.includeDeleted) list = list.filter(function (t) { return !t.deleted; });
  if (a.month) list = list.filter(function (t) { return t.dt && month_(t.dt) === a.month; });
  if (a.wallet) list = list.filter(function (t) { return t.wallet === a.wallet || t.toWallet === a.wallet; });
  const limit = Math.min(Number(a.limit) || 100, 500);
  const offset = Number(a.offset) || 0;
  const sorted = sortDesc_(list);
  return { total: sorted.length, items: sorted.slice(offset, offset + limit).map(pub_) };
}

function summary_(a) {
  const m = a && a.month ? a.month : month_(new Date());
  const exp = {}, inc = {};
  let expTotal = 0, incTotal = 0;
  readTx_().forEach(function (t) {
    if (t.deleted || !t.dt || month_(t.dt) !== m) return;
    if (t.type === 'Expense') { exp[t.category] = round2_((exp[t.category] || 0) + t.myShare); expTotal += t.myShare; }
    if (t.type === 'Income') { inc[t.category] = round2_((inc[t.category] || 0) + t.amount); incTotal += t.amount; }
  });
  const toList = function (o) {
    return Object.keys(o).map(function (k) { return { category: k, amount: o[k] }; })
      .sort(function (x, y) { return y.amount - x.amount; });
  };
  return { month: m, expenseTotal: round2_(expTotal), incomeTotal: round2_(incTotal),
    expenseByCategory: toList(exp), incomeByCategory: toList(inc) };
}

/** เพิ่มหลายรายการในครั้งเดียว (ใช้กับ "จ่ายจากหลายกระเป๋า": Transfer + Expense) */
function addTransactions_(a) {
  const items = a.items;
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error('items ต้องมี 1-20 รายการ');
  // กันรายการซ้ำ: ถ้าแอพส่งชุดเดิมซ้ำ (เน็ตหลุดตอนรอคำตอบ) จะไม่บันทึกซ้ำภายใน 6 ชั่วโมง
  const cache = CacheService.getScriptCache();
  const cid = a.clientId ? 'cid_' + String(a.clientId).slice(0, 80) : null;
  if (cid && cache.get(cid)) return { added: [], duplicate: true };
  const names = walletNames_();
  const normalized = items.map(function (t) { return normalize_(t, names); });   // ตรวจครบก่อนค่อยเขียน
  normalized.forEach(function (n) { ensureCategory_(n.type, n.category); });
  const sh = sh_(SHEETS.TX);
  const stamp = Utilities.formatDate(new Date(), tz_(), 'yyyyMMddHHmmss');
  const base = Utilities.getUuid().slice(0, 6);
  const rows = normalized.map(function (n, i) { return toRow_(n, 'A' + stamp + '-' + base + i, 'app', 'N'); });
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, TX_NCOLS).setValues(rows);
  if (cid) cache.put(cid, '1', 21600);
  return { added: rows.map(function (r) { return r[0]; }) };
}

/** ถ้าใช้หมวดใหม่ที่ยังไม่มีในแท็บ Categories ให้เพิ่มต่อท้ายอัตโนมัติ */
function ensureCategory_(type, category) {
  const sh = sh_(SHEETS.CAT);
  const last = sh.getLastRow();
  const vals = last < 2 ? [] : sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < vals.length; i++) if (str_(vals[i][0]) === type && str_(vals[i][1]) === category) return;
  const r = last + 1;
  sh.getRange(r, 1, 1, 3).setValues([[type, category,
    '=COUNTIFS(Transactions!$C$2:$C$20000,A' + r + ',Transactions!$D$2:$D$20000,B' + r + ')']]);
}

function findRow_(id) {
  const sh = sh_(SHEETS.TX);
  const last = sh.getLastRow();
  if (last < 2 || !id) throw new Error('ไม่พบรายการ');
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (str_(ids[i][0]) === str_(id)) return i + 2;
  throw new Error('ไม่พบรายการ ' + id);
}

function updateTransaction_(a) {
  const row = findRow_(a.id);
  const sh = sh_(SHEETS.TX);
  const cur = sh.getRange(row, 1, 1, TX_NCOLS).getValues()[0];
  const old = {
    dateTime: cur[1] instanceof Date ? Utilities.formatDate(cur[1], tz_(), "yyyy-MM-dd'T'HH:mm") : '',
    type: cur[2], category: cur[3], subCategory: cur[4], amount: cur[5], myShare: cur[6],
    wallet: cur[7], toWallet: cur[8], note: cur[9], rentForMonth: cur[10]
  };
  const f = a.fields || {};
  const merged = {};
  Object.keys(old).forEach(function (k) { merged[k] = f.hasOwnProperty(k) ? f[k] : old[k]; });
  // ถ้าแก้ amount แต่ไม่ได้แก้ myShare ให้ myShare ตามจำนวนเงินใหม่ (กรณีเดิมไม่ได้หาร)
  if (f.hasOwnProperty('amount') && !f.hasOwnProperty('myShare') && Number(old.myShare) === Number(old.amount)) merged.myShare = '';
  // รายการประวัติเดิม (legacy) ไม่มีกระเป๋า จึงยอมให้ว่างได้เพื่อแก้หมวด/โน้ตได้
  const n = normalize_(merged, walletNames_(), str_(cur[11]) === 'legacy');
  sh.getRange(row, 1, 1, TX_NCOLS).setValues([toRow_(n, str_(cur[0]), str_(cur[11]), str_(cur[12]) || 'N')]);
  return { updated: a.id };
}

function setDeleted_(id, flag) {
  const row = findRow_(id);
  sh_(SHEETS.TX).getRange(row, 13).setValue(flag);
  return { id: id, deleted: flag === 'Y' };
}

function cleanName_(v) {
  const s = str_(v);
  if (!s) throw new Error('ต้องระบุชื่อกระเป๋า');
  if (s.length > 30) throw new Error('ชื่อกระเป๋ายาวเกิน 30 ตัวอักษร');
  if (/^[=+\-@]/.test(s)) throw new Error('ชื่อกระเป๋าห้ามขึ้นต้นด้วย = + - @');
  return s;
}

function addWallet_(a) {
  const name = cleanName_(a.name);
  const type = WALLET_TYPES.indexOf(a.type) >= 0 ? a.type : 'Other';
  const sh = sh_(SHEETS.WL);
  const rows = sh.getRange(WL_FIRST, 1, WL_COUNT, 1).getValues();
  let free = -1;
  for (let i = 0; i < rows.length; i++) {
    if (str_(rows[i][0]).toLowerCase() === name.toLowerCase()) throw new Error('มีกระเป๋าชื่อนี้แล้ว');
    if (!str_(rows[i][0]) && free < 0) free = i;
  }
  if (free < 0) throw new Error('ช่องกระเป๋าเต็ม (สูงสุด ' + WL_COUNT + ')');
  const r = WL_FIRST + free;
  sh.getRange(r, 1).setValue(name);
  sh.getRange(r, 2).setValue(type);
  sh.getRange(r, 3).setValue(Number(a.opening) || 0);
  return { added: name };
}

function walletRow_(name) {
  const w = readWallets_().filter(function (x) { return x.name === str_(name); })[0];
  if (!w) throw new Error('ไม่พบกระเป๋า: ' + name);
  return w.row;
}

function setWalletOpening_(a) {
  const v = Number(a.opening);
  if (!isFinite(v)) throw new Error('ยอดตั้งต้นต้องเป็นตัวเลข');
  sh_(SHEETS.WL).getRange(walletRow_(a.name), 3).setValue(round2_(v));
  return { name: a.name, opening: round2_(v) };
}

function setCounted_(a) {
  const cell = sh_(SHEETS.WL).getRange(walletRow_(a.name), 5);
  if (a.counted === null || a.counted === '' || a.counted === undefined) { cell.clearContent(); return { name: a.name, counted: null }; }
  const v = Number(a.counted);
  if (!isFinite(v)) throw new Error('ยอดจริงต้องเป็นตัวเลข');
  cell.setValue(round2_(v));
  return { name: a.name, counted: round2_(v) };
}

function renameWallet_(a) {
  const from = str_(a.from), to = cleanName_(a.to);
  const names = walletNames_();
  if (names.indexOf(from) < 0) throw new Error('ไม่พบกระเป๋า: ' + from);
  if (from !== to && names.some(function (n) { return n.toLowerCase() === to.toLowerCase(); })) throw new Error('มีกระเป๋าชื่อนี้แล้ว');
  const row = walletRow_(from);
  const tx = sh_(SHEETS.TX);
  const last = tx.getLastRow();
  let changed = 0;
  if (last >= 2) {
    const rng = tx.getRange(2, 8, last - 1, 2);       // คอลัมน์ H (Wallet) และ I (ToWallet)
    const vals = rng.getValues();
    vals.forEach(function (r) {
      for (let c = 0; c < 2; c++) if (str_(r[c]) === from) { r[c] = to; changed++; }
    });
    rng.setValues(vals);
  }
  sh_(SHEETS.WL).getRange(row, 1).setValue(to);
  return { from: from, to: to, transactionsUpdated: changed };
}

function setStartDate_(a) {
  const d = parseDateTime_(a.date);
  sh_(SHEETS.WL).getRange('B2').setValue(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
  return { startDate: Utilities.formatDate(d, tz_(), 'yyyy-MM-dd') };
}
