# Prompt AI: CRUD Admin Owner (Transaksi, Booking, User)

Salin seluruh isi di bawah garis ini ke AI coding assistant (Claude Code, Cursor, dll).

---

Kamu adalah senior fullstack dev. Tambahkan 3 fitur CRUD di panel Admin Owner pada app booking foto saya.

**STACK:** Node.js Express, PostgreSQL (Neon), auth JWT + bcryptjs, Vanilla JS/HTML, deploy Vercel.
Halaman terkait: `/admin/bookings.html`, `/admin/finance.html`, dan menu admin yang sudah ada.

## ATURAN KERJA (wajib, hemat token & minim bug)

- Jangan baca/rewrite seluruh file. Grep dulu: skema tabel bookings/transactions (finance)/users, middleware auth JWT, handler endpoint bookings & finance yang sudah ada, dan komponen tabel/modal di frontend.
- REUSE middleware, helper, dan gaya UI yang sudah ada. Tidak ada library baru, tidak ada refactor di luar scope.
- Kerjakan BERURUTAN per fitur (A -> B -> C). Setelah tiap fitur: tampilkan patch minimal + 3 langkah tes, lalu lanjut.
- Jika ada asumsi yang perlu konfirmasi, tanya SATU kali di awal (maks 3 pertanyaan), lalu kerjakan.
- Output per fitur: rencana 3-5 baris -> patch/diff per file -> cara tes.

## ATURAN LINTAS FITUR (pencegah bug)

1. **Hak akses:** semua endpoint tulis (POST/PUT/PATCH/DELETE) di bawah dilindungi middleware JWT + cek role owner di SERVER. Menyembunyikan tombol di frontend saja tidak cukup.
2. **Validasi di server:** tipe data, nominal >= 0 (integer rupiah, bukan float), tanggal valid, enum status sesuai daftar. Gunakan query berparameter ($1, $2), tidak ada string concat SQL.
3. **Soft delete:** transaksi dan booking tidak dihapus permanen. Gunakan kolom `deleted_at` (nullable) dan semua query list/rekap wajib memfilter `deleted_at IS NULL`. Cek semua query rekap/dashboard yang sudah ada agar ikut difilter.
4. **DB transaction:** operasi yang menyentuh lebih dari satu tabel harus dalam satu transaction (BEGIN/COMMIT/ROLLBACK).
5. **Audit ringan:** simpan `updated_at` dan `updated_by` pada data yang diubah (tanpa membuat tabel log baru kecuali sudah ada).
6. **Frontend:** konfirmasi sebelum hapus, tombol submit dinonaktifkan saat request berjalan (cegah double submit), tampilkan pesan error dari server, dan refresh tabel setelah sukses. Escape teks yang dirender ke HTML (cegah XSS).

## FITUR A: CRUD TRANSAKSI KEUANGAN (`/admin/finance.html`)

- Create/Read/Update/Delete (soft) transaksi dengan field: tanggal, tipe (pemasukan/pengeluaran), kategori, nominal, keterangan, opsional `booking_id` (nullable, hanya jika transaksi terkait booking).
- Filter list berdasarkan rentang tanggal & tipe, plus total pemasukan/pengeluaran/saldo yang dihitung di server.
- Transaksi yang dibuat otomatis oleh sistem (DP/pelunasan dari booking) boleh diedit tetapi beri penanda sumber (kolom `source`: `'manual'` atau `'booking'`); jika kolom belum ada, tambahkan satu kolom ringan.
- Hapus transaksi yang terkait booking -> hitung ulang total dibayar booking tersebut (lihat Fitur B).

## FITUR B: CRUD BOOKING + EDIT STATUS & BIAYA DIBAYAR (`/admin/bookings.html`)

- Edit booking: nama, kontak WA, kategori/paket, tanggal acara, catatan, status booking.
- Tambahkan input **"Jumlah Dibayar"** langsung di kolom/baris booking (inline atau modal), plus tampilkan **Total Harga** dan **Sisa** (sisa = total - dibayar, dihitung otomatis, bukan diinput).
- Status pembayaran diturunkan otomatis dari angka: dibayar = 0 -> belum bayar; 0 < dibayar < total -> DP/sebagian; dibayar >= total -> lunas. Admin tetap bisa mengubah status booking (pending/confirmed/dll) secara manual.
- **SUMBER KEBENARAN TUNGGAL (kritis):** angka dibayar di booking dan transaksi keuangan tidak boleh berbeda. Aturan: saat admin mengubah "Jumlah Dibayar", server (dalam 1 DB transaction) membuat transaksi penyesuaian di finance sebesar selisihnya dengan `source='booking'` dan `booking_id` terkait, lalu memperbarui angka booking. Validasi: dibayar tidak boleh negatif dan tidak boleh melebihi total harga (tolak dengan pesan jelas). Jika arsitektur finance saat ini sudah menyimpan dibayar di tempat lain, sesuaikan dan jelaskan di rencana.
- Delete booking = soft delete. Tolak/beri peringatan jika booking punya transaksi atau sesi sortir aktif.

## FITUR C: CRUD USER VIA ADMIN

- Halaman/menu "Pengguna" hanya untuk role owner: list, tambah, edit (nama, email/username, role, status aktif), reset password, nonaktifkan/hapus.
- **Password:** hash dengan bcryptjs yang sudah dipakai, minimal 8 karakter, JANGAN pernah mengembalikan field password/hash di response API.
- **Aturan keamanan:** username/email unik (tangani error duplikat dengan pesan ramah); owner tidak boleh menghapus/menonaktifkan dirinya sendiri; sistem tidak boleh kehilangan owner terakhir (tolak jika itu satu-satunya owner aktif).
- Pilih nonaktifkan (kolom `is_active`) daripada hapus permanen; user nonaktif ditolak saat login dan token lamanya ditolak oleh middleware.
- Role yang dipakai: ikuti yang sudah ada di sistem. Jika belum ada, cukup `owner` dan `admin`.

## CHECKLIST AKHIR (jalankan dan laporkan hasilnya singkat)

- [ ] Akses endpoint tulis tanpa token / dengan role bukan owner -> 401/403.
- [ ] Input nominal negatif / melebihi total / enum salah -> ditolak dengan pesan jelas.
- [ ] Ubah "Jumlah Dibayar" booking -> transaksi finance & rekap dashboard ikut berubah dan konsisten.
- [ ] Hapus transaksi/booking -> hilang dari list & rekap, data tetap ada di DB.
- [ ] Tidak bisa menghapus/menonaktifkan owner terakhir atau diri sendiri.
- [ ] Response API user tidak memuat password hash.

## OUTPUT

Pertanyaan (jika perlu, maks 3) -> Fitur A -> Fitur B -> Fitur C, masing-masing: Rencana -> Patch -> Cara tes.

---

## Catatan Penggunaan (tidak perlu disalin ke AI)

- **Backup dulu:** buat branch git baru atau snapshot database Neon (fitur branching) sebelum menjalankan prompt, karena ada tambahan kolom di tabel existing.
- **Kerjakan per fitur:** jika AI mulai melebar, kirim prompt yang sama tetapi hanya untuk satu fitur beserta aturan lintas fitur. Urutan terbaik: **C (user) -> A (transaksi) -> B (booking)**, karena B bergantung pada A.
- **Jawab dulu pertanyaan klarifikasi AI**, terutama soal di mana angka "dibayar" disimpan sekarang. Ini keputusan yang paling menentukan konsistensi data.
- Jika AI tidak punya akses repo, tempelkan skema tabel `bookings`, `transactions`/finance, `users`, serta middleware auth-nya saja.
