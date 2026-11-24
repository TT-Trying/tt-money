"""สร้างไฟล์ demo หน้าเดียว (HTML) ที่รวมหน้าแอพ + backend จำลอง ไว้ทดสอบโดยไม่ต้องต่อ Google Sheet จริง

ใช้: python3 tools/build-demo.py [ไฟล์ปลายทาง]   (ค่าเริ่มต้น: demo.html ที่ root ของ repo ซึ่งไม่ถูก commit)
เปิดไฟล์ที่ได้ในเบราว์เซอร์ได้เลย ข้อมูลเป็นของปลอม รีเซ็ตทุกครั้งที่รีโหลด
"""
import os, re, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'demo.html')
pre = os.path.join(root, 'tools', 'demo-prelude.js')
css=open(root+'/style.css').read()
js=open(root+'/app.js').read()
html=open(root+'/index.html').read()
# theme contract: guard dark under data-theme
m=re.search(r'@media \(prefers-color-scheme: dark\) \{\n  :root \{(.*?)\n  \}\n\}',css,re.S)
dark=m.group(1)
css=css.replace(m.group(0),'@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {'+dark+'\n  }\n}\n:root[data-theme="dark"] {'+dark+'\n}')
css+='''
/* ---------- demo bar ---------- */
.demo-bar { background: var(--warn-bg); color: var(--warn-text); font-size: 13.5px;
  padding: 10px max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.demo-bar .in { max-width: 560px; margin: 0 auto; display: grid; gap: 8px; }
.demo-bar b { font-weight: 700; }
.demo-bar .acts { display: flex; flex-wrap: wrap; gap: 8px; }
.demo-bar button { min-height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid currentColor;
  background: transparent; color: inherit; font-weight: 600; font-size: 13px; }
.demo-bar button[aria-pressed="true"] { background: var(--warn-text); color: var(--warn-bg); }
.demo-bar ol { margin: 0; padding-left: 20px; }
'''
assert "  cfg: LS.get('ttm_cfg', null)," in js
js=js.replace("  cfg: LS.get('ttm_cfg', null),","  cfg: { url: 'https://script.google.com/macros/s/DEMO/exec', token: 'demo-token-demo-token-demo' },")
js=js.replace("if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});","")
body=html[html.index('<body>')+6:html.index('<script src="app.js">')]
bar='''<div class="demo-bar"><div class="in">
  <div><b>โหมดสาธิต</b> ข้อมูลปลอมทั้งหมด ไม่ได้ต่อกับ Sheet จริง (ตั้งให้ตอบช้า ~1 วินาทีเหมือนของจริง)</div>
  <ol>
    <li>กด <b>+ จด</b> แล้วเลือกปุ่ม <b>กาแฟ</b> แล้วกด <b>บันทึก</b> ยอดเงินจะเปลี่ยนทันที</li>
    <li>ในหน้าจด แตะ <b>วันนี้ · ตอนนี้</b> เพื่อเลือกวันเวลา แตะตัวเลขชั่วโมง/นาทีเพื่อพิมพ์เองได้</li>
    <li>หน้ารายการ: พิมพ์ <b>grab</b> ในช่องค้นหา แล้วลองกด <b>ย้อนหลัง 12 เดือน</b></li>
    <li>กดถังขยะข้างรายการ แล้วกด <b>ลบ?</b> อีกครั้งเพื่อยืนยัน (มีปุ่มเลิกทำ)</li>
    <li>เปิดเน็ตหลุดแล้วลองจด รายการจะขึ้นว่า <b>รอส่ง</b> ปิดแล้วจะส่งให้เอง</li>
    <li>หน้ารายการปัดซ้าย/ขวาเพื่อเปลี่ยนเดือน ด้านบนดึงลงเพื่อรีเฟรช</li>
  </ol>
  <div class="acts">
    <button type="button" id="demo-off" aria-pressed="false">จำลองเน็ตหลุด</button>
    <button type="button" id="demo-reset">เริ่มใหม่</button>
  </div>
</div></div>
'''
ctrl='''
document.getElementById('demo-off').addEventListener('click', (e) => {
  window.DEMO.offline = !window.DEMO.offline;
  e.currentTarget.setAttribute('aria-pressed', String(window.DEMO.offline));
  e.currentTarget.textContent = window.DEMO.offline ? 'เน็ตหลุดอยู่ (กดเพื่อต่อเน็ต)' : 'จำลองเน็ตหลุด';
  if (!window.DEMO.offline) syncNow(false);
});
document.getElementById('demo-reset').addEventListener('click', () => location.reload());
'''
page=f'''<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>TT Money Demo</title>
<meta name="theme-color" content="#18286A">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
{css}
</style>
{bar}{body}
<script>
{open(pre).read()}
</script>
<script>
{js}
{ctrl}
</script>
'''
open(out,'w').write(page)
print('สร้างแล้ว:', out)
