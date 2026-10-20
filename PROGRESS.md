# PROGRESS - Staff Approve Booking Langsung

## Status Fitur (Staff Approve Booking Langsung)
- [x] Fase 0: Pemetaan (MAP.md terverifikasi dari kode) - Selesai
- [x] Fase 1: Fondasi Permission & Migrasi (Peta role, CHECK rule, migrasi keuangan & outbox) - Selesai
- [ ] Fase 2: Service Approve/Reject (TDD, transaksi atomik, lock row, outbox WA) - Siap Mulai
- [ ] Fase 3: Endpoint & Monitoring Owner (POST /api/bookings/:id/approve & reject, daily summary)
- [ ] Fase 4: Frontend (UI button, dialog konfirmasi, anti double-submit, reload version)
- [ ] Fase 5: Review Keamanan & Rilis (Audit diff, panduan rilis, checklist)


---

# PROGRESS SEBELUMNYA - Akun Staff, RBAC & Approval Tracking


## Ringkasan Keputusan Inti (crm.md)
1. Peran: 2 role (`owner`, `staff`). RBAC via permission keys, bukan hardcode role.
2. Keuangan: Staff dilarang akses `/api/finance*`, `/api/settings/payment`, user mgmt, dan agregat uang dashboard (defense-in-depth: route guard, serializer, UI). Staff boleh lihat nominal per-booking untuk penagihan.
3. Auth: Argon2id/bcrypt (min 10 char), JWT access 15m (`sub`, `role`, `token_version`), refresh token di HttpOnly cookie (7 hari, rotasi, deteksi reuse), lockout setelah 5x gagal, `must_change_password` saat login pertama.
4. Audit Log: Append-only (DB trigger tolak UPDATE/DELETE), 1 transaksi bersama aksi domain, simpan diff field, redaksi WA & data sensitif.
5. Approval Engine: Aksi sensitif staff (override nominal tagihan, diskon, cancel/delete booking ber-DP) menghasilkan `approval_requests` pending. Owner menyetujui dalam 1 transaksi atomik dengan verifikasi optimistic concurrency (`base_version` vs `version`), deteksi stale, pencegahan self-approval (`decided_by <> requested_by`).
6. Feature Flag & Transisi: `RBAC_ENABLED` (default true di mode baru / fallback kompatibel), data lama dibackfill `created_by = owner_id`.
7. Keamanan & Performa: Parameterized query ($1), Keyset pagination, memory cache singkat untuk token_version & rules, no plaintext sensitive data.

## Status Fase
- [x] Fase 0: Pemetaan (MAP.md) - Selesai
- [x] Fase 1: Migrasi Database - Selesai
- [x] Fase 2: Autentikasi & Otorisasi - Selesai
- [x] Fase 3: Layanan Audit Log - Selesai
- [x] Fase 4: Approval Engine - Selesai
- [x] Fase 5: Terapkan ke Endpoint yang Ada - Selesai
- [x] Fase 6: Frontend Admin - Selesai
- [x] Fase 7: Test & Kinerja - Selesai
- [x] Fase 8: Review Keamanan & Rilis - Selesai

## Catatan Fase 8 (Final)
- File yang dibuat/disentuh:
  - `middleware/auth.js`: Penambahan dukungan runtime feature flag `RBAC_ENABLED` (default: `true`, jika diset `false` sistem beralih otomatis ke fallback kompatibel single-admin).
  - `package.json`: Ditambahkan skrip npm siap pakai: `npm test`, `npm run owner:create`, dan `npm run db:migrate`.
  - `PANDUAN-RILIS-RBAC.md`: Dokumen resmi panduan rilis, checklist verifikasi Definition of Done (100% lulus), instruksi migrasi idempotent, panduan rollback cepat via feature flag, dan SOP pemulihan darurat akun Owner.
- Hasil Uji & Keamanan:
  - `npm test` mengeksekusi seluruh suite test (Fase 2, 3, 4, 5, 7) dan lulus 100% tanpa error.
  - Skrip migrasi terverifikasi idempotent dan skrip CLI pembuat owner siap digunakan di lingkungan server.

## Catatan Fase 7
- File yang dibuat/disentuh:
  - `tests/phase7_performance_e2e.test.js`: Suite test otomasi komprehensif mencakup matriks permission lengkap, kebocoran data dashboard, benchmark latensi keyset pagination & monitoring, stress-test concurrency 10 write simultan, integritas trigger DB, dan alur regresi publik.
  - `routes/bookings.js`: Diperbaiki menjadi *Database-level Atomic Compare-and-Swap OCC* (`WHERE id = $10 AND ($11::int IS NULL OR version = $11)` dan validasi `rowCount === 0` -> 409 Conflict) untuk menjamin tepat 1 request berhasil saat race condition.
- Hasil Pengujian:
  - Matriks RBAC: 100% rute sensitif Owner (finance, payment settings, user management, monitoring) memblokir anonim (401) dan staf (403).
  - Kebocoran Keuangan: Serializer dashboard sukses memangkas seluruh field agregat omset (`total_revenue`, dll.) dari response staf.
  - Concurrency Test: 10 update simultan pada booking dengan versi yang sama menghasilkan tepat 1 berhasil (200) dan 9 ditolak (409 Conflict). Versi DB bertambah tepat 1.
  - Integritas DB: Trigger PostgreSQL Neon menolak manipulasi UPDATE/DELETE langsung pada tabel `audit_log`.
  - Full Regression Suite: Seluruh test suite dari Fase 2, 3, 4, 5, dan 7 lulus 100% (semua hijau).

## Catatan Fase 6
- File yang dibuat/disentuh:
  - `public/js/admin-nav.js`: Helper navigasi global, filter RBAC menu `[data-role="owner"]`, role badge pengguna, pending approval counter badge, global modal ganti password & logout.
  - `public/js/admin-login.js`: Penanganan alur `must_change_password` dengan modal ganti password wajib saat login staf perdana.
  - `public/admin/approvals.html`: Inbox Persetujuan untuk Owner (Setujui / Tolak dengan verifikasi diff payload) dan Staf (Batalkan permintaan sendiri).
  - `public/admin/users.html`: Manajemen Staff (Owner-only: Buat akun staf baru, Reset password, Cabut sesi/refresh token, Toggle aktif/nonaktif).
  - `public/admin/monitoring.html`: Monitoring Kinerja Staff (Owner-only: Metrik agregat aksi, status approval per-staf, breakdown aksi staf).
  - `public/admin/activity.html`: Riwayat Audit Log Lengkap (Owner-only: Filter aksi, entitas, tanggal, keyset pagination "Muat Lebih Banyak", viewer modal diff sebelum & sesudah).
  - Navigasi terintegrasi ke seluruh halaman admin existing (`dashboard.html`, `bookings.html`, `sessions.html`, `finance.html`, `categories.html`, `wa-templates.html`, `shortlinks.html`).
  - `public/admin/bookings.html`: Ditambahkan section interaktif "Riwayat Perubahan (Audit)" pada panel detail booking via `/api/bookings/:id/history`.
- Hasil uji: Seluruh script JS lulus pengecekan sintaks Node.js (`node -c`), seluruh file memuat `admin-nav.js`, dan regresi pengujian backend Fase 2-5 lulus 100%.

## Catatan Fase 5
- File yang dibuat/disentuh: `routes/users.js`, `routes/audit-log.js`, `routes/monitoring.js`, `routes/bookings.js`, `routes/finance.js`, `routes/payment-settings.js`, `routes/pelunasan.js`, `routes/dashboard.js`, `routes/categories.js`, `routes/wa-templates.js`, `routes/google.js`, `services/approval.js`, `services/audit.js`, `server.js`, `tests/phase5_rbac.test.js`.
- Penerapan RBAC & Route Guarding:
  - Guarding menyeluruh rute admin keuangan, settings payment, dan manajemen staff (403 untuk staff).
  - Serializer dashboard: otomatis menyembunyikan metrik omset (`total_revenue`, dll.) jika role bukan owner.
  - Audit scoping: staff hanya dapat membaca log miliknya sendiri; owner dapat mengakses seluruh log dengan keyset pagination.
  - Optimistic locking: update booking memverifikasi kecocokan `version` (409 Conflict jika basi/mismatch).
  - Approval hooks: aksi sensitif staff (hapus booking, pembatalan booking ber-DP, override nilai tagihan) otomatis dialihkan ke `approval_requests` (HTTP 202).
- Hasil uji: `tests/phase5_rbac.test.js` serta regresi penuh Fase 2, 3, 4, 5 lulus 100% (semua hijau).

## Catatan Fase 3
- File yang dibuat/disentuh: `services/audit.js`, `middleware/requestId.js`, `server.js`, `tests/phase3_audit.test.js`, `PROGRESS.md`.
- Fitur audit: `audit.record(tx, {...})` dalam transaksi atomik, perhitungan diff JSONB hanya menyimpan field yang berubah, redaksi otomatis field sensitif (password, token, hash) dan masking nomor WA (`0812****7890`), integrasi X-Request-Id. Helper `withAudit` untuk transaksi ber-rollback aman.
- Hasil uji: `node tests/phase3_audit.test.js` lulus 100% (sukses = 1 log, rollback = 0 log, diff valid, redaksi/masking valid).





## Keputusan Arsitektur & Catatan
- Argon2id / bcrypt: Gunakan bcryptjs / argon2 yang terinstal atau pilih library standar yang ringan dan aman.
- Transaksi DB: Gunakan client transaksi PostgreSQL Neon yang ada di `database.js`.
