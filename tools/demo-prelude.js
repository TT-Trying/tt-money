// backend จำลองสำหรับ tools/build-demo.py: แทน fetch ไป script.google.com ด้วยข้อมูลปลอมในหน่วยความจำ (ตอบช้า ~1 วิเหมือนของจริง)
// รองรับทุก action ใน backend/Code.gs ถ้าเพิ่ม action ใหม่ใน backend ให้เพิ่มที่นี่ด้วย
// ---------- DEMO: Google Sheet ปลอม (ตอบช้า ~1 วิ เหมือน Apps Script จริง) ----------
try { Object.keys(localStorage).filter((k) => k.startsWith('ttm_')).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
window.DEMO = { offline: false, latency: 1000 };
(function () {
  const p = (n) => String(n).padStart(2, '0');
  const ago = (days, hm) => {
    const d = new Date(); d.setDate(d.getDate() - days);
    if (days === 0) {   // รายการของวันนี้ห้ามเป็นเวลาในอนาคต (ไม่งั้นจะเรียงอยู่บนรายการที่เพิ่งจด)
      const n = new Date(Date.now() - 20 * 60000), now = `${p(n.getHours())}:${p(n.getMinutes())}`;
      if (hm > now) hm = now;
    }
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  };
  const now = new Date();
  const month = `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
  const db = {
    startDate: `${month}-01`, n: 100,
    wallets: [
      { name: 'เงินสด', type: 'Cash', opening: 1500, counted: null },
      { name: 'KBank', type: 'Bank', opening: 18200, counted: null },
      { name: 'TrueMoney', type: 'E-wallet', opening: 350, counted: null },
      { name: 'เงินเก็บ', type: 'Savings', opening: 42000, counted: null }
    ],
    tx: [
      ['Expense', 65, 'อาหาร', 'เงินสด', 'ข้าวมันไก่', 0, '12:15'],
      ['Expense', 55, 'กาแฟ', 'เงินสด', 'อเมริกาโน่', 0, '08:40'],
      ['Expense', 120, 'เดินทาง', 'KBank', 'Grab ไปมอ', 1, '18:30'],
      ['Expense', 89, 'อาหาร', 'TrueMoney', 'ชาบู (หาร)', 1, '19:50'],
      ['Expense', 159, 'Subscriptions', 'TrueMoney', 'Spotify', 2, '10:00'],
      ['Income', 8000, 'เงินเดือน', 'KBank', 'เงินจากที่บ้าน', 3, '09:00'],
      ['Expense', 45, 'อาหาร', 'เงินสด', 'ก๋วยเตี๋ยว', 3, '12:30'],
    ].filter((r) => r[5] < now.getDate()).concat([
      ['Expense', 135, 'เดินทาง', 'KBank', 'Grab กลับหอ', now.getDate() + 3, '22:10'],
      ['Expense', 55, 'กาแฟ', 'เงินสด', 'อเมริกาโน่', now.getDate() + 5, '08:30'],
      ['Expense', 1290, 'หูฟัง', 'KBank', 'หูฟัง TWS', now.getDate() + 12, '20:00'],
      ['Expense', 98, 'เดินทาง', 'KBank', 'Grab ไปสยาม', now.getDate() + 20, '13:45'],
      ['Expense', 159, 'Subscriptions', 'TrueMoney', 'Spotify', now.getDate() + 30, '10:00'],
      ['Expense', 60, 'กาแฟ', 'เงินสด', 'ลาเต้', now.getDate() + 40, '09:10'],
      ['Expense', 210, 'เดินทาง', 'KBank', 'Grab ไปสนามบิน', now.getDate() + 75, '05:40'],
      ['Income', 8000, 'เงินเดือน', 'KBank', 'เงินจากที่บ้าน', now.getDate() + 28, '09:00'],
    ]).map((r, i) => ({ id: 'd' + i, type: r[0], amount: r[1], myShare: r[1], category: r[2], subCategory: '', wallet: r[3], toWallet: '', note: r[4], dateTime: ago(r[5], r[6]), source: 'app' }))
  };
  const sortDesc = (a) => [...a].sort((x, y) => y.dateTime.localeCompare(x.dateTime));
  function boot() {
    const ws = db.wallets.map((w) => {
      let b = w.opening;
      for (const t of db.tx) {
        if (t.dateTime.slice(0, 10) < db.startDate) continue;
        if (t.type === 'Expense' && t.wallet === w.name) b -= t.amount;
        if (t.type === 'Income' && t.wallet === w.name) b += t.amount;
        if (t.type === 'Transfer') { if (t.wallet === w.name) b -= t.amount; if (t.toWallet === w.name) b += t.amount; }
      }
      return { ...w, balance: Math.round(b * 100) / 100, difference: w.counted === null ? null : Math.round((w.counted - b) * 100) / 100 };
    });
    const by = {}; let e = 0, inc = 0;
    for (const t of db.tx) if (t.dateTime.startsWith(month)) {
      if (t.type === 'Expense') { e += t.myShare; by[t.category] = (by[t.category] || 0) + t.myShare; }
      if (t.type === 'Income') inc += t.amount;
    }
    return {
      startDate: db.startDate, wallets: ws,
      summary: { month, expenseTotal: e, incomeTotal: inc, expenseByCategory: Object.entries(by).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount) },
      recent: sortDesc(db.tx).slice(0, 8),
      categories: ['อาหาร', 'กาแฟ', 'เดินทาง', 'Subscriptions', 'ของใช้', 'เกม', 'ชานม', 'ค่าห้องรายเดือน', 'หูฟัง', 'ค่าเทอม', 'ค่าโทรศัพท์', 'ชาบู', 'ยา', 'ของขวัญ', 'แมว', 'ปาร์ตี้', 'อื่น ๆ'].map((c) => ({ type: 'Expense', category: c }))
        .concat([{ type: 'Income', category: 'เงินเดือน' }, { type: 'Income', category: 'รายได้เสริม' }]),
      subCategories: [],
      presets: [
        { type: 'Expense', label: 'กาแฟ', category: 'กาแฟ', amount: 55 },
        { type: 'Expense', label: 'ข้าวเที่ยง', category: 'อาหาร', amount: 60 },
        { type: 'Expense', label: 'วิน', category: 'เดินทาง', amount: 20 }
      ]
    };
  }
  function handle(action, a) {
    switch (action) {
      case 'bootstrap': return boot();
      case 'listTransactions':
        if (Array.isArray(a.months) && !window.DEMO.oldBackend) { const o = {}; a.months.forEach((m) => { const it = sortDesc(db.tx.filter((t) => t.dateTime.startsWith(m))); o[m] = { total: it.length, items: it }; }); return { months: o }; }
        return { items: sortDesc(db.tx.filter((t) => t.dateTime.startsWith(a.month || ''))) };
      case 'addTransactions': a.items.forEach((it) => db.tx.push({ ...it, id: 'd' + (db.n++), source: 'app', dateTime: it.dateTime.replace('T', ' ') })); return {};
      case 'updateTransaction': { const t = db.tx.find((x) => x.id === a.id); if (t) Object.assign(t, a.fields, { dateTime: a.fields.dateTime.replace('T', ' ') }); return {}; }
      case 'deleteTransaction': { const i = db.tx.findIndex((x) => x.id === a.id); if (i >= 0) { db.deleted = db.deleted || {}; db.deleted[a.id] = db.tx[i]; db.tx.splice(i, 1); } return {}; }
      case 'restoreTransaction': { if (db.deleted && db.deleted[a.id]) db.tx.push(db.deleted[a.id]); return {}; }
      case 'setStartDate': db.startDate = a.date; return {};
      case 'setWalletOpening': { const w = db.wallets.find((x) => x.name === a.name); if (w) w.opening = a.opening; return {}; }
      case 'setCounted': { const w = db.wallets.find((x) => x.name === a.name); if (w) w.counted = a.counted; return {}; }
      case 'addWallet': db.wallets.push({ name: a.name, type: a.type, opening: a.opening || 0, counted: null }); return {};
      case 'renameWallet': {
        let c = 0; const w = db.wallets.find((x) => x.name === a.from); if (w) w.name = a.to;
        db.tx.forEach((t) => { if (t.wallet === a.from) { t.wallet = a.to; c++; } if (t.toWallet === a.from) { t.toWallet = a.to; c++; } });
        return { transactionsUpdated: c };
      }
    }
    return {};
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://script.google.com/')) return realFetch(url, opts);
    await new Promise((r) => setTimeout(r, window.DEMO.latency * (0.8 + Math.random() * 0.5)));
    if (window.DEMO.offline) throw new TypeError('Failed to fetch');
    const body = JSON.parse(opts.body);
    (window.DEMO.calls = window.DEMO.calls || []).push(body.action + (body.args && body.args.months ? ':months' : ''));
    const data = handle(body.action, body.args);
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
