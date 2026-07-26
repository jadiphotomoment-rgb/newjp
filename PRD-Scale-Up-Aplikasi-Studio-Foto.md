# PRD — Scale Up Aplikasi Perantara Sortir Foto Klien
## Menjadi Sistem Manajemen Studio Foto (Booking, Kalender, Keuangan, Pembayaran)

**Versi:** 1.0
**Tanggal:** 19 Juli 2026
**Status:** Draft

---

## 1. Latar Belakang

Aplikasi eksisting adalah **"Aplikasi Perantara Sortir Foto Klien"**, berbasis web dengan stack Node.js (Express), PostgreSQL, dan Fonnte API untuk notifikasi WhatsApp. Fungsinya saat ini terbatas pada proses sortir foto: admin membuat sesi, klien memilih foto dari Google Drive, lalu status pekerjaan dilacak sampai selesai.

Untuk mendukung operasional studio secara lebih menyeluruh, aplikasi perlu diperluas menjadi sistem yang juga menangani **booking klien, kalender jadwal, pencatatan keuangan, approval pembayaran (dengan bukti transfer tersimpan di Google Drive), dan notifikasi otomatis** — seluruhnya terintegrasi dengan alur sortir foto yang sudah ada.

---

## 2. Tujuan

1. Klien dapat melakukan booking sesi foto secara mandiri melalui form online, sesuai kategori layanan.
2. Studio dapat mengelola jadwal (kalender) tanpa bentrok, hanya mengunci tanggal setelah DP dikonfirmasi.
3. Admin memiliki dashboard keuangan yang mencatat seluruh transaksi pembayaran klien.
4. Proses approval pembayaran (termasuk verifikasi bukti transfer) dilakukan terpusat di dashboard admin.
5. Notifikasi WhatsApp otomatis terkirim di setiap titik penting alur (booking masuk, DP masuk, pembayaran dikonfirmasi).
6. Form booking dapat dikustomisasi oleh admin per kategori layanan, tanpa perlu mengubah kode.

---

## 3. Ruang Lingkup Fitur

### 3.1 Modul Booking & Kalender
### 3.2 Modul Kategori & Form Booking Custom (Graduation, Wedding, Event, Corporation)
### 3.3 Modul Pencatatan Keuangan
### 3.4 Modul Pembayaran: Upload Bukti TF ke Google Drive, Approval, Notifikasi Otomatis
### 3.5 Integrasi dengan Modul Sortir Foto (eksisting)

---

## 4. Kategori Layanan Booking

Sistem menyediakan 4 kategori sebagai template bawaan, yang field-nya dapat dikustomisasi admin melalui form-builder:

| Kategori | Slug | Contoh Field Khas | DP Default |
|---|---|---|---|
| **Graduation** | `graduation` | Nama sekolah/kampus, jurusan, jumlah orang dalam frame, lokasi wisuda | 20% |
| **Wedding** | `wedding` | Nama pasangan, venue, jumlah sesi (akad/resepsi), tema/dresscode | 30% |
| **Event** | `event` | Nama acara, jenis event (ultah/gathering/dll), estimasi tamu, durasi | 25% |
| **Corporation** | `corporation` | Nama perusahaan, PIC, jenis dokumentasi, invoice/NPWP | 50% atau nominal tetap |

Setiap kategori memiliki:
- Schema field custom (dinamis, JSON-based).
- Aturan DP sendiri (persentase dari total harga paket, atau nominal tetap).
- Warna identitas berbeda saat ditampilkan di kalender admin.

**Aturan wajib:** Booking tidak dianggap terkonfirmasi (dan tidak mengunci tanggal di kalender) sampai bukti pembayaran DP diverifikasi dan disetujui oleh admin.

---

## 5. Alur Sistem (End-to-End)

```
1. Client membuka halaman booking → memilih kategori
   (Graduation / Wedding / Event / Corporation)
   → Form dinamis muncul sesuai schema field kategori tsb.

2. Client mengisi tanggal, lokasi, detail acara → submit
   → Sistem menghitung nominal DP otomatis
     (berdasarkan dp_type & dp_value kategori, atau package_price bila sudah diset admin)
   → Status booking: pending_dp
   → Client diarahkan ke halaman "Upload Bukti DP" beserta info nominal yang harus dibayar

3. Client mengunggah bukti transfer (gambar/PDF)
   → File disimpan otomatis ke folder Google Drive khusus (per booking)
   → Status booking: dp_review
   → Notifikasi WhatsApp terkirim ke ADMIN
     ("Booking baru [kategori] dari [nama], DP masuk, cek dashboard")

4. Admin membuka dashboard, memeriksa bukti transfer, klik Approve/Reject
   → Jika Approve:
     - Status booking: confirmed
     - Tanggal terkunci resmi di kalender (cek bentrok otomatis)
     - Notifikasi WhatsApp terkirim ke CLIENT
       ("Booking [tanggal] [kategori] telah dikonfirmasi, DP diterima")
   → Jika Reject:
     - Notifikasi WhatsApp ke CLIENT meminta verifikasi ulang bukti transfer

5. (Opsional, pasca-acara) Admin membuat Sesi Sortir Foto seperti alur lama,
   terhubung ke booking_id yang sama, sehingga riwayat klien menyatu
   dari booking → pembayaran → sortir foto → status editing → selesai.
```

---

## 6. Skema Status

### Status Booking
| Status | Keterangan |
|---|---|
| `pending_dp` | Booking baru masuk, menunggu client upload bukti DP |
| `dp_review` | Bukti DP sudah diupload, menunggu approval admin |
| `confirmed` | DP disetujui, tanggal terkunci di kalender |
| `completed` | Sesi/acara telah selesai dilaksanakan |
| `cancelled` | Dibatalkan (manual oleh admin, atau otomatis jika DP tidak masuk sebelum deadline) |

### Status Pembayaran (`payments`)
| Status | Keterangan |
|---|---|
| `pending` | Menunggu review admin |
| `approved` | Disetujui admin |
| `rejected` | Ditolak, client perlu upload ulang |

### Status Sortir Foto (eksisting, tetap dipertahankan)
- Sortir: `active`, `completed`
- Editing: `received`, `editing`, `done`

---

## 7. Skema Database (Tambahan)

```sql
-- Kategori booking sebagai template form
CREATE TABLE booking_categories (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(30) UNIQUE,              -- 'graduation','wedding','event','corporation'
  name VARCHAR(100),
  fields JSONB,                         -- schema field custom kategori ini
  dp_type VARCHAR(10) DEFAULT 'percent',-- 'percent' atau 'fixed'
  dp_value NUMERIC(12,2),               -- misal 30 (%) atau 500000 (rupiah)
  color VARCHAR(10),                    -- kode warna untuk tampilan kalender
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);

-- Data booking dari client
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  category_id INT REFERENCES booking_categories(id),
  client_name VARCHAR(150),
  client_phone VARCHAR(30),
  event_date DATE,
  event_time TIME,
  location TEXT,
  form_data JSONB,                      -- jawaban client sesuai field custom kategori
  package_price NUMERIC(12,2),          -- total harga paket
  dp_amount NUMERIC(12,2),              -- nominal DP yang wajib dibayar
  dp_deadline TIMESTAMP NULL,           -- batas waktu bayar DP (opsional, untuk auto-cancel)
  status VARCHAR(20) DEFAULT 'pending_dp',
  session_id INT REFERENCES sessions(id) NULL, -- relasi ke sesi sortir foto setelah acara selesai
  created_at TIMESTAMP DEFAULT now()
);

-- Pencatatan pembayaran & bukti transfer
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  booking_id INT REFERENCES bookings(id),
  amount NUMERIC(12,2),
  payment_type VARCHAR(20),             -- DP, pelunasan, full
  proof_url TEXT,                       -- link Google Drive bukti TF
  status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
  approved_by INT REFERENCES admins(id) NULL,
  approved_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT now()
);
```

---

## 8. Kebutuhan Fungsional per Modul

### 8.1 Booking & Kalender
- Admin dapat melihat seluruh booking dalam tampilan kalender bulanan (rekomendasi: FullCalendar.js), dengan warna berbeda per kategori.
- Booking hanya tampil sebagai "terjadwal tetap" di kalender setelah status `confirmed`.
- Admin dapat memfilter kalender berdasarkan kategori dan status.
- Sistem mencegah dua booking `confirmed` pada tanggal & jam yang sama (validasi bentrok).
- (Opsional) Auto-cancel booking yang melewati `dp_deadline` tanpa pembayaran, dijalankan via cron job harian.

### 8.2 Kategori & Form Custom
- Admin dapat mengelola 4 kategori bawaan (Graduation, Wedding, Event, Corporation) melalui satu form-builder UI.
- Form-builder mendukung tipe field: text, number, select (dengan opsi custom), date, textarea.
- Admin dapat mengatur `dp_type` (persen/nominal tetap) dan `dp_value` per kategori.
- Perubahan schema field tidak memerlukan deployment ulang kode (disimpan sebagai JSON di database).

### 8.3 Pencatatan Keuangan
- Dashboard keuangan menampilkan total pemasukan (SUM `amount` WHERE `status='approved'`).
- Breakdown laporan per kategori (Graduation vs Wedding vs Event vs Corporation).
- Breakdown laporan per periode (bulanan).
- Daftar pembayaran berstatus `pending` ditampilkan sebagai antrian yang perlu ditindaklanjuti admin.

### 8.4 Pembayaran & Bukti Transfer
- Client dapat mengunggah file bukti transfer (gambar/PDF) melalui halaman publik, tanpa perlu login.
- File otomatis diunggah ke folder Google Drive khusus per booking (struktur: `Bukti_Pembayaran/{booking_id}/`).
- Link hasil upload (`webViewLink`) disimpan di kolom `proof_url`.
- Admin dapat melihat pratinjau bukti transfer langsung dari dashboard sebelum approve/reject.
- Approval mengubah status `payments` dan, jika ini pembayaran DP, turut mengubah status `bookings` menjadi `confirmed`.

### 8.5 Notifikasi Otomatis (Fonnte/WhatsApp)
| Trigger | Penerima | Isi Pesan (ringkas) |
|---|---|---|
| Bukti DP diupload client | Admin | Booking baru masuk, perlu direview |
| DP di-approve admin | Client | Booking terkonfirmasi, tanggal terkunci |
| DP di-reject admin | Client | Perlu upload ulang bukti transfer |
| Sortir foto selesai (eksisting) | Admin | Klien telah menyelesaikan sortir foto |

---

## 9. Kebutuhan Non-Fungsional

- **Keamanan akses Google Drive**: scope untuk *membaca* folder foto klien (eksisting) harus dipisahkan dari scope untuk *menulis* (upload bukti transfer). Disarankan menggunakan service account/OAuth client terpisah agar tidak perlu re-otorisasi sistem yang sudah berjalan.
- **Validasi file upload**: batasi tipe file (jpg, png, pdf) dan ukuran maksimum untuk bukti transfer.
- **Konsistensi status**: perubahan status booking dan payment harus atomik (gunakan transaction database) agar tidak terjadi kondisi tidak sinkron, misalnya payment `approved` tapi booking masih `pending_dp`.
- **Audit trail**: kolom `approved_by` dan `approved_at` pada tabel `payments` untuk keperluan audit siapa yang menyetujui pembayaran.
- **Skalabilitas schema form**: penyimpanan `fields` sebagai JSONB memungkinkan penambahan kategori baru di masa depan tanpa migrasi skema database.

---

## 10. Daftar Endpoint API (Tambahan)

```
# Publik (client-facing)
GET   /api/booking-categories                     → daftar kategori aktif
GET   /api/booking-categories/:slug                → detail schema field & aturan DP
POST  /api/booking/:categorySlug                   → submit booking baru
POST  /api/booking/:id/upload-dp                   → upload bukti transfer DP

# Admin (butuh autentikasi JWT, mengikuti pola eksisting)
GET   /api/admin/bookings?category=&status=&month= → daftar/filter booking untuk kalender & tabel
PATCH /api/admin/bookings/:id/status                → ubah status booking manual
PATCH /api/admin/bookings/:id/approve-dp             → approve DP → trigger kalender + notifikasi
PATCH /api/admin/payments/:id/approve                → approve pembayaran (umum, termasuk pelunasan)
PATCH /api/admin/payments/:id/reject                 → reject pembayaran
GET   /api/admin/finance/summary?month=&category=    → ringkasan laporan keuangan
GET   /api/admin/booking-categories                  → kelola kategori & form-builder
PUT   /api/admin/booking-categories/:id              → update schema field & aturan DP kategori
```

---

## 11. Integrasi dengan Modul Eksisting

- Tabel `bookings` memiliki relasi opsional (`session_id`) ke tabel `sessions` yang sudah ada di modul sortir foto, sehingga riwayat satu klien dapat ditelusuri secara menyeluruh: **booking → pembayaran → sesi sortir foto → status editing**.
- Fungsi pengiriman WhatsApp (`sendWhatsApp()` di `routes/notify.js`) digunakan ulang (reuse) untuk seluruh notifikasi baru, tanpa perlu membuat integrasi Fonnte terpisah.
- Struktur folder Google Drive untuk bukti transfer dibuat terpisah dari folder foto raw klien, agar tidak tercampur dan mempermudah pengelolaan permission.

---

## 12. Hal yang Perlu Diputuskan Lebih Lanjut

- [ ] Apakah `package_price` diisi manual oleh admin per booking, atau disiapkan sebagai daftar paket tetap per kategori?
- [ ] Apakah dibutuhkan fitur pelunasan bertahap (DP → cicilan → pelunasan), atau cukup dua tahap (DP → pelunasan)?
- [ ] Apakah `dp_deadline` dan auto-cancel diperlukan di versi awal, atau bisa menyusul?
- [ ] Format laporan keuangan: cukup ringkasan di dashboard, atau perlu fitur ekspor (misal ke Excel/PDF)?

---

## 13. Prioritas Pengembangan (Usulan)

1. **Fase 1** — Modul Kategori & Form Booking Custom + tabel `booking_categories`, `bookings`.
2. **Fase 2** — Modul Pembayaran: upload bukti TF ke Google Drive + approval admin.
3. **Fase 3** — Notifikasi otomatis WhatsApp di setiap trigger.
4. **Fase 4** — Kalender admin (tampilan visual + validasi bentrok jadwal).
5. **Fase 5** — Dashboard keuangan & laporan.
6. **Fase 6** — Integrasi penuh booking → sesi sortir foto (relasi `session_id`).
