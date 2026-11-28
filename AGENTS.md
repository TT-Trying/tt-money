# AGENTS.md — คู่มือสำหรับ AI ที่จะทำงานใน repo นี้

ไฟล์นี้สรุปทุกอย่างที่ต้องรู้ก่อนแก้โค้ด TT Money อ่านให้จบก่อนเริ่มงาน
(For AI agents: this is the project guide. The owner writes in Thai; reply in Thai mixed with English tech terms.)

## แอพนี้คืออะไร
แอพจดรายรับรายจ่ายส่วนตัว (PWA) สำหรับมือถือ เจ้าของใช้คนเดียว ข้อมูลอยู่ใน Google Sheet ของเจ้าของเอง
เพื่อนที่อยากใช้จะติดตั้ง Sheet + Apps Script ของตัวเอง แล้วใช้หน้าแอพลิงก์เดียวกัน (ข้อมูลแยกกันคนละ Sheet)

- หน้าแอพ: https://tt-trying.github.io/tt-money/ (GitHub Pages จาก branch `main`)
- เจ้าของไม่ได้เป็นโปรแกรมเมอร์เต็มตัว: อธิบายเหตุผลเป็นภาษาง่าย ๆ ก่อนลงมือ และบอกตรง ๆ ว่าอะไรทดสอบแล้ว อะไรยังไม่ได้ทดสอบ

## โครงสร้าง
```
แอพ (index.html / style.css / app.js)  ──POST JSON + token──>  backend/Code.gs (Apps Script)  ──>  Google Sheet
```

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | โครง HTML (หัวแอพ, 4 view, แท็บล่าง, ปุ่มจด, แผ่นจด, toast) |
| `style.css` | สีทั้งหมดเป็นตัวแปรใน `:root` มี dark mode ใน `@media (prefers-color-scheme: dark)` |
| `app.js` | JavaScript ล้วน ไม่มี framework ไม่มี build step (ประมาณ 1,400 บรรทัด) |
| `sw.js` | service worker: เปิดจาก cache ก่อนแล้วอัปเดตเบื้องหลัง (stale-while-revalidate) **ทุก fetch ไปไฟล์ของแอพต้องใช้ `cache: 'no-cache'`** (ฟังก์ชัน `fresh`) เพราะ GitHub Pages ให้เบราว์เซอร์จำไฟล์ 10 นาที ถ้าลืม มือถือจะติดเวอร์ชันเก่า (เคยเกิดแล้วใน 1.2.1) |
| `manifest.webmanifest`, `icons/` | ติดตั้งเป็นแอพบนมือถือ |
| `backend/Code.gs` | API บน Google Apps Script ดู `backend/README.md` |
| `docs/SETUP_GUIDE_TH.md` | คู่มือให้เพื่อนติดตั้งเอง (เขียนให้โหลดไปให้ AI สอนได้) |
| `tools/build-demo.py`, `tools/demo-prelude.js` | สร้าง `demo.html` ที่ใช้ backend จำลอง ไว้ทดสอบ |
| `tools/perf-check.js` | วัดความลื่น (เฟรมสะดุด + animation ที่ไม่ได้วิ่งบน GPU) |

## กฎที่ต้องทำทุกครั้ง ⚠️
1. **แก้ไฟล์หน้าแอพเมื่อไหร่ ให้เพิ่มเลข `CACHE` ใน `sw.js`** (เช่น `ttm-v5` → `ttm-v6`) และเพิ่ม `APP_VERSION` ใน `app.js`
   ไม่งั้นมือถือจะติดเวอร์ชันเก่า หลัง deploy เปิดแอพครั้งแรกจะขึ้นแจ้ง "มีเวอร์ชันใหม่ · โหลดใหม่" (หรือได้เองตอนเปิดครั้งที่สอง)
2. **ห้ามใส่ความลับใน repo** (repo เป็น public): ห้าม token, Web app URL (`.../exec`), Sheet ID, อีเมล, ภาพหน้าจอ log ที่มี token
   token กับ Sheet ID ฝั่ง backend อยู่ใน Script Properties, ฝั่งแอพอยู่ใน localStorage ของมือถือเท่านั้น
3. **ห้ามเปลี่ยน API contract โดยไม่แก้ทั้งสองฝั่ง**: ชื่อ action, รูปแบบ `args` และข้อมูลที่ตอบกลับ ถ้าเปลี่ยน ต้องแก้ `backend/Code.gs` + `tools/demo-prelude.js` และบอกเจ้าของว่าต้อง deploy backend ใหม่
   หน้าแอพเวอร์ชันใหม่ควรใช้กับ backend เวอร์ชันเก่าได้ (มี fallback) เพราะเจ้าของ deploy สองฝั่งไม่พร้อมกัน
4. **animation ทุกตัวต้องปิดได้** ด้วย `prefers-reduced-motion` (CSS อยู่ใน `@media (prefers-reduced-motion: no-preference)`, JS เช็ค `reduceMotion()`)
5. **ทดสอบทั้ง light และ dark mode** และที่ความกว้างมือถือ (~390px)
6. ข้อความใน UI เป็นภาษาไทย ภาษาพูดง่าย ๆ ใช้ศัพท์อังกฤษเฉพาะที่คนไทยใช้กันจริง
7. ทำงานบน branch แยก แล้วเปิด PR เข้า `main` (merge = ขึ้นมือถือจริง) commit/push เมื่อเจ้าของขอเท่านั้น

## หลักการใน `app.js` ที่ต้องเข้าใจก่อนแก้
**State เดียว:** ทุกอย่างอยู่ใน object `S` แล้ว `render()` วาดหน้าใหม่จาก state (ใช้ helper `h(tag, attrs, ...children)` สร้าง DOM)

**Optimistic UI (ส่วนที่ซับซ้อนที่สุด แตะเท่าที่จำเป็น):**
- จด/แก้/ลบ แล้วหน้าจอเปลี่ยนทันที ไม่รอ server ผ่าน "op" ใน `S.ops` (`kind: 'add' | 'update' | 'delete'`)
- `S.server` = ข้อมูลจาก server, `S.boot` = `derive()` เอา `S.server` + ops ที่ยังไม่สะท้อนในข้อมูล server มาซ้อนกัน หน้าจออ่านจาก `S.boot` เสมอ
- `S.epoch` นับเพิ่มเมื่อ server ยืนยัน op (`confirmOp`), snapshot ที่ดึงมาตอน epoch E มี op ที่ confirmed ≤ E อยู่แล้ว (`liveOps`)
- `pruneOps()` ทิ้ง op ที่ server มีแล้ว ส่วน list รายเดือนที่ cache ไว้ (`S.lists`) จะถูก "อบ" op ลงไป แล้วตั้ง `dirty` ให้โหลดใหม่
- ออฟไลน์: batch เข้า `S.queue` (localStorage `ttm_queue`) แล้ว `flushQueue()` ส่งเมื่อออนไลน์ แต่ละ batch มี `clientId` ให้ backend กันบันทึกซ้ำ
- รายการที่ยังไม่ยืนยันมี id ขึ้นต้น `tmp-` ห้ามส่ง id แบบนี้ไป backend

**การวาดหน้า:**
- `render({ bg: true })` = อัปเดตเบื้องหลัง: ข้ามถ้าข้อมูลไม่เปลี่ยน และเลื่อนไปทำหลังผู้ใช้พิมพ์เสร็จ (`isEditingMain`) เพื่อไม่ให้หลุดโฟกัส
- ตัวเลขที่เปลี่ยนให้ใส่ `tw(key, value)` จะนับขึ้นลงและวาบสีเอง แถบกราฟใช้ `data-bar` / `data-w`
- ช่องค้นหาในหน้ารายการ: ตอนพิมพ์เรียก `fillListResults()` วาดเฉพาะผลลัพธ์ ห้ามเรียก `render()` (คีย์บอร์ดจะหุบ)
- แผ่นจด (`renderSheet`) วาดใหม่ทั้งแผ่นทุกครั้งที่กดตัวเลือก จึง**ห้ามใส่ CSS animation ให้ของในแผ่นจด** เพราะจะเล่นซ้ำทุกครั้งที่กด (ยกเว้นทำให้เล่นเฉพาะตอนเปิด/ปิด)
- ไอคอนหมวด: `ICONS` (SVG เส้น + hue) และ `CAT_ICON_RULES` (regex ชื่อหมวด → ไอคอน, ข้อแรกที่ตรงชนะ) เพิ่มหมวดใหม่ให้เพิ่มกฎตรงนี้

**ฟีเจอร์ที่มีอยู่:** หน้าภาพรวม (ยอดรวม, งบวันนี้ = (เงินใช้ได้ + ที่จ่ายวันนี้) ÷ วันที่เหลือในเดือน, กระเป๋า, สรุปเดือน, ล่าสุด), หน้ารายการ (เปลี่ยนเดือน/ปัดซ้ายขวา, ค้นหาเดือนนี้หรือ 12 เดือน, ปุ่มลบกด 2 ครั้ง), หน้ากระเป๋า (ยอดตั้งต้น, เทียบยอดจริง, เปลี่ยนชื่อ, เพิ่มกระเป๋า), แผ่นจด (keypad, ปุ่มจดเร็ว, เลือกวันเวลาแบบจิ้ม/พิมพ์, หาร, เติมจากกระเป๋าอื่น), ดึงลงเพื่อรีเฟรช, sync ทุก 60 วิ

## ความลื่น (ตรวจแล้วใน v2 ด้วย `tools/perf-check.js`)
- **animate ได้แค่ `transform` กับ `opacity`** สองตัวนี้วิ่งบน GPU ลื่นทุก refresh rate แม้ CPU กำลังยุ่ง
  ห้าม animate `border-radius`, `background-color`, `height`/`width`, `box-shadow`, `filter` ของพื้นที่ใหญ่ เพราะต้องวาดใหม่ทุกเฟรม
  (ยกเว้นที่รู้แล้วว่าเล็ก: วงแหวน `stroke-dashoffset` 128px, สีตัวเลขในแผ่นจด)
- **ห้าม animation วนไม่รู้จบ** ยกเว้น spinner ตอนโหลด (บนจอ 120Hz GPU ต้องวาดทุกเฟรม เปลืองแบต)
- **กดแล้วต้องสร้างหน้าใหม่: ให้ animation เริ่มก่อน แล้วค่อยสร้างหน้าใน `afterPaint()`** (ดู `go()` และ `submitEntry`)
- อย่าใส่ `will-change` ให้ของที่มีหลายชิ้น (ทุกแถว/ทุกตัวเลข) จะกินหน่วยความจำ GPU
- เช็คด้วย `node tools/perf-check.js "$PWD/demo.html" 4` ทั้งก่อนและหลังแก้ UI

## Backend (`backend/Code.gs`)
- Apps Script ผูกกับ Google Sheet, deploy เป็น Web app (Execute as: Me, Access: Anyone) ทุกคำขอต้องมี token
- คำสั่งเขียนทุกตัวต้องได้ `LockService` ก่อน, อ่านผ่าน `cached_()` ที่ผูกกับ `REV` (เปลี่ยนทุกครั้งที่เขียน หรือแก้ใน Sheet ผ่าน `onEdit`)
- ตำแหน่งในชีตตายตัว: Wallets แถว 5-14 (คอลัมน์ A-G), วันเริ่มใช้ที่ `Wallets!B2`, Transactions 13 คอลัมน์ ห้ามเปลี่ยนโดยไม่แก้โค้ด
- **AI รัน Apps Script ไม่ได้** ทดสอบได้แค่ `node --check` (ก๊อปเป็นไฟล์ `.js` ก่อน) กับอ่านโค้ด ต้องบอกเจ้าของเสมอว่ายังไม่ได้รันจริง
- วิธี deploy เวอร์ชันใหม่ (เจ้าของทำเอง): วางโค้ด → รัน `setup` แล้วกดอนุญาต → Manage deployments → ✏️ → New version
  (ห้ามบอกให้กด New deployment เพราะ URL จะเปลี่ยน)

## วิธีทดสอบ
```bash
python3 tools/build-demo.py        # ได้ demo.html (ไม่ถูก commit) เปิดในเบราว์เซอร์ได้เลย
node --check app.js && node --check sw.js
```
- `demo.html` ใช้ backend จำลองใน `tools/demo-prelude.js` (ข้อมูลปลอม ตอบช้า ~1 วิ มีปุ่มจำลองเน็ตหลุด)
- ถ้ามี Playwright: เปิด `demo.html` แล้วทดสอบ flow ที่แก้ ทั้ง light/dark ที่ 390px และดูว่าไม่มี `pageerror`
- service worker ทดสอบใน `demo.html` ไม่ได้ (เป็นไฟล์เดี่ยว) ต้องเปิดผ่าน `http://localhost` แล้ว register `sw.js` เอง
  และให้ server ส่ง `Cache-Control: max-age=600` + `ETag` เหมือน GitHub Pages
  ระวัง: ใน Playwright ถ้ามี `page.route()` อยู่ HTTP cache จะถูกปิด ผลทดสอบเรื่องเวอร์ชันค้างจะผ่านหลอก ๆ

## ข้อจำกัดที่รู้อยู่แล้ว
- Apps Script ตอบช้า ~0.5-2 วิต่อคำขอ (เพดานของ Google) ความเร็วที่รู้สึกได้มาจาก optimistic UI และ cache
- ข้อมูลใน `Transactions` อ่านทั้งชีตทุกครั้งที่ cache หมดอายุ ถ้าข้อมูลเยอะมาก (หลายหมื่นแถว) จะเริ่มช้า
- สูตรใน Sheet จริงของเจ้าของจำกัดถึงแถว 20103 (Sheet ที่ `setup()` สร้างใหม่ใช้ทั้งคอลัมน์)
- ถ้าอนาคตจะให้หลายคนใช้ระบบกลางร่วมกัน ควรย้าย backend ไป database จริง (เช่น Supabase) แทน Sheet
