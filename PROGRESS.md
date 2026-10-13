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
- [ ] Fase 3: Layanan Audit Log
- [ ] Fase 4: Approval Engine
- [ ] Fase 5: Terapkan ke Endpoint yang Ada
- [ ] Fase 6: Frontend Admin
- [ ] Fase 7: Test & Kinerja
- [ ] Fase 8: Review Keamanan & Rilis

## Catatan Fase 2
- File yang dibuat/disentuh: `constants/permissions.js`, `utils/tokenVersionCache.js`, `middleware/auth.js`, `routes/auth.js`, `tests/phase2_auth.test.js`, `PROGRESS.md`.
- Fitur auth: login dengan rate limiter & lockout (5x gagal -> 15 min lock), access token 15 menit, refresh token 7 hari di cookie HttpOnly dengan rotasi & deteksi pemakaian ulang (chain revocation), logout, ganti password wajib (min 10 karakter).
- Hasil uji: `node tests/phase2_auth.test.js` lulus 100% (login sukses, login gagal seragam, lockout 429, RBAC per-role, refresh rotation, reuse detection, nonaktifkan user -> 401).
- Keputusan: Middleware auth mempertahankan `req.admin` selain `req.user` untuk backward compatibility mulus dengan controller yang belum dimigrasi.




## Keputusan Arsitektur & Catatan
- Argon2id / bcrypt: Gunakan bcryptjs / argon2 yang terinstal atau pilih library standar yang ringan dan aman.
- Transaksi DB: Gunakan client transaksi PostgreSQL Neon yang ada di `database.js`.
