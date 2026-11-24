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
1. เปิด Google Sheet ที่มีแท็บ `Transactions`, `Wallets`, `Categories`, `Presets` ตามแม่แบบ
   (ยอดคงเหลือของกระเป๋าคำนวณด้วยสูตรในแท็บ `Wallets` จึงต้องใช้ Sheet แม่แบบ ไม่ใช่ Sheet เปล่า)
2. เมนู **ส่วนขยาย → Apps Script** แล้ววางโค้ดจาก `Code.gs`
3. **Project Settings** → ตั้ง Time zone เป็น `Asia/Bangkok`
4. เลือกฟังก์ชัน `setup` แล้วกด **Run** (ครั้งแรกจะขอสิทธิ์ ให้กดอนุญาต)
5. เปิด **Execution log** แล้วคัดลอก token ไว้
6. **Deploy → New deployment** → ชนิด **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. คัดลอก Web app URL (ลงท้ายด้วย `/exec`)
8. เปิดแอพ แล้วใส่ URL กับ token ในหน้าตั้งค่าการเชื่อมต่อ

ฟังก์ชันอื่นที่รันเองได้: `selfTest()` (เช็คว่าอ่านชีตได้), `showToken()`, `resetToken()`

## อัปเดตโค้ดโดยไม่ให้ URL เปลี่ยน
แก้ `Code.gs` ใน repo ก่อน แล้ววางทับในหน้า Apps Script จากนั้น
**Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**
(ถ้ากด New deployment จะได้ URL ใหม่ ต้องไปกรอกในแอพใหม่)

## ให้เพื่อนใช้ (แต่ละคนมี Sheet ของตัวเอง)
การทำสำเนา Google Sheet (**ไฟล์ → ทำสำเนา**) จะได้โค้ด Apps Script ติดไปด้วย
1. เตรียม Sheet แม่แบบที่ลบข้อมูลส่วนตัวออกแล้ว (รายการใน `Transactions`, ชื่อและยอดกระเป๋า)
2. เพื่อนทำสำเนา แล้วทำตามขั้นตอนติดตั้งตั้งแต่ข้อ 3
3. เพื่อนใช้หน้าแอพลิงก์เดียวกับเรา แต่ใส่ URL และ token ของตัวเอง ข้อมูลจึงแยกกันคนละ Sheet

## API
ส่ง `POST` เป็น `text/plain` ที่มี JSON `{ token, action, args }` ตอบกลับเป็น `{ ok, data }` หรือ `{ ok: false, error }`

| action | ใช้ทำอะไร |
|---|---|
| `bootstrap` | ข้อมูลตั้งต้นทั้งหมด: กระเป๋า หมวด ปุ่มจดเร็ว 30 รายการล่าสุด สรุปเดือนนี้ |
| `listTransactions` | รายการของเดือน (`month`, `limit` สูงสุด 500, `offset`, `wallet`) |
| `summary` | สรุปรายรับรายจ่ายของเดือน |
| `addTransactions` | เพิ่ม 1-20 รายการ กันส่งซ้ำด้วย `clientId` (6 ชั่วโมง) |
| `updateTransaction` / `deleteTransaction` / `restoreTransaction` | แก้ / ลบ (soft delete) / กู้คืน |
| `addWallet` / `renameWallet` / `setWalletOpening` / `setCounted` / `setStartDate` | จัดการกระเป๋าและวันเริ่มใช้ |

คำสั่งที่เขียนข้อมูลทุกตัวต้องได้ `LockService` ก่อน จึงไม่เขียนทับกันเมื่อมีหลายคำขอพร้อมกัน
