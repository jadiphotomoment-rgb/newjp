# Prompt AI: Perbaikan Tagihan Terpusat + Cara Menjalankan Hemat Token

File ini berisi panduan dan spesifikasi eksekusi per fase untuk perbaikan tagihan terpusat (Single Source of Truth), dirancang untuk meminimalkan konsumsi context window / token.

---

## BAGIAN 1: PROMPT PELUNCUR (salin ke coding assistant, ganti `N` dengan nomor fase)

```
Kerjakan FASE N dari perbaikan tagihan terpusat.
Baca HANYA: PRD-Billing-Terpusat.md (Bagian 3, 4, dan baris fase N di Bagian 9) + spesifikasi Fase N di PROMPT-Billing-Terpusat.md (Bagian 2).
Jangan buka file besar utuh (routes/bookings.js 86KB, public/admin/bookings.html 153KB): pakai `grep -n` lalu `sed -n 'A,Bp'` pada jangkar baris di PRD (nomor baris bisa bergeser).
Jangan scan repo. Jangan baca ulang file yang sudah dibaca di sesi ini. Branch: fix/billing-terpusat. Jangan push/merge/deploy.
Output hanya: rencana maks 5 baris -> diff minimal -> hasil tes -> "Fase N selesai, lanjut?". Tanpa penjelasan panjang.
Bila ada konflik antara PRD dan kode, tanya SATU kali, jangan menebak. Commit per fase.
```

---

## BAGIAN 2: SPESIFIKASI PER FASE

**Aturan umum (semua fase):** Node/Express, PostgreSQL, Vanilla JS. Uang = integer rupiah. Query berparameter. Multi-tabel dalam 1 transaction dengan `FOR UPDATE` pada baris booking. Reuse helper audit (`services/audit.js`), middleware auth, dan gaya yang ada. Tanpa library baru, tanpa refactor di luar scope. Migrasi (jika ada) idempotent dan tidak dijalankan ke produksi.

### FASE 0: Audit (tanpa ubah kode, maks 15 baris laporan)
Jawab, lalu berhenti:
1. Apakah entri `financial_entries` dengan `sumber_tipe='booking_adjustment'` hanya dibuat oleh edit jumlah dibayar (`bookings.js` sekitar baris 1073-1100)? Ada `sumber_tipe` lain yang berasal dari baris `payments` yang sama (misal di `services/bookingApproval.js` sekitar 283-290)? Risiko hitung ganda?
2. Kolom dan constraint `payments` (`database.js` ~204) dan `pelunasan` (~289): apakah ada `version`, `updated_by`, CHECK pada `payment_type`/`status`?
3. Cara tes dijalankan (`package.json` scripts, pola `tests/*.test.js`, perlu DB apa?).
4. Daftar semua titik tulis pembayaran (INSERT/UPDATE/DELETE pada `payments`, `bookings.paid_amount`, `pelunasan` nominal): file dan baris aktual.

### FASE 1: Modul `services/billing.js` + tes
- Implementasikan `computeBilling(q, bookingId)`, `syncBilling(client, bookingId, userId)`, `setPaidAmount(client, bookingId, targetPaid, userId)` persis sesuai algoritma PRD Bagian 4 dan aturan status Bagian 6.
- `q` boleh pool atau client transaksi. `syncBilling` dan `setPaidAmount` hanya menerima client dalam transaksi aktif (dilarang membuka transaksi sendiri) dan melakukan lock booking.
- Catat audit memakai helper yang ada (aksi `billing.sync`, `billing.set_paid`).
- Tes (ikuti pola tes yang ada): skenario PRD Bagian 10 nomor 1-4, 6, serta `package_price` kosong dan penurunan dibayar.
- Belum mengubah route apa pun.

### FASE 2: Pasang `syncBilling` di titik tulis
- Ganti isi `handlePatchPaidAmount` dengan `setPaidAmount` (validasi tetap: tidak negatif, tidak melebihi total, owner only, cek `version`).
- Tambahkan `syncBilling` di akhir transaksi: approve DP (`bookings.js` ~1401 dan `services/bookingApproval.js`), verifikasi pelunasan (`pelunasan.js` verify), hapus payment (`finance.js` ~338), perubahan harga/DP (`set-price`, PUT booking, `approvals.js`).
- Verifikasi pelunasan: nominal INSERT `payments` = sisa live dari `computeBilling` dalam transaksi yang sama (bukan `tagihan.sisa_kekurangan`); tolak 409 bila sisa live <= 0.
- Tes: skenario PRD nomor 2, 3, 5, 6, 7.

### FASE 3: Pembacaan, halaman klien, WA, admin
- `GET /api/pelunasan/token/:token` dan `send-wa`: hitung dengan `computeBilling` saat dipanggil; hasil `total_tagihan`, `dp_terbayar`, `sisa_kekurangan` berasal dari sana. `POST /api/pelunasan`: DP/dibayar dari `computeBilling`.
- List/detail booking (`bookings.js` ~536-549, ~643): hilangkan `GREATEST(...)`, pakai `paid_amount` cache (sudah tersinkron) atau `computeBilling`.
- Detail booking mengembalikan objek `billing` (total, paid, sisa, kelebihan, status_bayar, rincian, riwayat).
- Frontend: `admin-pelunasan.js` (~701-714, ~732-760) dan `public/pelunasan.html` (~620-634) memakai nilai dari API. Tambah blok "Rincian Tagihan" di detail booking admin + tombol "Hitung Ulang" (owner) ke `POST /api/admin/bookings/:id/billing/resync`.
- Status 403 untuk non-owner pada resync. Escape teks yang dirender.
- Tes: skenario PRD nomor 1-4 melalui endpoint.

### FASE 4: Skrip reconcile
- `scripts/billing-reconcile.js`: default **dry-run** (hanya cetak tabel: booking id, paid_amount cache, paid ledger, selisih, snapshot tagihan, kategori selisih). `--apply` hanya memperbaiki yang dapat diturunkan (cache `paid_amount` basi, snapshot `pelunasan` aktif basi) lewat `syncBilling`. Kasus ledger 0 padahal cache/status menunjukkan sudah bayar -> `NEEDS_REVIEW`, tidak diubah.
- Jangan jalankan terhadap database produksi. Beri perintah dan jelaskan cara membuat snapshot Neon dulu.

### FASE 5: Pembersihan
- Hapus sisa `GREATEST(paid_amount, ...)`, perhitungan sisa/dibayar di luar `services/billing.js`, dan dead code terkait.
- Jalankan seluruh tes yang ada; laporkan regresi. Update `README`/`MAP.md` satu paragraf tentang `services/billing.js`.

**Checklist akhir (lapor pass/fail singkat):** acceptance criteria PRD Bagian 10 nomor 1-10.

---

## BAGIAN 3: TIPS HEMAT TOKEN (untuk kamu, tidak perlu disalin)

1. **Satu fase = satu sesi.** Jalankan `/clear` di Claude Code antar fase agar konteks fase sebelumnya tidak ikut terbawa. Hasil fase sebelumnya sudah tersimpan di kode dan commit.
2. **Jangkar baris sudah ada di PRD.** AI tidak perlu mencari dari nol. Ini penghemat terbesar karena file `bookings.js` dan `bookings.html` sangat besar.
3. **Jangan minta penjelasan.** Prompt peluncur sudah membatasi output ke rencana, diff, dan hasil tes.
4. **Kerjakan Fase 0 dulu** (murah, hanya membaca). Jawabannya memastikan asumsi hitung ganda sebelum menulis kode.
5. **Jalankan tes yang relevan saja** (satu file tes), bukan seluruh suite, sampai Fase 5.
6. **Jika AI melenceng**, hentikan lalu ketik koreksi singkat ("Fase 2 saja, jangan ubah frontend") alih-alih mengulang prompt panjang.
7. **Pakai `/compact`** hanya bila satu fase sangat panjang; untuk fase pendek `/clear` lebih hemat.
8. **Backup:** snapshot/branch Neon sebelum menjalankan skrip reconcile mode apply atau migrasi apa pun.
9. **Urutan fase tidak boleh dilompati:** Fase 2 bergantung pada modul Fase 1, dan Fase 3 pada Fase 2.
10. Bila AI tidak punya akses repo, tempelkan hanya: `handlePatchPaidAmount`, handler `verify` dan `POST` pelunasan, skema `payments`/`pelunasan`/`financial_entries`.

