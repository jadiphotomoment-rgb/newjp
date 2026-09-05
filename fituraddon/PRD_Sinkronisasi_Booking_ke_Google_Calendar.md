# Product Requirements Document (PRD)
## Sinkronisasi Jadwal Booking ke Google Calendar (Trigger Manual via Tombol)

| Field | Detail |
|---|---|
| Versi Dokumen | 1.0 |
| Tanggal | 5 September 2026 |
| Status | Draft |
| Pemilik Produk | (isi nama) |
| Tim Terkait | Backend, Frontend, QA, DevOps |

---

## 1. Latar Belakang & Masalah

Saat ini jadwal booking (misal: reservasi meja, appointment, jadwal konsultasi, dsb) tersimpan di sistem internal, namun pengguna (staff/customer/admin) harus mencatat ulang secara manual ke Google Calendar mereka. Hal ini menyebabkan:

- Duplikasi kerja dan human error (jadwal terlewat, salah tanggal).
- Tidak ada pengingat otomatis dari Google Calendar untuk booking yang dibuat di sistem internal.
- Sulit melihat jadwal booking bersamaan dengan jadwal pribadi/kerja lain.

## 2. Tujuan (Goals)

1. Memungkinkan pengguna menyinkronkan satu atau beberapa jadwal booking ke Google Calendar mereka hanya dengan menekan sebuah tombol ("Sync to Google Calendar").
2. Menghindari duplikasi event jika booking yang sama disinkron ulang.
3. Memberikan status sinkronisasi yang jelas (berhasil/gagal/belum disinkron) pada setiap booking.
4. Mendukung update dan pembatalan booking agar tercermin di Google Calendar (opsional/fase 2).

### Non-Goals (Di luar cakupan versi ini)
- Sinkronisasi otomatis dua arah (real-time, tanpa trigger tombol) — ini murni trigger manual berbasis tombol.
- Sinkronisasi ke kalender selain Google Calendar (Outlook, Apple Calendar, dll).
- Sinkronisasi massal terjadwal (cron job) — bisa jadi pertimbangan fase berikutnya.

## 3. User Stories

| ID | Sebagai | Saya ingin | Agar |
|---|---|---|---|
| US-1 | Pengguna (staff/customer) | Menekan tombol "Sync to Calendar" pada detail booking | Jadwal otomatis masuk ke Google Calendar saya |
| US-2 | Pengguna | Menghubungkan akun Google saya sekali di awal | Tidak perlu login ulang setiap sinkronisasi |
| US-3 | Pengguna | Melihat status sinkronisasi (Synced/Not Synced/Failed) | Tahu booking mana yang sudah masuk kalender |
| US-4 | Pengguna | Melakukan sinkronisasi ulang jika booking diubah | Data di Google Calendar tetap akurat |
| US-5 | Admin | Melihat log kegagalan sinkronisasi | Bisa menindaklanjuti masalah teknis |
| US-6 | Pengguna | Memutuskan koneksi akun Google kapan saja | Mengontrol privasi data kalender saya |

## 4. Alur Pengguna (User Flow)

1. Pengguna login ke sistem booking.
2. Jika belum pernah menghubungkan Google Calendar → sistem menampilkan tombol "Connect Google Calendar" → OAuth consent screen Google → izin diberikan → token disimpan.
3. Pengguna membuka detail booking → menekan tombol **"Sync to Google Calendar"**.
4. Sistem memvalidasi data booking → memanggil Google Calendar API → membuat/memperbarui event.
5. Sistem menampilkan notifikasi hasil (toast: berhasil/gagal) dan mengubah status booking menjadi `synced`.
6. (Opsional Fase 2) Jika booking diedit setelah sinkron, tombol berubah menjadi "Update Calendar Event" atau muncul badge "Perlu sinkron ulang".

## 5. Functional Requirements

### 5.1 Autentikasi & Otorisasi Google
- FR-1: Sistem menggunakan **OAuth 2.0** (Authorization Code flow) untuk menghubungkan akun Google pengguna.
- FR-2: Scope minimal yang diminta: `https://www.googleapis.com/auth/calendar.events` (bukan full calendar access, demi least privilege).
- FR-3: Access token & refresh token disimpan terenkripsi di database (tidak pernah di localStorage/frontend).
- FR-4: Sistem otomatis melakukan refresh token saat access token kedaluwarsa.
- FR-5: Pengguna dapat memutuskan koneksi (revoke) kapan saja dari halaman pengaturan.

### 5.2 Tombol Sinkronisasi (Trigger)
- FR-6: Tombol "Sync to Google Calendar" muncul di halaman detail booking dan/atau list booking (bulk action opsional).
- FR-7: Tombol dinonaktifkan (disabled) dengan tooltip jika pengguna belum menghubungkan akun Google.
- FR-8: Saat ditekan, tombol menampilkan loading state selama proses berlangsung.
- FR-9: Setelah proses selesai, tampilkan feedback jelas: sukses (dengan link ke event di Google Calendar), atau gagal (dengan pesan error yang dapat ditindaklanjuti).

### 5.3 Pembuatan Event di Google Calendar
- FR-10: Event yang dibuat memuat minimal: judul (nama booking/layanan), waktu mulai & selesai, lokasi (jika ada), deskripsi (catatan booking), dan reminder default (misal 30 menit sebelum).
- FR-11: Sistem menyimpan `google_event_id` yang dikembalikan API pada record booking, untuk mencegah duplikasi saat sinkron ulang.
- FR-12: Jika booking sudah punya `google_event_id`, aksi tombol berikutnya menjadi **update** event (PATCH), bukan membuat event baru.
- FR-13: Jika booking dibatalkan/dihapus di sistem internal, sediakan opsi untuk menghapus event terkait di Google Calendar (bisa manual trigger atau otomatis, sesuai keputusan produk).

### 5.4 Manajemen Status & Log
- FR-14: Setiap booking memiliki field `calendar_sync_status`: `not_synced`, `synced`, `failed`, `pending`.
- FR-15: Sistem mencatat log setiap percobaan sinkronisasi (timestamp, hasil, pesan error jika ada) untuk keperluan audit dan debugging.
- FR-16: Admin memiliki dashboard/log viewer untuk memonitor kegagalan sinkronisasi lintas pengguna.

### 5.5 Penanganan Error
- FR-17: Jika token Google kedaluwarsa/dicabut, sistem menampilkan pesan agar pengguna menghubungkan ulang akunnya.
- FR-18: Jika API Google Calendar rate-limited atau down, sistem melakukan retry dengan exponential backoff (maks. 3x) sebelum menandai status `failed`.
- FR-19: Semua error dari Google API diterjemahkan ke pesan yang mudah dipahami pengguna (bukan raw error JSON).

## 6. Non-Functional Requirements

| Kategori | Requirement |
|---|---|
| Keamanan | Token OAuth dienkripsi at-rest (AES-256), transmisi via HTTPS/TLS 1.2+ |
| Performa | Proses sinkron satu booking selesai < 3 detik pada kondisi normal |
| Reliabilitas | Retry otomatis untuk kegagalan transient; idempotent (tidak membuat event duplikat) |
| Skalabilitas | Mendukung sinkronisasi bulk (mis. 50+ booking sekaligus) tanpa memblokir UI (proses async/queue) |
| Auditability | Semua aktivitas sinkron tercatat dengan jejak audit (audit trail) |
| Kepatuhan Privasi | Sesuai kebijakan Google API User Data Policy & (jika relevan) UU PDP |

## 7. Desain Teknis (Ringkasan Arsitektur)

**Komponen:**
- **Frontend**: Tombol trigger, status badge, halaman koneksi akun Google.
- **Backend API**: Endpoint untuk OAuth callback, endpoint sync, service layer untuk komunikasi dengan Google Calendar API.
- **Queue/Worker (opsional untuk bulk)**: Memproses banyak booking secara asynchronous agar tidak memblokir request HTTP.
- **Database**: Tabel booking (+ kolom `google_event_id`, `calendar_sync_status`), tabel `google_oauth_tokens` per pengguna, tabel `sync_logs`.

**Contoh Endpoint API:**

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/auth/google/connect` | Memulai OAuth flow |
| GET | `/auth/google/callback` | Callback OAuth, menyimpan token |
| DELETE | `/auth/google/disconnect` | Mencabut koneksi akun Google |
| POST | `/bookings/{id}/sync-calendar` | Trigger sinkronisasi satu booking (dipanggil saat tombol ditekan) |
| POST | `/bookings/bulk-sync-calendar` | (Opsional) Sinkron banyak booking sekaligus |
| GET | `/bookings/{id}/sync-status` | Cek status sinkronisasi terbaru |

**Contoh skema tabel tambahan:**

```sql
ALTER TABLE bookings ADD COLUMN google_event_id VARCHAR(255) NULL;
ALTER TABLE bookings ADD COLUMN calendar_sync_status VARCHAR(20) DEFAULT 'not_synced';

CREATE TABLE google_oauth_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  access_token TEXT NOT NULL,   -- terenkripsi
  refresh_token TEXT NOT NULL,  -- terenkripsi
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE sync_logs (
  id UUID PRIMARY KEY,
  booking_id UUID NOT NULL,
  status VARCHAR(20),
  message TEXT,
  created_at TIMESTAMP DEFAULT now()
);
```

## 8. Edge Cases yang Perlu Ditangani

- Pengguna menekan tombol sync berkali-kali dengan cepat (double-click) → harus idempotent, tidak membuat event ganda.
- Booking diubah setelah disinkron → perlu mekanisme deteksi "out of sync" dan tombol update.
- Akun Google pengguna dicabut aksesnya dari sisi Google (revoke eksternal) → sistem harus mendeteksi error 401 dan meminta re-auth.
- Zona waktu booking berbeda dengan zona waktu akun Google pengguna → pastikan konversi timezone benar (gunakan format RFC3339 dengan timezone eksplisit).
- Booking dihapus di sistem internal setelah tersinkron → tentukan apakah event di Google Calendar ikut terhapus otomatis atau tidak.

## 9. Metrik Keberhasilan (Success Metrics)

- % booking yang berhasil disinkron dari total percobaan sinkron (target awal: >95%).
- Rata-rata waktu proses sinkronisasi per booking.
- Jumlah pengguna yang menghubungkan akun Google Calendar dalam 30 hari pertama peluncuran.
- Penurunan komplain terkait "jadwal terlewat" setelah fitur diluncurkan.

## 10. Rencana Rilis (Milestone Usulan)

| Fase | Cakupan | Estimasi |
|---|---|---|
| Fase 1 (MVP) | OAuth connect, tombol sync manual per booking, create event, status sync | 2–3 minggu |
| Fase 2 | Update event saat booking diedit, hapus event saat booking dibatalkan | 1–2 minggu |
| Fase 3 | Bulk sync, dashboard log admin, notifikasi kegagalan | 1–2 minggu |

## 11. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Google API quota terlampaui | Implementasi caching, batching, dan monitoring quota |
| Token bocor/keamanan | Enkripsi token, akses terbatas (least privilege scope) |
| Ketergantungan pada layanan pihak ketiga (Google down) | Retry + fallback status `pending`, notifikasi ke pengguna |

## 12. Pertanyaan Terbuka (Open Questions)

1. Apakah penghapusan booking harus otomatis menghapus event Google Calendar, atau perlu konfirmasi manual?
2. Apakah sinkronisasi ini per-pengguna (masing-masing menghubungkan akun sendiri) atau ada juga mode "sync ke calendar bersama/resource calendar"?
3. Apakah dibutuhkan dukungan multi-akun Google per pengguna?

---

*Dokumen ini adalah draft awal dan dapat disesuaikan berdasarkan diskusi dengan stakeholder terkait.*
