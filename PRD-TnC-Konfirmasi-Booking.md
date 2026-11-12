# PRD: Fitur Terms and Conditions (T&C) Konfirmasi Booking

**Versi:** 1.0  
**Tanggal:** 12 November 2026  
**Status:** Ready for Implementation (Fase 1 MVP)  

---

## 1. Latar Belakang & Masalah

Saat ini, proses booking studio foto melalui form publik (`/booking.html`) belum memiliki mekanisme persetujuan Syarat & Ketentuan (Terms & Conditions / T&C) yang mengikat secara digital. 
Hal ini menimbulkan potensi perselisihan operasional antara studio dan klien, khususnya terkait:
- Keterlambatan kedatangan klien pada sesi foto.
- Kebijakan uang muka (Down Payment / DP) yang hangus saat pembatalan sepihak.
- Batas waktu dan aturan penjadwalan ulang (*reschedule*).
- Batas waktu pelunasan serta penyerahan file foto mentah (*raw*) dan hasil edit.

Tanpa bukti pencatatan persetujuan (*audit trail*) yang sah, studio tidak memiliki dasar perlindungan operasional yang kuat jika terjadi sengketa.

---

## 2. Tujuan Produk

1. **Perlindungan Hukum & Operasional**: Memastikan setiap pemesan memahami dan menyetujui T&C sebelum form booking dapat dikirimkan.
2. **Rekam Jejak Persetujuan (Audit Trail Append-Only)**: Mencatat snapshot isi T&C yang disetujui, stempel waktu server, nama klien, nomor WhatsApp, alamat IP, dan user-agent klien.
3. **Fleksibilitas Manajemen (Versioning)**: Memungkinkan Owner memperbarui butir T&C tanpa merusak validitas atau mengubah catatan persetujuan pada booking masa lalu (*immutable snapshot*).

---

## 3. Sasaran Pengguna & Hak Akses

1. **Klien / Calon Pengantin / Pelanggan (Publik)**:
   - Membaca ringkasan poin T&C di form booking.
   - Wajib mencentang persetujuan sebelum tombol submit aktif.
   - Mengakses salinan bukti persetujuan T&C melalui link publik ber-token acak.
2. **Owner**:
   - Hak penuh mengelola draft dan menerbitkan (*publish*) versi T&C baru.
   - Melihat riwayat versi T&C yang pernah aktif.
3. **Admin / Staff**:
   - Melihat status dan snapshot T&C yang disetujui klien pada detail booking.
   - Tidak memiliki izin untuk mengedit atau mempublikasikan versi T&C baru (akses menu ditolak dengan status 403).

---

## 4. Ruang Lingkup & Pembagian Fase

### Fase 1: MVP (Fokus Eksekusi Saat Ini)
- **T&C Umum Studio**: 1 set T&C aktif yang berlaku untuk seluruh kategori booking.
- **Sistem Versioning**: Manajemen draft dan publish versi baru oleh Owner.
- **Form Booking Publik**: Scrollable box T&C, link modal "Baca selengkapnya", checkbox wajib persetujuan.
- **Pencatatan Bukti Persetujuan (Atomic Transaction)**: Simpan booking + log persetujuan dalam 1 database transaction.
- **Admin Detail Booking**: Menampilkan informasi persetujuan T&C dan tombol lihat salinan isi persetujuan.

### Fase 2: Fitur Lanjutan (Setelah Fase 1 Lolos Uji)
- T&C spesifik per kategori booking (Wedding, Studio Personal, Maternity, dsb).
- Penyertaan tautan bukti T&C ke dalam pesan konfirmasi WhatsApp (via Fonnte).
- Fitur cetak bukti / download PDF persetujuan T&C.
- Filter pencarian booking di admin berdasarkan versi T&C.

### Fase 3: Integrasi & Analitik
- Dashboard analitik penerimaan T&C, notifikasi berkala, dan penyesuaian multi-bahasa.

---

## 5. Alur & Logika Bisnis (Fase 1)

### 5.1 Alur Publik (Booking Client)
1. Klien membuka halaman booking (`/booking.html`).
2. Klien memilih kategori, tanggal, sesi jam, dan mengisi identitas.
3. Form memuat versi T&C yang sedang aktif dari API `GET /api/terms/active`.
4. Kotak T&C ditampilkan sebelum tombol submit:
   - Berisi daftar butir aturan yang dapat di-scroll.
   - Terdapat tombol/tautan "Baca selengkapnya" untuk membuka modal teks lengkap.
   - Terdapat checkbox wajib: *"Saya telah membaca, memahami, dan menyetujui seluruh Syarat & Ketentuan yang berlaku"*.
5. Tombol Submit dinonaktifkan (`disabled`) sampai checkbox dicentang.
6. Saat submit:
   - Request mengirimkan `terms_version_id` dan `terms_accepted: true`.
   - Backend memverifikasi bahwa versi yang dikirim adalah versi yang valid dan aktif.
   - Dalam satu transaksi database atomic:
     a. Data booking disimpan ke tabel `bookings`.
     b. Bukti persetujuan di-insert ke tabel `terms_acceptances` lengkap dengan snapshot teks, timestamp server, IP klien, user-agent, dan token verifikasi acak (*UUID/nano-id*).
     c. Kolom `bookings.terms_accepted_at` diperbarui dengan timestamp saat itu.

### 5.2 Alur Owner (Manajemen T&C)
1. Owner membuka menu **"Term & Condition"** di dashboard admin (`/admin/terms.html` atau panel di admin).
2. Owner dapat melihat versi yang sedang aktif dan riwayat versi sebelumnya.
3. Owner dapat mengedit draf butir T&C:
   - Menambah butir baru, mengubah urutan (*reorder*), menghapus butir.
   - Tombol "Simpan Draf" untuk menyimpan perubahan tanpa menerapkannya ke publik.
   - Tombol "Pratinjau" untuk melihat tampilan di mata klien.
   - Tombol "Publish Versi Baru":
     - Memvalidasi isi tidak boleh kosong.
     - Memvalidasi isi tidak boleh persis sama dengan versi aktif saat ini.
     - Mengarsipkan versi aktif lama (`archived`) dan mengaktifkan versi baru (`active`) dalam 1 database transaction.
     - Menghapus (*invalidation*) cache in-memory versi aktif di server.

---

## 6. Skema Database & Model Data (Bagian 6)

### 6.1 Tabel `terms_versions`
Menyimpan riwayat draf dan versi T&C yang dipublikasikan.

```sql
CREATE TABLE IF NOT EXISTS terms_versions (
  id              SERIAL PRIMARY KEY,
  version_number  INT NOT NULL,
  title           VARCHAR(255) NOT NULL DEFAULT 'Syarat & Ketentuan Umum Layanan Studio',
  content_points  JSONB NOT NULL DEFAULT '[]', -- Array of strings/objects [{id, text, order}]
  status          VARCHAR(20) NOT NULL DEFAULT 'draft', -- 'draft', 'active', 'archived'
  created_by      INT REFERENCES admins(id) ON DELETE SET NULL,
  published_at    TIMESTAMP NULL,
  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP DEFAULT now()
);

-- Index versi aktif unik parsial (hanya 1 versi aktif pada satu waktu)
CREATE UNIQUE INDEX IF NOT EXISTS ux_terms_versions_active 
  ON terms_versions (status) 
  WHERE status = 'active';
```

### 6.2 Tabel `terms_acceptances` (Append-Only)
Menyimpan bukti audit trail persetujuan klien yang bersifat *immutable* (tidak boleh ada API update/delete).

```sql
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id                  SERIAL PRIMARY KEY,
  booking_id          INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  terms_version_id    INT NOT NULL REFERENCES terms_versions(id),
  snapshot_text       TEXT NOT NULL, -- Gabungan snapshot butir T&C pada saat disetujui
  verification_token  VARCHAR(64) UNIQUE NOT NULL, -- Token acak tak tertebak untuk akses publik
  client_name         VARCHAR(150) NOT NULL,
  client_phone        VARCHAR(30) NOT NULL,
  ip_address          VARCHAR(50) NULL,
  user_agent          TEXT NULL,
  accepted_at         TIMESTAMP NOT NULL DEFAULT now(),
  created_at          TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_terms_acceptances_booking_id 
  ON terms_acceptances (booking_id);

CREATE INDEX IF NOT EXISTS ix_terms_acceptances_token 
  ON terms_acceptances (verification_token);
```

### 6.3 Ekstensi Kolom pada Tabel `bookings`
```sql
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP NULL;
```

---

## 7. Spesifikasi API & Validasi Server (Bagian 7)

### 7.1 Endpoint Publik
1. **`GET /api/terms/active`**
   - **Tujuan**: Mengambil versi T&C aktif untuk ditampilkan di form booking.
   - **Cache**: In-memory cache 5 menit (dibersihkan otomatis saat ada publikasi baru).
   - **Respons**:
     ```json
     {
       "id": 1,
       "version_number": 1,
       "title": "Syarat & Ketentuan Umum Layanan Studio",
       "points": [
         "Klien wajib hadir tepat waktu sesuai jadwal sesi yang telah disepakati...",
         "Pembayaran DP tidak dapat dikembalikan (non-refundable)..."
       ],
       "published_at": "2026-11-12T10:00:00Z"
     }
     ```

2. **`GET /api/terms/verify/:token`**
   - **Tujuan**: Halaman publik baca-saja (*read-only*) untuk memeriksa keabsahan bukti persetujuan T&C klien menggunakan token tak tertebak.
   - **Respons**:
     ```json
     {
       "valid": true,
       "client_name": "Rizky & Anisa",
       "booking_id": 104,
       "accepted_at": "2026-11-12T11:20:00Z",
       "version_number": 1,
       "snapshot_text": "1. Klien wajib hadir...\n2. Pembayaran DP..."
     }
     ```

3. **`POST /api/bookings/:categorySlug`** (Modifikasi)
   - **Payload Tambahan**:
     ```json
     {
       "terms_version_id": 1,
       "terms_accepted": true
     }
     ```
   - **Validasi**:
     - Jika `terms_accepted` bukan `true` atau `terms_version_id` tidak ada / tidak cocok dengan versi aktif, kembalikan `400 Bad Request` (`error: 'Anda wajib menyetujui Syarat & Ketentuan yang berlaku'`).
   - **Transaksi**:
     - Insert booking -> Insert `terms_acceptances` -> Set `terms_accepted_at` dalam satu `BEGIN ... COMMIT`. Rollback total jika salah satu gagal.

### 7.2 Endpoint Khusus Owner (`authenticate` + `requireRole('owner')`)
1. **`GET /api/admin/terms`**: Mengambil daftar seluruh versi (aktif, draf, arsip).
2. **`GET /api/admin/terms/:id`**: Mengambil detail satu versi T&C.
3. **`PUT /api/admin/terms/draft`**: Menyimpan atau memperbarui draf T&C.
4. **`POST /api/admin/terms/publish`**:
   - Memvalidasi butir T&C tidak kosong.
   - Memvalidasi isi tidak sama persis dengan versi aktif saat ini.
   - Dalam transaksi DB: ubah status versi aktif lama menjadi `archived`, jadikan versi baru `active`, naikkan `version_number`.
   - Bersihkan in-memory cache server.
5. **`GET /api/admin/bookings/:id/terms`**:
   - Mengambil data persetujuan T&C untuk detail booking admin (bisa diakses oleh staff/admin dengan permission `booking.view`).

---

## 8. Antarmuka Pengguna (UI/UX)

1. **Form Booking Klien (`/booking.html`)**:
   - Tepat di atas tombol submit `#btn-submit`, tambahkan container card T&C.
   - Kotak scrollable (tinggi maks ~160px) dengan list poin T&C bernomor.
   - Tombol "Baca Selengkapnya" membuka modal popup teks penuh T&C.
   - Checkbox persetujuan dengan teks jelas.
   - Submit terkunci (`disabled`) hingga checkbox tercentang.
2. **Dashboard Owner (`/admin/terms.html` / Navigasi Admin)**:
   - Akses dibatasi hanya untuk role `owner` (role `staff`/`admin` dialihkan ke `/403.html`).
   - Antarmuka manajemen butir: Tambah butir, edit inline, hapus, drag/panah reorder.
   - Tombol "Simpan Draf" & "Publish Versi Baru".
   - Riwayat versi tabel log di bawah editor.
3. **Detail Booking Admin (`/admin/bookings.html` modal/panel)**:
   - Blok "Persetujuan T&C":
     - Jika ada catatan: menampilkan Versi, Waktu Disetujui, IP Klien, dan tautan/tombol modal untuk melihat teks snapshot yang disetujui.
     - Jika booking lama tanpa persetujuan: menampilkan badge *"Belum ada catatan T&C (booking sebelum sistem T&C aktif)"*.

---

## 9. Ketentuan Teknis & Poin Contoh FR9 (Bagian 9)

### 4 Butir Contoh T&C Umum (Seed Data Awal - FR9)
1. **Kehadiran & Ketepatan Waktu**: Klien wajib hadir di lokasi studio minimal 15 menit sebelum sesi foto dimulai. Keterlambatan kedatangan oleh klien akan mengurangi durasi waktu sesi tanpa kompensasi penambahan waktu.
2. **Ketentuan Uang Muka (DP)**: Pembayaran Uang Muka (DP) bersifat mengikat slot jadwal dan tidak dapat dikembalikan (*non-refundable*) apabila terjadi pembatalan sepihak oleh pihak klien.
3. **Penjadwalan Ulang (Reschedule)**: Permohonan jadwal ulang (*reschedule*) hanya diperbolehkan maksimal H-3 sebelum tanggal sesi foto dan wajib menyesuaikan ketersediaan slot kosong studio.
4. **Hak Cipta & Penyerahan Berkas**: Studio berhak menggunakan sebagian hasil foto untuk keperluan portofolio/media sosial kecuali dinyatakan lain secara tertulis; berkas foto mentah (*raw*) dan hasil edit akan diserahkan setelah seluruh biaya pelunasan diselesaikan.

### Ketentuan Keamanan & Operasional
- Semua query SQL wajib berparameter (`$1`, `$2`), dilarang konkatenasi string SQL mentah.
- File migrasi harus bersifat idempotent (`IF NOT EXISTS`, safe indexes).
- IP klien diambil dari header `x-forwarded-for` (elemen pertama) dengan fallback ke `req.socket.remoteAddress`.
- Seluruh teks yang dirender di frontend harus melalui fungsi escaping HTML (`esc()`) untuk mencegah celah XSS.
