# PRD: Upload File Menggunakan Vercel Blob

## 1. Konteks
Aplikasi web booking layanan fotografi yang di-deploy di Vercel membutuhkan fitur upload file (contoh: foto referensi klien, bukti pembayaran, hasil foto dari fotografer). Fitur ini akan menggunakan **Vercel Blob Storage** sebagai layanan penyimpanan file.

## 2. Tujuan
- Menyediakan mekanisme upload file yang aman, cepat, dan scalable.
- Menyimpan file di Vercel Blob, bukan di server/local storage (karena Vercel bersifat serverless & ephemeral).
- Menyimpan metadata file (URL, nama, tipe, ukuran, relasi ke booking/user) di database aplikasi.

## 3. Cakupan Fitur (Scope)

### 3.1 Jenis Upload
| Jenis File | Diupload Oleh | Contoh Kegunaan |
|---|---|---|
| Foto referensi | Client (saat booking) | Referensi gaya foto yang diinginkan |
| Bukti pembayaran | Client | Konfirmasi pembayaran DP/pelunasan |
| Hasil foto | Admin/Fotografer | Delivery hasil foto ke client |
| Foto profil/portofolio | Fotografer | Ditampilkan di halaman publik |

### 3.2 Batasan Teknis
- Tipe file yang diizinkan: `.jpg`, `.jpeg`, `.png`, `.webp`, `.pdf` (untuk bukti pembayaran).
- Ukuran maksimal per file: 5MB.
- Maksimal jumlah file per sesi upload: sesuai kebutuhan (contoh: 5 file untuk referensi foto).

## 4. Alur Proses (Flow)

1. **Client-side**: User memilih file dari perangkat melalui form upload.
2. **Request Upload Token/URL**:
   - Frontend memanggil API route di backend (`/api/upload`) untuk meminta izin/token upload.
   - Backend menggunakan Vercel Blob SDK (`@vercel/blob`) untuk generate **client upload token** (menggunakan pola `handleUpload` dari Vercel Blob agar file langsung diupload dari browser ke Blob storage, tidak lewat server — mengurangi beban server & lebih cepat).
3. **Upload Langsung ke Blob**:
   - File diupload langsung dari browser ke Vercel Blob menggunakan token tersebut (metode `upload()` dari `@vercel/blob/client`).
   - Vercel Blob mengembalikan URL publik/privat file setelah upload selesai.
4. **Simpan Metadata**:
   - Setelah upload sukses, frontend mengirim URL hasil upload beserta metadata (booking ID, user ID, jenis file) ke API backend.
   - Backend menyimpan metadata ini ke database (tabel `attachments` atau serupa).
5. **Validasi & Keamanan**:
   - Validasi tipe file dan ukuran dilakukan di sisi server saat generate token (bukan hanya di client).
   - Pastikan hanya user yang terautentikasi yang bisa request upload token.
   - Gunakan `onUploadCompleted` callback (webhook dari Vercel Blob) untuk konfirmasi tambahan di sisi server (opsional, untuk keamanan ekstra).

## 5. Struktur Data (Metadata di Database)

Tabel `attachments`:
| Field | Tipe | Keterangan |
|---|---|---|
| id | UUID | Primary key |
| booking_id | UUID (nullable) | Relasi ke booking terkait |
| user_id | UUID | User yang upload |
| file_url | String | URL dari Vercel Blob |
| file_name | String | Nama asli file |
| file_type | String | Kategori: reference/payment_proof/result/portfolio |
| file_size | Integer | Ukuran file (bytes) |
| created_at | Timestamp | Waktu upload |

## 6. Environment Variable yang Dibutuhkan
- `BLOB_READ_WRITE_TOKEN` — token akses Vercel Blob (didapat otomatis saat mengaktifkan Blob storage di project Vercel).

## 7. Non-Functional Requirements
- Upload harus tetap berfungsi meski file besar (gunakan direct-to-blob upload, bukan lewat server, untuk hindari limit body size serverless function).
- Response error yang jelas jika tipe/ukuran file tidak valid.
- File privat (misal bukti pembayaran) sebaiknya menggunakan akses `private` atau signed URL, bukan `public`, jika Vercel Blob mendukungnya untuk plan yang digunakan.

## 8. Kriteria Sukses (Acceptance Criteria)
- [ ] User bisa upload file dari form tanpa error untuk tipe & ukuran yang valid.
- [ ] File tersimpan di Vercel Blob dan URL dapat diakses/ditampilkan kembali di UI.
- [ ] Metadata file tersimpan dengan benar dan terhubung ke booking/user yang sesuai.
- [ ] Upload file mendekati batas maksimal (5MB) tidak menyebabkan timeout server.
- [ ] Validasi tipe & ukuran file berjalan baik di client maupun server.

## 9. Catatan Implementasi untuk AI
- Gunakan package resmi `@vercel/blob`.
- Gunakan pola **client-side direct upload** (`handleUpload` di API route + `upload()` di client) sebagai pendekatan utama, bukan upload lewat server (`put()` di server) kecuali untuk file kecil/kasus khusus.
- Referensi dokumentasi resmi: https://vercel.com/docs/storage/vercel-blob
