# Prompt AI: Filter Booking Berdasarkan Tanggal + Ringkasan Jadwal Sesi Foto

Versi ringan dan mandiri (bisa dikerjakan cepat). Fitur ini sama dengan **Tahap 1** di `PRD-PROMPT-Kalender-Jadwal-Booking.md`, ditambah ringkasan jadwal per tanggal. Jika nanti membangun kalender, hasil di sini bisa dipakai ulang.

Salin bagian di antara dua garis ke AI coding assistant.

---

Kamu adalah senior fullstack dev. Tambahkan fitur **filter booking berdasarkan tanggal** di panel admin app booking foto saya, agar admin mudah melihat jadwal sesi foto pada tanggal tertentu.

**STACK:** Node.js Express, PostgreSQL (Neon), auth JWT, Vanilla JS/HTML/CSS, deploy Vercel.

## ATURAN KERJA (wajib, hemat token & minim bug)

- Jangan scan seluruh repo atau rewrite file utuh. Grep dulu: skema tabel `bookings` (kolom tanggal acara, jam, status, kategori, lokasi, `deleted_at`), handler `GET` list booking, `/admin/bookings.html` (tabel + filter yang sudah ada), dan gaya CSS/komponen filter yang ada.
- REUSE komponen dan gaya yang ada. Tidak ada library baru (pakai `<input type="date">` bawaan browser), tidak ada refactor di luar scope.
- Kerjakan dalam 3 tahap, commit terpisah, berhenti dan tanya "Lanjut?" setelah tiap tahap. Output hanya: rencana 3-5 baris, diff minimal, hasil tes singkat.
- Jika ada asumsi penting (misal nama kolom tanggal/jam tidak jelas), tanya SATU kali di awal (maks 2 pertanyaan).
- Branch `feat/filter-tanggal-booking`. Jangan push, merge, atau deploy. Migrasi (jika ada) harus idempotent dan tidak dijalankan ke produksi; beri saya perintahnya.

## ATURAN PENCEGAH BUG

1. Tanggal acara diperlakukan sebagai **tanggal murni zona WIB (Asia/Jakarta)**. Bandingkan dan kirim sebagai string `YYYY-MM-DD`. Jangan memakai `new Date("YYYY-MM-DD")` untuk logika filter (menggeser hari akibat UTC). "Hari ini" dihitung memakai zona Asia/Jakarta (misal `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jakarta'})`).
2. Validasi di server: format `YYYY-MM-DD`, `from <= to`, rentang maksimal 366 hari; input tidak valid dibalas 400 dengan pesan jelas.
3. Query berparameter (`$1`, `$2`), tanpa string concat SQL. Selalu `deleted_at IS NULL`.
4. Filter bersifat **inklusif** (tanggal awal dan akhir ikut). Booking tanpa tanggal tidak muncul pada filter tanggal, dan tidak boleh menyebabkan error.
5. Escape teks yang dirender ke HTML (cegah XSS).

## TAHAP 1: BACKEND

- Tambahkan parameter opsional pada endpoint list booking yang sudah ada: `date` (satu tanggal) **atau** `from` + `to` (rentang). Jika `date` diberikan, perlakukan sebagai `from = to = date`.
- Kombinasikan dengan filter yang sudah ada (status, kategori, lokasi, status pembayaran). Perilaku tanpa parameter tanggal tidak boleh berubah.
- Urutkan hasil filter tanggal berdasarkan **tanggal lalu jam naik (ascending)**; booking tanpa jam di bagian akhir tiap tanggal.
- Tambahkan indeks pada kolom tanggal acara bila belum ada (migrasi `IF NOT EXISTS`).
- Respons menyertakan total jumlah hasil.

## TAHAP 2: UI FILTER (`/admin/bookings.html`)

- Blok filter tanggal: input **Tanggal** (satu hari) dan pasangan **Dari - Sampai** (rentang), serta tombol cepat: **Hari ini, Besok, Minggu ini, Bulan ini, 7 hari ke depan, 30 hari ke depan**. Memilih satu mode otomatis mengosongkan mode lainnya.
- Bisa dikombinasikan dengan filter yang sudah ada; tombol **Reset** mengembalikan semua filter tanggal.
- Simpan filter di **query string URL** (`?date=` atau `?from=&to=`) sehingga hasil tetap setelah refresh dan bisa dibagikan/dibookmark. Saat halaman dibuka dengan parameter itu, filter terisi otomatis.
- Tampilkan penjelasan hasil: *"N sesi pada 20 Nov 2026"* atau *"N sesi, 20 Nov - 27 Nov 2026"* (format tanggal Indonesia).
- State kosong yang ramah: *"Tidak ada sesi pada tanggal ini"*; jika memungkinkan tawarkan tautan ke tanggal terdekat berikutnya yang punya sesi.
- Cegah request berulang saat mengetik/memilih cepat (debounce singkat), tampilkan indikator memuat, dan tangani error dengan pesan jelas.
- Responsif di mobile; kontrol filter dapat diakses keyboard dan punya label.

## TAHAP 3: RINGKASAN JADWAL (untuk filter 1 tanggal)

- Saat filter satu tanggal aktif, tampilkan kartu ringkasan di atas tabel: jumlah sesi dan daftar ringkas per sesi: **jam, nama klien, kategori/paket, lokasi, status booking, status pembayaran (belum DP / DP / lunas)**.
- Tombol **"Salin Jadwal"**: menyalin teks rapi siap tempel ke WhatsApp tim, contoh format:
  ```
  Jadwal Sesi Foto - Kamis, 20 Nov 2026
  1. 09.00 - Nama Klien - Wedding (Paket X) - Solo - Confirmed (Lunas)
  2. 14.00 - Nama Klien - Graduation (Paket Y) - Jogja - Confirmed (DP)
  ```
  Booking tanpa jam ditulis "Sepanjang hari". Beri umpan balik singkat ("Tersalin") dan fallback jika Clipboard API tidak tersedia.
- Klik sebuah sesi pada ringkasan membuka detail booking yang sudah ada (reuse, jangan buat tampilan detail baru).
- Tidak ada pengiriman WA otomatis pada tahap ini.

## CHECKLIST VERIFIKASI (laporkan pass/fail singkat)

- [ ] Filter satu tanggal menampilkan hanya booking tanggal itu; tanggal tidak bergeser sehari (uji tanggal 1 dan akhir bulan, serta hari ini dengan jam di atas 17.00 UTC).
- [ ] Filter rentang inklusif; `from > to` atau rentang lebih dari 366 hari ditolak 400.
- [ ] Kombinasi dengan status/kategori/lokasi benar; tanpa parameter tanggal perilaku lama tidak berubah.
- [ ] Booking terhapus (soft delete) dan booking tanpa tanggal tidak membuat error atau muncul keliru.
- [ ] Tombol cepat (Hari ini, Besok, dll.) memakai tanggal WIB yang benar.
- [ ] Filter bertahan setelah refresh dan terisi otomatis dari URL.
- [ ] Ringkasan jadwal dan "Salin Jadwal" menghasilkan teks yang benar, urut berdasarkan jam, booking tanpa jam di akhir.
- [ ] State kosong, loading, dan error tampil; nyaman di mobile dan desktop.

## OUTPUT

Pertanyaan (jika perlu) -> Tahap 1 -> 2 -> 3, masing-masing: Rencana -> Patch -> Cara tes.

---

## Catatan Penggunaan (tidak perlu disalin ke AI)

- Jika AI tidak punya akses repo, tempelkan hanya: skema `bookings`, handler list booking, dan potongan `/admin/bookings.html` yang memuat filter dan tabel.
- Fitur ini tidak memeriksa bentrok/kuota jadwal. Untuk melihat tanggal kosong, kalender, dan pencegahan double booking, gunakan `PRD-PROMPT-Kalender-Jadwal-Booking.md` setelah ini.
- Backup dulu (snapshot/branch Neon) sebelum menjalankan migrasi indeks.
