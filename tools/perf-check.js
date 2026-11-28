// วัดความลื่น: (1) Chrome trace หา animation ที่ไม่ได้วิ่งบน compositor (GPU) (2) นับเฟรมที่เกินงบ
// ใช้: python3 tools/build-demo.py && node tools/perf-check.js "$PWD/demo.html" 4
//   ตัวเลขท้าย = หน่วง CPU กี่เท่า (4 ≈ มือถือ Android ระดับกลาง)  ต้องมี Playwright
// อ่านผล: janky>25ms ควรเป็น 0-1 ต่อฉาก, รายการ "ไม่ได้วิ่งบน compositor" ควรว่างหรือมีแค่ของเล็ก ๆ
const { chromium } = require('playwright');
const [file, thr] = [process.argv[2], Number(process.argv[3] || 1)];
const SCEN = [
  ['เปิดแอพ (หน้าแรกเข้า)', async (p) => { await p.reload(); await p.waitForTimeout(2600); }],
  ['สลับแท็บ รายการ', async (p) => { await p.click('[data-view="list"]'); await p.waitForTimeout(1400); }],
  ['เลื่อนหน้ารายการ', async (p) => { for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(40); } await p.waitForTimeout(500); }],
  ['เปลี่ยนเดือน', async (p) => { await p.evaluate(() => window.scrollTo(0, 0)); await p.click('.mn-btns .icon-btn >> nth=0'); await p.waitForTimeout(1500); }],
  ['สลับแท็บ กระเป๋า', async (p) => { await p.click('[data-view="wallets"]'); await p.waitForTimeout(900); }],
  ['สลับแท็บ ภาพรวม', async (p) => { await p.click('[data-view="home"]'); await p.waitForTimeout(1400); }],
  ['เปิดแผ่นจด (วงหมุนขยาย)', async (p) => { await p.click('#btn-add'); await p.waitForTimeout(1300); }],
  ['กดเลขในแผ่นจด', async (p) => { for (const k of ['1', '2', '5']) { await p.click(`.keypad button:text-is("${k}")`); await p.waitForTimeout(120); } await p.waitForTimeout(300); }],
  ['กดเลือกหมวด', async (p) => { await p.click('.cat-pill >> nth=1'); await p.waitForTimeout(500); }],
  ['บันทึก + ปิดแผ่นจด + ยอดอัปเดต', async (p) => { await p.click('#entry-save'); await p.waitForTimeout(1600); }],
  ['ปิดด้วย X (วงย้อนกลับ)', async (p) => { await p.evaluate(() => window.scrollTo(0, 0)); await p.click('#btn-add'); await p.waitForTimeout(900); await p.evaluate(() => { window.__f = []; }); await p.click('#sheet .icon-btn'); await p.waitForTimeout(900); }],
  ['เลื่อนหน้าแรก', async (p) => { for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(40); } await p.waitForTimeout(600); }],
];
(async () => {
  const b = await chromium.launch({ args: ['--enable-gpu-rasterization'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    window.__f = []; let last = 0;
    const loop = (t) => { if (last) window.__f.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await p.goto('file://' + file); await p.waitForTimeout(2600);
  const cdp = await ctx.newCDPSession(p);
  if (thr > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
  const out = [];
  const notComposited = new Map();
  for (const [name, fn] of SCEN) {
    const events = [];
    cdp.removeAllListeners('Tracing.dataCollected');
    cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.animations,disabled-by-default-devtools.timeline,cc', transferMode: 'ReportEvents' });
    await p.evaluate(() => { window.__f = []; });
    await fn(p);
    const fr = await p.evaluate(() => window.__f);
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end'); await done;
    // animation ที่ compositor รับไปทำไม่ได้
    for (const e of events) {
      if (e.name === 'Animation' && e.args && e.args.data && e.args.data.compositeFailed) {
        const d = e.args.data;
        const key = (d.displayName || d.name || d.id) + ' [' + (d.unsupportedProperties || []).join(',') + '] code=' + d.compositeFailed;
        notComposited.set(key, (notComposited.get(key) || 0) + 1);
      }
    }
    const main = events.filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.dur);
    const longTasks = main.filter((e) => e.dur > 16700).length;
    const paints = events.filter((e) => e.name === 'Paint').length;
    const layouts = events.filter((e) => e.name === 'Layout').length;
    const sorted = [...fr].sort((a, z) => a - z);
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const sum = (n) => +(events.filter((e) => e.name === n && e.dur).reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0);
    const js = +(events.filter((e) => (e.name === 'FunctionCall' || e.name === 'EvaluateScript' || e.name === 'FireAnimationFrame' || e.name === 'EventDispatch') && e.dur).reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0);
    out.push({ scene: name, 'js': js, 'style': sum('UpdateLayoutTree'), 'layout': sum('Layout'), 'paint': sum('Paint') + sum('PaintImage'),  frames: fr.length, 'p95(ms)': +p95.toFixed(1), 'janky>25ms': fr.filter((x) => x > 25).length, 'max(ms)': +(Math.max(0, ...fr)).toFixed(1), longTasks, layouts, paints });
  }
  console.log(`\n=== CPU ช้าลง ${thr}x ===`);
  console.table(out);
  console.log('animation ที่ไม่ได้วิ่งบน compositor:', notComposited.size ? '' : 'ไม่มี');
  for (const [k, v] of notComposited) console.log('  ', v + 'x', k);
  await b.close();
})();
