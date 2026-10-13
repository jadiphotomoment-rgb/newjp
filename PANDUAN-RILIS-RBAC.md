# 🛡️ PANDUAN RILIS & REVIEW KEAMANAN (RBAC, STAFF & APPROVAL ENGINE)
**Jadiphoto.Moment — Production Readiness Checklist**

Dokumen ini adalah panduan rilis resmi dan verifikasi keamanan akhir untuk fitur **Akun Staff, RBAC & Approval Tracking**.

---

## 1. Verifikasi Kriteria Penerimaan (Definition of Done)

| Kriteria Penerimaan (crm.md) | Status | Bukti Pengujian |
|---|:---:|---|
| **Route Guarding**: Staff dilarang akses `/api/finance/*`, `/api/settings/payment/admin`, dan `/api/users` (403 Forbidden). | ✅ LULUS | `tests/phase5_rbac.test.js`, `tests/phase7_performance_e2e.test.js` |
| **Penyembunyian Data Keuangan**: Response dashboard & API memangkas field agregat revenue/omset untuk Staff. | ✅ LULUS | Serializer di `routes/dashboard.js`, diverifikasi pada level payload JSON. |
| **Append-Only Audit Log**: Setiap aksi penting mencatat tepat 1 baris audit log dalam transaksi atomik; manipulasi UPDATE/DELETE ditolak trigger DB. | ✅ LULUS | `services/audit.js`, `trigger audit_log_prevent_modify`, `tests/phase3_audit.test.js`. |
| **Approval Engine untuk Aksi Sensitif**: Aksi hapus/cancel booking ber-DP dialihkan ke status `pending` (HTTP 202) tanpa mengubah data sebelum disetujui Owner. | ✅ LULUS | `services/approval.js`, `tests/phase4_approval.test.js`. |
| **Pencegahan Self-Approval & Stale Data**: Pemohon tidak bisa menyetujui permintaannya sendiri; versi data diverifikasi saat persetujuan. | ✅ LULUS | CHECK constraint DB `decided_by <> requested_by`, optimistic base_version. |
| **Concurrency & Double-Submission Control**: Update simultan menerapkan atomic compare-and-swap di database (`WHERE id = $1 AND version = $2`). | ✅ LULUS | Stress-test 10 request bersamaan: tepat 1 berhasil (200), 9 ditolak (409). |
| **Pencabutan Sesi Seketika (Token Invalidation)**: Nonaktifkan staff atau reset password langsung menolak token lama via `token_version` in-memory cache. | ✅ LULUS | `utils/tokenVersionCache.js`, `tests/phase2_auth.test.js`. |
| **Redaksi PII & Nomor WA**: Nomor WhatsApp di-masking (`0812****7890`) dan hash/password/token otomatis diredaksi dari audit payload. | ✅ LULUS | Redactor di `services/audit.js`. |
| **Alur Publik Klien Aman**: Booking publik, invoice pelunasan, galeri sortir foto tidak terganggu dan tetap dapat diakses publik tanpa login. | ✅ LULUS | Regresi E2E `tests/phase7_performance_e2e.test.js`. |

---

## 2. Prosedur Deploy Produksi

### Langkah A: Persiapan Environment Variables (`.env`)
Pastikan environment variables berikut terkonfigurasi di server produksi / platform hosting:

```env
# Database Neon PostgreSQL
DATABASE_URL=postgres://user:pass@ep-xyz.neon.tech/neondb?sslmode=require

# JWT & Sesi Admin
JWT_SECRET=gunakan_string_acak_panjang_minimal_64_karakter
COOKIE_SECRET=string_acak_pengaman_cookie

# Feature Flag (Default: true)
RBAC_ENABLED=true
```

### Langkah B: Jalankan Migrasi Database
Skrip migrasi bersifat **idempotent** (aman dijalankan berulang kali tanpa merusak data yang sudah ada):

```bash
npm run db:migrate
```

Skrip ini akan:
1. Membuat tabel `users`, `refresh_tokens`, `approval_rules`, `approval_requests`, `audit_log` (jika belum ada).
2. Memasang trigger database append-only pada tabel `audit_log`.
3. Menambahkan kolom `created_by`, `updated_by`, dan `version` pada tabel `bookings`, `pelunasan`, `payments`.
4. Menginisialisasi default approval rules (override amount, diskon, cancel booking DP).

### Langkah C: Buat / Pulihkan Akun Owner Perdana
Jika akun Owner belum tersedia atau kredensial lama ingin diperbarui:

```bash
npm run owner:create
```
*Atau masukkan parameter via environment variable:*
```bash
OWNER_NAME="Owner Jadiphoto" OWNER_EMAIL="owner@jadiphoto.com" OWNER_PASSWORD="PasswordKuatMinimal10!" node scripts/create-owner.js
```

---

## 3. Rencana Rollback (Bila Dibutuhkan Darurat)

Jika terjadi kendala tak terduga pasca rilis di lingkungan produksi, sistem dapat di-rollback seketika **tanpa perlu rollback skema database**:

1. **Ubah Feature Flag di `.env`**:
   ```env
   RBAC_ENABLED=false
   ```
2. **Restart Layanan**:
   ```bash
   npm run start
   ```
3. **Efek Rollback**:
   - Middleware `requirePermission` otomatis meloloskan seluruh request (kembali ke mode single admin kompatibel).
   - Seluruh tabel dan data baru (`audit_log`, `approval_requests`) tetap tersimpan aman di PostgreSQL Neon tanpa mengganggu alur legacy.

---

## 4. SOP Pemulihan Akses Darurat (Emergency Recovery)

Bila akun Owner terkunci akibat 5x kesalahan password atau kredensial hilang:
1. Akses server host via SSH atau command environment.
2. Jalankan perintah pemulihan:
   ```bash
   npm run owner:create
   ```
3. Masukkan email owner yang ada dan password baru. Skrip akan secara otomatis:
   - Mereset password dengan enkripsi bcrypt cost 12.
   - Mereset `failed_attempts` ke 0 dan membuka `locked_until`.
   - Menaikkan `token_version` untuk mencabut seluruh sesi aktif sebelumnya.
