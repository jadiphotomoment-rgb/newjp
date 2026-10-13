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
- [ ] Fase 1: Migrasi Database
- [ ] Fase 2: Autentikasi & Otorisasi
- [ ] Fase 3: Layanan Audit Log
- [ ] Fase 4: Approval Engine
- [ ] Fase 5: Terapkan ke Endpoint yang Ada
- [ ] Fase 6: Frontend Admin
- [ ] Fase 7: Test & Kinerja
- [ ] Fase 8: Review Keamanan & Rilis

## Catatan Fase 0
- File yang disentuh: MAP.md, PROGRESS.md.
- Titik sentuh utama: routes/auth.js, routes/finance.js, routes/dashboard.js, routes/bookings.js, routes/pelunasan.js, routes/payment-settings.js, middleware/auth.js, database.js.
- Endpoint agregat uang: /api/finance/* (Owner only), /api/dashboard/sumber-informasi (perlu serializer per-role untuk buang total_revenue, avg_revenue, dsb).


## Keputusan Arsitektur & Catatan
- Argon2id / bcrypt: Gunakan bcryptjs / argon2 yang terinstal atau pilih library standar yang ringan dan aman.
- Transaksi DB: Gunakan client transaksi PostgreSQL Neon yang ada di `database.js`.
