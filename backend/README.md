# TT Money backend (Google Apps Script)

`Code.gs` คือ API ที่แอพเรียกใช้ ทำงานเป็น Web app ของ Apps Script ที่ผูกอยู่กับ Google Sheet

```
แอพ (GitHub Pages)  ──POST + token──>  Apps Script (Code.gs)  ──>  Google Sheet
```

## ความปลอดภัย
- **ไม่มีความลับอยู่ในไฟล์นี้** จึงเก็บใน repo สาธารณะได้
- `TOKEN` และ `SHEET_ID` เก็บใน **Script Properties** ของโปรเจกต์ Apps Script (สร้างตอนรัน `setup()`)
- ห้าม commit token, URL `/exec` หรือภาพหน้าจอ Execution log ที่มี token ลงใน repo
- ถ้าสงสัยว่า token หลุด: รัน `resetToken()` แล้วกรอก token ใหม่ในแอพ (token เก่าใช้ไม่ได้ทันที)

## ติดตั้งครั้งแรก
1. สร้าง Google Sheet เปล่า (หรือใช้ Sheet แม่แบบที่มีแท็บอยู่แล้วก็ได้)
2. เมนู **ส่วนขยาย → Apps Script** แล้ววางโค้ดจาก `Code.gs`
3. **Project Settings** → ตั้ง Time zone เป็น `Asia/Bangkok`
4. เลือกฟังก์ชัน `setup` แล้วกด **Run** (ครั้งแรกจะขอสิทธิ์ ให้กดอนุญาต)
   - สร้างแท็บ `Transactions`, `Wallets`, `Categories`, `Presets` พร้อมสูตรให้เอง **เฉพาะแท็บที่ยังไม่มี** (แท็บเดิมไม่ถูกแตะ)
   - สร้าง token ถ้ายังไม่มี (ถ้ามีแล้วจะใช้ตัวเดิม)
5. เปิด **Execution log** แล้วคัดลอก token ไว้
6. **Deploy → New deployment** → ชนิด **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. คัดลอก Web app URL (ลงท้ายด้วย `/exec`)
8. เปิดแอพ แล้วใส่ URL กับ token ในหน้าตั้งค่าการเชื่อมต่อ

ฟังก์ชันที่รันเองได้

| ฟังก์ชัน | ทำอะไร |
|---|---|
| `setup()` | สร้างแท็บที่ขาด + token (รันซ้ำได้ ไม่ทำให้ข้อมูลหรือ token เปลี่ยน) |
| `selfTest()` | เช็คว่าอ่านชีตได้ |
| `showToken()` / `resetToken()` | ดู token / สร้าง token ใหม่ |
| `backupNow()` | สำรอง Sheet ไปโฟลเดอร์ `TT Money Backups` ใน Drive (เก็บ 8 ชุดล่าสุด) |
| `installWeeklyBackup()` / `removeWeeklyBackup()` | เปิด/ปิดสำรองอัตโนมัติทุกวันอาทิตย์ตี 3 |

## อัปเดตโค้ดโดยไม่ให้ URL เปลี่ยน
1. แก้ `Code.gs` ใน repo ก่อน แล้ววางทับในหน้า Apps Script แล้วบันทึก
2. รัน `setup` 1 ครั้ง ถ้าโค้ดใหม่ขอสิทธิ์เพิ่ม (เช่น Drive สำหรับสำรองข้อมูล) จะได้กดอนุญาตตรงนี้
   ถ้าข้ามขั้นนี้ แอพจะเจอ error `Authorization is required`
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**
   (ถ้ากด New deployment จะได้ URL ใหม่ ต้องไปกรอกในแอพใหม่)

## ความเร็ว
- ภายในคำขอเดียว เปิดไฟล์และอ่านแต่ละแท็บแค่ครั้งเดียว (`memo_`)
- ผลการอ่าน (`bootstrap`, `listTransactions`) จำไว้ใน CacheService 10 นาที โดยผูกกับเลข `REV` ใน Script Properties
  ซึ่งเปลี่ยนทุกครั้งที่มีการเขียนผ่านแอพ หรือมีคนแก้ใน Sheet เอง (simple trigger `onEdit`) แคชเก่าจึงไม่ถูกใช้
- `listTransactions` รับ `months: [...]` เพื่อขอหลายเดือนในคำขอเดียว (ใช้ตอนค้นหาย้อนหลัง)

## ให้เพื่อนใช้ (แต่ละคนมี Sheet ของตัวเอง)
คู่มือละเอียดสำหรับเพื่อน (โหลดไปให้ AI สอนทีละขั้นได้): [`docs/SETUP_GUIDE_TH.md`](../docs/SETUP_GUIDE_TH.md)

การทำสำเนา Google Sheet (**ไฟล์ → ทำสำเนา**) จะได้โค้ด Apps Script ติดไปด้วย
1. เตรียม Sheet แม่แบบที่ลบข้อมูลส่วนตัวออกแล้ว (รายการใน `Transactions`, ชื่อและยอดกระเป๋า)
2. เพื่อนทำสำเนา แล้วทำตามขั้นตอนติดตั้งตั้งแต่ข้อ 3
3. เพื่อนใช้หน้าแอพลิงก์เดียวกับเรา แต่ใส่ URL และ token ของตัวเอง ข้อมูลจึงแยกกันคนละ Sheet

## API
ส่ง `POST` เป็น `text/plain` ที่มี JSON `{ token, action, args }` ตอบกลับเป็น `{ ok, data }` หรือ `{ ok: false, error }`

| action | ใช้ทำอะไร |
|---|---|
| `bootstrap` | ข้อมูลตั้งต้นทั้งหมด: กระเป๋า หมวด ปุ่มจดเร็ว 30 รายการล่าสุด สรุปเดือนนี้ |
| `listTransactions` | รายการของเดือน (`month`, `limit` สูงสุด 500, `offset`, `wallet`) หรือหลายเดือน (`months` สูงสุด 24 → ตอบเป็น `{ months: { 'yyyy-MM': { total, items } } }`) |
| `summary` | สรุปรายรับรายจ่ายของเดือน |
| `addTransactions` | เพิ่ม 1-20 รายการ กันส่งซ้ำด้วย `clientId` (6 ชั่วโมง) |
| `updateTransaction` / `deleteTransaction` / `restoreTransaction` | แก้ / ลบ (soft delete) / กู้คืน |
| `addWallet` / `renameWallet` / `setWalletOpening` / `setCounted` / `setStartDate` | จัดการกระเป๋าและวันเริ่มใช้ |

คำสั่งที่เขียนข้อมูลทุกตัวต้องได้ `LockService` ก่อน จึงไม่เขียนทับกันเมื่อมีหลายคำขอพร้อมกัน
ฝั่ง server จำกัดโน้ตไม่เกิน 200 ตัวอักษร หมวด/หมวดย่อยไม่เกิน 50 และรับเฉพาะชื่อคำสั่งที่ประกาศไว้ใน `ACTIONS`
