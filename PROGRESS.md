# PROGRESS - Akun Staff, RBAC & Approval Tracking

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
- [ ] Fase 7: Test & Kinerja
- [ ] Fase 8: Review Keamanan & Rilis

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
