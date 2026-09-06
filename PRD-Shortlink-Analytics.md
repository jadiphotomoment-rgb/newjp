# PRD: Fitur Shortlink dengan Analitik Pengunjung

**Versi:** 1.0
**Tanggal:** 2 September 2026
**Status:** Draft

---

## 1. Latar Belakang & Masalah

Saat ini, saat membagikan link eksternal (misalnya link produk, artikel, campaign marketing), kita tidak punya cara untuk:
- Membuat link tersebut lebih ringkas dan mudah dibagikan
- Mengetahui siapa saja yang mengklik link tersebut
- Memahami karakteristik audiens (lokasi, perangkat, waktu akses) yang berinteraksi dengan link kita

Tanpa data ini, sulit untuk mengukur efektivitas distribusi link dan memahami audiens.

## 2. Tujuan Produk

Membangun fitur **shortlink** yang mengubah link panjang menjadi link pendek, sekaligus mencatat dan menyajikan data analitik dari setiap klik yang terjadi pada link tersebut.

## 3. Target Pengguna

- Individu/tim yang membagikan link secara rutin (marketing, content creator, sales)
- Pengguna yang butuh insight sederhana tentang siapa yang mengakses link mereka

## 4. Lingkup Fitur (Scope)

### 4.1 Pembuatan Shortlink
- Pengguna memasukkan URL asli (link eksternal)
- Sistem menghasilkan link pendek unik (contoh: `domain.id/xY3kP`)
- Opsional: pengguna bisa custom slug/alias (contoh: `domain.id/promo-agustus`)
- Link pendek redirect otomatis ke URL asli saat diklik

### 4.2 Manajemen Link
- Daftar semua shortlink yang pernah dibuat oleh pengguna
- Melihat, mengedit alias, atau menonaktifkan/menghapus link
- Menyalin link dengan satu klik

### 4.3 Analitik Klik
Setiap kali link diklik, sistem mencatat data berikut:

| Data | Keterangan |
|---|---|
| Total klik | Jumlah klik keseluruhan & tren dari waktu ke waktu |
| Lokasi geografis | Negara/kota pengunjung (berdasarkan IP) |
| Perangkat | Mobile / Desktop / Tablet |
| Sistem operasi & browser | Android, iOS, Windows, macOS, Chrome, Safari, dll |
| Sumber referral | Dari mana pengunjung datang (medsos, website lain, direct) |
| Waktu akses | Tanggal & jam klik, untuk melihat pola waktu ramai |

### 4.4 Dashboard Analitik
- Tampilan ringkas per link: grafik tren klik harian/mingguan
- Breakdown demografi dalam bentuk chart (pie/bar) untuk lokasi, perangkat, browser
- Filter berdasarkan rentang tanggal

## 5. Di Luar Lingkup (Out of Scope) — versi awal
- Custom domain milik pengguna sendiri
- A/B testing pada tujuan redirect
- Integrasi UTM builder otomatis
- Ekspor data ke pihak ketiga (CRM, dsb.)
- Proteksi link dengan password

## 6. Alur Pengguna (User Flow)

1. Pengguna login/masuk ke aplikasi
2. Tempel URL panjang → klik "Buat Shortlink"
3. Sistem menampilkan link pendek yang siap dibagikan
4. Pengguna membagikan link tersebut ke audiens
5. Setiap klik masuk otomatis tercatat di sistem
6. Pengguna membuka dashboard untuk melihat statistik & demografi

## 7. Metrik Keberhasilan

- Jumlah shortlink yang dibuat per pengguna per minggu
- Tingkat retensi pengguna yang kembali membuka dashboard analitik
- Waktu redirect link < 300ms (tidak mengganggu pengalaman pengguna)
- Akurasi deteksi lokasi & perangkat > 90%

## 8. Pertimbangan Teknis (Ringkas)

- **Redirect service**: perlu performa tinggi & latensi rendah
- **Geolokasi**: menggunakan IP lookup (dengan kesadaran privasi — hanya level kota/negara, bukan alamat presisi)
- **Penyimpanan data klik**: perlu database yang bisa menangani volume tulis tinggi (write-heavy)
- **Privasi & kepatuhan**: data yang dikumpulkan harus anonim/agregat, sesuai regulasi perlindungan data yang berlaku (misalnya UU PDP)

## 9. Risiko & Catatan

- Penyalahgunaan shortlink untuk phishing/spam → perlu validasi URL tujuan
- Akurasi data lokasi berbasis IP punya batas (VPN, proxy bisa memengaruhi hasil)
- Perlu kebijakan retensi data yang jelas (berapa lama data klik disimpan)

## 10. Roadmap Singkat (Contoh)

| Fase | Fitur |
|---|---|
| Fase 1 (MVP) | Buat shortlink, redirect, total klik dasar |
| Fase 2 | Dashboard analitik (lokasi, perangkat, browser) |
| Fase 3 | Custom alias, manajemen link lanjutan |
| Fase 4 | Ekspor data, integrasi lanjutan |

---

*Dokumen ini adalah draft awal dan dapat disesuaikan berdasarkan diskusi lebih lanjut dengan tim.*
