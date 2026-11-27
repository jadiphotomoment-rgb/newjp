# Prompt AI: Perbaikan UI Admin + Promo/Voucher (Hemat Token, Minim Bug)

Letakkan `PRD-Promo-Voucher-dan-Perbaikan-UI.md` di root project (berdampingan dengan `PRD-Billing-Terpusat.md` bila sudah ada).

Isi file:
- **Bagian 1:** prompt peluncur (salin ke Claude Code per sesi; ganti `KODE` dengan kode fase).
- **Bagian 2:** spesifikasi per fase (AI hanya membaca fase yang dikerjakan).
- **Bagian 3:** tips hemat token dan pencegah bug (untuk kamu).

**Urutan disarankan:** `U1` (UI, cepat dan independen) -> `V0` -> `V1` -> `V2` -> `V3` -> `V4` -> `V5`. Untuk `V2`, sebaiknya Billing Terpusat Fase 1-3 sudah selesai.

---

## BAGIAN 1: PROMPT PELUNCUR

```
Kerjakan fase KODE dari PRD-Promo-Voucher-dan-Perbaikan-UI.md.
Baca HANYA: bagian PRD yang disebut pada fase KODE di PROMPT-Promo-Voucher-dan-Perbaikan-UI.md (Bagian 2) + aturan umum di sana.
File besar (routes/bookings.js, public/admin/bookings.html 3000+ baris): jangan dibuka utuh; pakai `grep -n` lalu `sed -n 'A,Bp'` pada jangkar di PRD (nomor baris bisa bergeser).
Jangan scan repo, jangan baca ulang file yang sudah dibaca. Branch: feat/voucher-ui. Jangan push/merge/deploy.
Output hanya: rencana maks 5 baris -> diff minimal -> hasil tes/cek -> "Fase KODE selesai, lanjut?". Tanpa penjelasan panjang.
Konflik PRD vs kode atau asumsi penting: tanya SATU kali, jangan menebak. Commit per fase.
```

---

## BAGIAN 2: SPESIFIKASI PER FASE

**Aturan umum (semua fase):** Node/Express, PostgreSQL (Neon), JWT, Vanilla JS, Tailwind kelas yang sudah ada. Reuse helper dan gaya yang ada (`services/audit.js`, middleware `auth.js`, komponen UI). Tanpa library baru, tanpa refactor di luar scope. Uang = integer rupiah. Query berparameter. Multi-tabel dalam 1 transaksi dengan `FOR UPDATE`. Tanggal = string `YYYY-MM-DD` WIB (dilarang `new Date("YYYY-MM-DD")` untuk logika). Migrasi idempotent (`IF NOT EXISTS`), **jangan dijalankan ke produksi**, beri saya perintahnya. Escape teks yang dirender ke HTML. Tes baru ditambahkan ke rantai `npm test` di `package.json`; saat bekerja jalankan **hanya file tes baru**, seluruh suite hanya di fase terakhir.

---

### FASE U1: Perbaikan UI (PRD Bagian B, hanya B1 dan B2)

Konfirmasi dulu (tanpa mengubah kode): jalankan `grep -rn "classList.remove('-translate-x-full')" public/admin/*.html | cut -c1-80` dan `grep -L 'data-sidebar-toggle' public/admin/*.html`; tampilkan daftar halaman (maks 15 baris).

1. **Markup (lewat satu skrip penggantian yang idempotent, mis. Node/sed, bukan edit manual):** pada semua `public/admin/*.html` yang punya sidebar:
   - Burger di header: hapus `onclick` inline; tambahkan `type="button" data-sidebar-toggle aria-label="Buka menu" aria-controls="sidebar" aria-expanded="false"`; `md:hidden` -> `lg:hidden`; kelas area sentuh `inline-flex items-center justify-center w-11 h-11 -ml-2 rounded-lg`.
   - Tombol X di sidebar: hapus `onclick` inline; tambahkan `type="button" data-sidebar-close aria-label="Tutup menu"`; `md:hidden` -> `lg:hidden`.
   - `md:pl-72` -> `lg:pl-72` pada wrapper konten; `md:translate-x-0` -> `lg:translate-x-0` pada `<aside id="sidebar">`.
   - Skrip harus melaporkan jumlah penggantian per file dan aman dijalankan ulang.
2. **`public/js/admin-nav.js` (~318-400, `initSidebarDrawer`):** pakai event delegation di `document` untuk `[data-sidebar-toggle]` (buka) dan `[data-sidebar-close]` (tutup); sinkronkan `aria-expanded`; tutup saat link menu diklik di layar < 1024px; saat `resize`/`matchMedia('(min-width:1024px)')` menjadi true -> tutup drawer dan hapus `overflow-hidden`; pertahankan Esc dan klik backdrop; pastikan `initSidebarDrawer()` dipanggil di semua halaman.
3. **Scroll sidebar di `public/css/admin-theme.css` (blok ~266-330):** tinggi `100dvh` dengan fallback `100vh` di kedua media query; `#sidebar` kolom flex; header dan footer sidebar `flex-shrink:0`; `#sidebar nav { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; scrollbar-width:thin; }`; footer dengan `padding-bottom: env(safe-area-inset-bottom)`. Di `admin-nav.js`: `scrollIntoView({block:'nearest'})` pada item menu aktif saat dimuat.
4. **Cek (lapor pass/fail singkat):** tidak ada lagi `classList.remove('-translate-x-full')` inline; burger berfungsi di 390, 768, 1000px; X/backdrop/Esc/klik menu menutup; >= 1024px sidebar tetap dan burger tersembunyi; nav bisa scroll pada tinggi 500px dengan 14 item dan tombol Keluar terlihat; tidak ada regresi di `dashboard`, `bookings`, `finance`, `terms`. Jika ada browser/Playwright, ambil screenshot; jika tidak, beri langkah cek manual.

---

### FASE V0: Audit (tanpa ubah kode, maks 15 baris laporan)

1. `handleCreateBooking` (`routes/bookings.js` ~150-321): di mana `finalPackagePrice` dan `dp_amount` dihitung (harga paket, harga per lokasi, DP dari `dp_type/dp_value`), field apa yang diterima dari body, dan titik sisip voucher.
2. Pola audit (`services/audit.js`): nama fungsi dan cara memanggil. Normalisasi nomor WA: adakah helper (cari di kode kirim WA); jika tidak ada, usulkan `utils/phone.js`.
3. Konstruksi RBAC (`migrations/001_rbac_and_approvals.sql`, `middleware/auth.js`): cara menambah permission `voucher.manage`.
4. Cron cleaner booking: file, dan titik pembatalan/penolakan booking yang perlu memanggil `release`.
5. Konfirmasi bug `approvals.js` ~294-312: kolom `discount` memang tidak ada di `bookings`.
6. Pola tes yang ada (`tests/*.test.js`): cara membuat data dan menjalankan (butuh DB apa).
Berhenti setelah laporan.

### FASE V1: Data + service + tes (PRD A4-A6)

- Migrasi: `vouchers`, `voucher_scopes`, `voucher_redemptions`, kolom `bookings.voucher_id/voucher_code/voucher_discount/manual_discount`, indeks (kode unik parsial `WHERE deleted_at IS NULL`; satu redemption `applied` per booking). Tabel kecil percobaan validasi untuk rate limit.
- `services/voucher.js`: `validateVoucher(q, code, ctx)`, `redeem(client, {...})`, `release(client, bookingId)`, `computeDiscount(rule, price)`; algoritma persis PRD A5 (floor, cap maks, `min(d, price)`, harga bersih > 0, tanggal WIB inklusif, hitung kuota dari redemption `applied`, per klien via nomor WA ternormalisasi). `redeem` hanya boleh dipanggil dalam transaksi aktif dan mengunci baris voucher `FOR UPDATE`.
- Tes `tests/voucher.test.js`: skenario PRD A12 nomor 1-6 dan 8 (termasuk batas tanggal, kuota terakhir paralel, pembulatan, kode berspasi/huruf kecil).
- Belum mengubah route.

### FASE V2: Integrasi booking, billing, approval (PRD A5, A6, A12)

- `POST /api/bookings`: terima `voucher_code`; dalam satu transaksi: validasi ulang di server, simpan booking dengan `voucher_*`, hitung `dp_amount` dari **harga bersih**, `redeem`. Harga dihitung server, abaikan nilai harga dari klien.
- Billing: total = `max(package_price - voucher_discount - manual_discount, 0)`. Bila `services/billing.js` ada, ubah `computeBilling` dan panggil `syncBilling`; bila belum, buat satu helper `getNetPrice(booking)` dan pakai di semua pembacaan harga untuk tagihan/DP (hasil audit V0).
- Perbaiki `approvals.js` ~294-312: payload `discount` -> kolom `manual_discount`, lalu hitung ulang `dp_amount`/sync billing; tidak ada lagi referensi kolom `discount`.
- Set-price/PUT booking: diskon persen dihitung ulang dari snapshot aturan, nominal tetap, batas harga bersih > 0.
- Pelepasan kuota: panggil `release` di pembatalan, penolakan, dan cron cleaner (titik dari V0).
- Endpoint `PATCH /api/admin/bookings/:id/voucher` (owner, hanya sebelum DP disetujui).
- Tes: PRD A12 nomor 7, 8, 10 dan pelepasan kuota.

### FASE V3: UI publik (PRD A8, bagian klien)

- `POST /api/vouchers/validate` (publik): harga dihitung server dari paket/lokasi; pesan gagal **umum**; rate limit DB 10 percobaan / 10 menit per IP (`x-forwarded-for` pertama); respons 429 saat terlampaui.
- `/booking.html`: bagian "Kode Promo" (input uppercase+trim, tombol Terapkan, state memuat/berhasil/gagal, tombol hapus kode), rincian harga (Harga paket, Diskon, Total, DP), validasi ulang otomatis saat paket/lokasi berubah, `aria-live="polite"`, Submit nonaktif selama validasi. Jangan mengubah blok T&C.
- Halaman DP/tagihan klien: tampilkan baris Diskon dan Total sesuai API.
- Tes: validate (valid/invalid/429), dan booking dengan kode melalui endpoint.

### FASE V4: UI admin (PRD A8, bagian admin)

- Menu sidebar "Promo & Voucher" (ikuti pola menu yang ada, permission `voucher.manage`) dan halaman `/admin/vouchers.html` dengan layout/gaya halaman admin lain (termasuk perbaikan U1: burger `data-sidebar-toggle`, `lg:` breakpoint).
- API admin: CRUD voucher, toggle aktif, `redemptions` + ringkasan; kode terkunci bila sudah dipakai; soft delete; audit pada setiap penulisan; status turunan (Aktif/Terjadwal/Kedaluwarsa/Habis/Nonaktif) dihitung di server.
- Form: pratinjau contoh diskon, kode otomatis, cakupan multi-pilih.
- Detail booking admin: blok "Promo" + tombol ubah/hapus (owner, sebelum DP disetujui).
- 403 untuk non-owner (halaman `/403.html` bila sudah ada). Cek: halaman rapi di 390 dan 1440px.

### FASE V5: Penutup

- Jalankan **seluruh** `npm test`; laporkan regresi. Pembersihan kode mati, dokumentasi singkat di README/MAP (satu paragraf).
- Checklist akhir: PRD A12 nomor 1-11 dan PRD B1/B2 acceptance (pass/fail singkat).

---

## BAGIAN 3: TIPS HEMAT TOKEN & PENCEGAH BUG (untuk kamu)

1. **Satu fase = satu sesi.** `/clear` di Claude Code antar fase. Hasil fase sebelumnya sudah ada di kode dan commit.
2. **Mulai dari `U1`.** Perubahannya dibatasi (CSS, `admin-nav.js`, skrip penggantian markup), dampaknya langsung terlihat, dan menghasilkan layout stabil untuk halaman Promo & Voucher.
3. **Jangan lewati `V0`** (murah, hanya membaca): memastikan titik sisip yang tepat di `handleCreateBooking` dan menghindari patch di tempat salah.
4. **Skrip penggantian > edit manual** untuk 8+ halaman admin yang sama: hemat token dan konsisten. Minta AI menampilkan hitungan penggantian per file, bukan isi file.
5. **Tes selektif:** jalankan hanya `node tests/voucher.test.js` per fase; `npm test` penuh hanya di `V5`.
6. **Larang penjelasan panjang:** prompt peluncur sudah membatasi output ke rencana, diff, hasil tes.
7. **Pencegah bug utama:** server sebagai satu-satunya penghitung diskon; `FOR UPDATE` + indeks unik untuk kuota; tanggal WIB berupa string; integer rupiah; semua penulisan multi-tabel dalam satu transaksi; migrasi idempotent.
8. **Backup:** snapshot/branch Neon sebelum menjalankan migrasi apa pun.
9. **Jika AI melenceng:** hentikan, ketik koreksi singkat ("Fase V2 saja, jangan ubah UI") alih-alih mengulang prompt panjang.
10. **Jika AI tidak punya akses repo:** tempelkan hanya `handleCreateBooking`, blok sidebar+header satu halaman admin, `initSidebarDrawer`, dan blok CSS `admin-theme.css` ~266-330.
