# Prompt AI: Eksekusi PRD T&C Konfirmasi Booking

Salin seluruh isi di bawah garis ini ke AI coding assistant (Claude Code, Cursor, dll).
Pastikan file `PRD-TnC-Konfirmasi-Booking.md` sudah ada di root project.

---

Kamu adalah senior fullstack dev. Implementasikan fitur T&C pada form booking sesuai spesifikasi di `PRD-TnC-Konfirmasi-Booking.md`.

**STACK:** Node.js Express, PostgreSQL (Neon), auth JWT + bcryptjs, Vanilla JS/HTML, WA via Fonnte/Wablas, deploy Vercel.

## ATURAN KERJA (wajib, hemat token)

- Baca PRD hanya bagian yang dibutuhkan per tahap (Bagian 5, 6, 7, 9). Jangan scan seluruh repo dan jangan rewrite seluruh file.
- Gunakan grep untuk menemukan: handler `POST /api/bookings`, `/booking.html` (form + JS), skema tabel `bookings`, middleware JWT + cek role owner, halaman admin detail booking, helper link publik (`PUBLIC_BASE_URL`), fungsi kirim WA.
- REUSE middleware, helper, dan gaya UI yang ada. Tidak ada library baru, tidak ada refactor di luar scope.
- Kerjakan **Fase 1 (MVP) saja** dulu. Fase 2 dan 3 jangan disentuh sebelum saya minta.
- Output hanya: rencana 3-5 baris, diff/patch minimal per file, hasil tes singkat. Jangan menampilkan isi file utuh.
- Jika ada konflik antara PRD dan kode yang ada, atau ada asumsi penting, tanya SATU kali (maks 3 pertanyaan), lalu lanjut.

## TAHAP 0: PERSIAPAN

1. Pastikan git bersih, buat branch `feat/tnc-booking`.
2. Ringkas hasil grep dalam maks 10 baris: skema `bookings`, nama middleware auth, lokasi form booking dan handler booking, lokasi detail booking admin.
3. Ajukan pertanyaan klarifikasi (jika ada), lalu berhenti dan tunggu jawaban.

## TAHAP 1: DATABASE (migrasi idempotent)

- Buat satu file migrasi terpisah (`IF NOT EXISTS`), **jangan dijalankan ke database produksi**. Beri saya perintah untuk menjalankannya.
- Tabel `terms_versions` dan `terms_acceptances` serta kolom `bookings.terms_accepted_at` (nullable) sesuai PRD Bagian 6. Nominal/ID mengikuti konvensi tabel existing.
- `terms_acceptances` append-only: tidak membuat endpoint update/delete.
- Seed 1 versi aktif T&C Umum berisi 4 poin contoh dari PRD (FR9), idempotent (jangan duplikat jika dijalankan ulang).

## TAHAP 2: BACKEND

1. **Owner (JWT + role owner di server):**
   - `GET /api/admin/terms` (daftar versi), `GET /api/admin/terms/:id`
   - `PUT /api/admin/terms/draft` (simpan draft), `POST /api/admin/terms/publish` (buat versi baru, arsipkan versi aktif sebelumnya, dalam 1 DB transaction)
   - Tolak publish jika poin kosong atau isi tidak berubah dari versi aktif.
2. **Publik (read-only):** `GET /api/terms/active` mengembalikan versi aktif (id, nomor versi, poin). Cache singkat di memori dan bersihkan cache saat publish.
3. **Booking:** ubah `POST /api/bookings` agar:
   - Wajib menerima `terms_version_id` dan `terms_accepted: true`; tolak 400 jika tidak ada atau versi tidak valid.
   - Dalam **1 DB transaction**: simpan booking + insert `terms_acceptances` (snapshot teks, `accepted_at` dari waktu server, nama, WA, IP dari `x-forwarded-for` pertama atau fallback socket, user agent) + set `bookings.terms_accepted_at`.
4. `GET /api/admin/bookings/:id/terms` mengembalikan catatan persetujuan untuk admin. Endpoint publik baca-saja salinan T&C yang disetujui memakai token tak tertebak (bukan ID berurutan).
5. Validasi server untuk semua input, query berparameter ($1, $2), tidak ada string concat SQL. Respons API tidak membocorkan data internal.

## TAHAP 3: FRONTEND

1. **Dashboard owner:** menu "Term & Condition" (hanya role owner; role lain mendapat `/403.html`). Editor daftar poin: tambah, edit, hapus, urutkan ulang; tombol Simpan Draft, Pratinjau, Publish; daftar riwayat versi. Escape semua teks yang dirender ke HTML.
2. **Form `/booking.html`:** sebelum tombol Submit tampilkan kotak T&C yang bisa di-scroll, tautan "Baca selengkapnya", dan checkbox persetujuan. Tombol Submit nonaktif sampai dicentang; cegah double submit; tampilkan pesan error dari server. Versi yang ditampilkan dikirim bersama booking.
3. **Detail booking admin:** blok "Persetujuan T&C" (versi, waktu, tombol lihat isi). Booking lama tampil "Belum ada catatan T&C".
4. Responsif dan nyaman di mobile; gunakan gaya CSS yang sudah ada.

## TAHAP 4: UJI & PENUTUP

Jalankan tes/lint yang tersedia, lalu laporkan pass/fail per item:

- [ ] Submit booking tanpa centang: UI menolak, dan request API langsung tanpa persetujuan ditolak 400.
- [ ] Booking sukses: baris `terms_acceptances` terbentuk dengan snapshot, waktu, IP, user agent.
- [ ] Owner publish versi baru: form klien menampilkan versi baru; persetujuan lama tetap menampilkan isi lama.
- [ ] User non-owner mengakses menu atau endpoint T&C: 403 (halaman `/403.html` untuk halaman).
- [ ] Publish dengan poin kosong atau tanpa perubahan: ditolak dengan pesan jelas.
- [ ] Gagal insert persetujuan: booking ikut dibatalkan (transaction rollback).
- [ ] Booking lama tidak error dan tampil "Belum ada catatan T&C".

Lakukan commit terpisah per tahap dengan pesan jelas. **Jangan push, merge, atau deploy.** Setelah tiap tahap, laporkan maks 5 baris lalu tanya "Lanjut ke tahap berikutnya?" dan tunggu konfirmasi.

## OUTPUT

Pertanyaan (jika perlu) -> Tahap 1 -> 2 -> 3 -> 4, masing-masing: Rencana -> Patch -> Hasil tes.

---

## Catatan Penggunaan (tidak perlu disalin ke AI)

- **Backup dulu:** buat snapshot atau branch database Neon sebelum menjalankan migrasi.
- **Urutan di sistem kamu:** idealnya kerjakan setelah bug `PUBLIC_BASE_URL` selesai dan fitur halaman 403 sudah ada, karena prompt ini memakai keduanya.
- **Fase 2** (T&C per kategori, tautan T&C di WA, cetak bukti, filter admin) dikirim sebagai prompt terpisah setelah Fase 1 lolos uji. Cukup minta: "Lanjut Fase 2 sesuai PRD, aturan kerja sama seperti sebelumnya."
- Jika AI tidak punya akses repo, tempelkan hanya: skema `bookings`, handler `POST /api/bookings`, potongan form booking, dan middleware auth.
