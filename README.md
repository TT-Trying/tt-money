# TT Money

แอพจดรายรับรายจ่ายส่วนตัว เก็บข้อมูลใน Google Sheet ของตัวเอง

```
frontend (โฟลเดอร์หลัก, GitHub Pages)  ──>  backend/ (Google Apps Script)  ──>  Google Sheet
```

## Frontend (หน้าแอพ)
อัปโหลดขึ้น GitHub Pages (ฟรี) แล้วเปิดจากมือถือ

- `index.html`, `style.css`, `app.js`  หน้าแอพ
- `manifest.webmanifest`, `sw.js`, `icons/`  ทำให้ติดตั้งเป็นแอพบน Android และเปิดได้ตอนไม่มีเน็ต

เวลาแก้โค้ดแล้วอัปโหลดใหม่: เปลี่ยน `ttm-v2` ใน `sw.js` เป็นเลขถัดไป (เช่น `ttm-v3`) มือถือจะได้โหลดเวอร์ชันใหม่

## Backend
โค้ด Apps Script อยู่ที่ [`backend/Code.gs`](backend/Code.gs) วิธีติดตั้งและอัปเดตอยู่ที่ [`backend/README.md`](backend/README.md)

## ความลับ
ไม่มีความลับอยู่ในไฟล์ใน repo นี้ จึงเป็น repo สาธารณะได้
- Web app URL และ token เก็บไว้ในมือถือของ TT เท่านั้น
- token กับ Sheet ID ฝั่ง backend เก็บใน Script Properties ของ Apps Script
- ห้าม commit token, URL `/exec` หรือภาพหน้าจอที่มีค่าเหล่านี้
