# Jadiphoto.Moment — Aplikasi Booking & Sortir Foto Klien

Aplikasi ini adalah **Jadiphoto.Moment** (Aplikasi Booking, Keuangan & Perantara Sortir Foto Klien) berbasis web. Aplikasi ini dirancang untuk memudahkan operasional Jadiphoto.Moment dalam menangani booking, pembayaran, serta memberikan akses kepada klien untuk memilih (menyortir) foto yang telah diunggah di folder Google Drive. Aplikasi ini dibangun menggunakan Node.js (Express), database PostgreSQL, dan menggunakan Fonnte API untuk notifikasi WhatsApp.

---

## 🌟 Fitur Utama

1. **Manajemen Sesi Sortir (Admin Dashboard)**
   - Admin dapat membuat sesi baru untuk setiap klien.
   - Admin memasukkan URL folder Google Drive, nama klien, dan **batas maksimal foto** (photo limit) yang boleh dipilih.
   - Sistem secara otomatis membuat tautan pendek (shortlink) khusus untuk klien (contoh: `domain.com/s/namaklien`).
   
2. **Integrasi Google Drive Langsung**
   - Mengambil daftar foto secara dinamis langsung dari ID Folder Google Drive yang diberikan.
   - Dilengkapi dengan *caching* ringan agar proses loading galeri foto lebih cepat jika dibuka berulang.

3. **Galeri & Pemilihan Foto Interaktif (Client-facing)**
   - Klien membuka link dan langsung dihadapkan pada galeri foto tanpa perlu login.
   - Klien dapat memilih foto yang mereka inginkan hingga batas maksimal yang ditentukan admin.
   - Klien dapat memberikan **catatan tambahan (notes)** pada masing-masing foto (misal: "tolong hapus jerawat", "cahaya diterangkan").

4. **Notifikasi WhatsApp Otomatis**
   - Terintegrasi dengan Fonnte API untuk mengirim pesan WhatsApp.
   - Digunakan untuk mengirim tautan sesi ke klien, atau memberikan notifikasi kepada admin/klien saat proses sortir telah diselesaikan.

5. **Pelacakan Status (Status Tracking)**
   - Status sortir klien: Aktif (`active`) atau Selesai (`completed`).
   - Status pengerjaan edit: Diterima (`received`), Sedang Diedit (`editing`), dan Selesai (`done`).
   
6. **Keamanan Login Admin**
   - Menggunakan hashing `bcryptjs` untuk password dan JSON Web Token (JWT) untuk sesi login admin yang aman.

---

## ⚙️ Skema Alur Sistem Berjalan (Workflow)

**1. Pembuatan Sesi (Oleh Admin)**
- Admin masuk ke dashboard menggunakan *username* dan *password*.
- Admin membuat Sesi Sortir baru. Admin menaruh tautan folder Google Drive yang berisi raw foto, mengisi nama klien, dan mengatur berapa banyak foto yang bisa dipilih (misalnya 10 foto dari total 100 foto).
- Aplikasi akan memproses data tersebut ke database (PostgreSQL) dan menghasilkan *URL pendek* (Shortlink).

**2. Pengiriman Akses (Admin -> Klien)**
- Admin membagikan *shortlink* yang telah dibuat kepada klien. Pembagian ini dapat dibantu menggunakan fitur kirim WhatsApp yang terintegrasi di dalam dashboard admin.

**3. Proses Sortir (Oleh Klien)**
- Klien mengklik tautan tersebut (`/s/slug`) dan diarahkan ke halaman galeri (`/gallery.html`).
- Aplikasi akan menarik file foto dari Google Drive (melalui `routes/drive.js`) dan menampilkannya di layar klien.
- Klien mulai mengklik foto-foto yang dipilih. Jika klien mencoba memilih lebih dari limit, sistem akan mencegahnya. Klien juga bisa menambahkan catatan revisi pada foto yang dipilih.

**4. Penyelesaian & Notifikasi**
- Setelah kuota terpenuhi atau klien merasa sudah cukup, klien menekan tombol "Selesai" (Submit).
- Sistem akan mengunci sesi (`completed`), menyimpan daftar file ID yang terpilih beserta catatannya ke dalam tabel database (`selections`).
- Sistem secara otomatis mengirimkan notifikasi WhatsApp (melalui `routes/notify.js` dengan Fonnte) untuk memberitahukan bahwa proses sortir telah selesai dilakukan klien.

**5. Proses Pengerjaan (Kembali ke Admin)**
- Admin menerima notifikasi, mengecek dashboard, dan melihat daftar foto mana saja (beserta catatannya) yang dipilih oleh klien.
- Admin mengubah status pengerjaan (misalnya menjadi `editing`). Setelah pengeditan foto klien selesai, admin dapat memindahkan statusnya ke `done`.

---

## 🚀 Cara Menjalankan Secara Lokal

### 1. Prasyarat
- **Node.js** (v18.x atau v20.x direkomendasikan)
- **npm** (bawaan Node.js)
- Database **PostgreSQL** (bisa menggunakan [Neon](https://neon.tech), Supabase, atau PostgreSQL lokal)

### 2. Instalasi & Konfigurasi

1. **Masuk ke Direktori Proyek & Install Dependensi**:
   ```bash
   npm install
   ```

2. **Konfigurasi Environment (`.env`)**:
   Salin file `.env.example` menjadi `.env` (jika belum ada):
   ```bash
   cp .env.example .env
   ```
   Buka file `.env` dan lengkapi konfigurasi berikut:
   - `PORT`: Port server (default: `3000`)
   - `JWT_SECRET`: Secret key acak untuk autentikasi JWT
   - `DATABASE_URL`: Connection string PostgreSQL (contoh: `postgresql://user:password@host/dbname?sslmode=require`)
   - `FONNTE_TOKEN`: Token API Fonnte untuk notifikasi WhatsApp
   - `ADMIN_WHATSAPP`: Nomor WhatsApp Admin (format: `628xxxxxxxx`)
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Email Service Account dari Google Cloud Console
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: Private Key Service Account (dibungkus tanda kutip ganda `"..."`)

### 3. Jalankan Aplikasi

- **Mode Standar / Produksi**:
  ```bash
  npm start
  ```

- **Mode Pengembang (dengan auto-reload Nodemon)**:
  ```bash
  npm run dev
  ```

Saat dijalankan pertama kali, aplikasi akan otomatis membuat tabel-tabel yang diperlukan di database.

### 4. Akses Halaman Web

Setelah server berjalan di `http://localhost:3000`:
- 🔐 **Admin Login**: `http://localhost:3000/` atau `http://localhost:3000/admin/login.html`
- 📅 **Halaman Booking Publik**: `http://localhost:3000/booking`
- 📊 **Dashboard Admin**: `http://localhost:3000/admin/dashboard.html`

