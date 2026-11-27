# PRD: Perbaikan UI Admin (Burger Mobile dan Scroll Sidebar)

**Produk:** Jadiphoto.Moment (Admin Panel)
**Cakupan:** 2 perbaikan UI pada layout bersama admin
**Dasar:** hasil pembacaan kode (`public/admin/*.html`, `public/js/admin-nav.js`, `public/css/admin-theme.css`). Nomor baris adalah **jangkar awal** dan bisa bergeser; verifikasi dengan `grep -n`.
**Sifat:** independen, tidak bergantung pada fitur lain.

---

## 1. Ringkasan Masalah

| # | Masalah | Dampak |
|---|---|---|
| 1 | Tombol burger (menu) di mobile tidak bisa diklik (`body > div.md:pl-72... > header > div:nth-child(1) > button > span`) | Menu admin tidak bisa dibuka di HP/tablet |
| 2 | Sidebar tidak bisa di-scroll | Item menu bagian bawah dan tombol **Keluar** terpotong di layar pendek/mobile |

## 2. Tujuan

1. Burger berfungsi di semua lebar layar di bawah 1024px, pada **semua** halaman admin.
2. Drawer dapat dibuka dan ditutup dengan konsisten (tombol, X, backdrop, Esc, klik menu).
3. Sidebar tetap bisa dipakai penuh pada layar pendek: menu dapat di-scroll, logo dan tombol Keluar tetap terlihat.
4. Tidak ada regresi pada tampilan desktop dan tema terang/gelap.

### Non-Goals
- Redesain visual sidebar atau header.
- Perubahan isi/urutan menu, atau perubahan logika hak akses menu.
- Perubahan pada konten halaman selain header dan sidebar.

---

## 3. Bug 1: Burger Mobile Tidak Bisa Diklik

### 3.1 Akar masalah (terkonfirmasi dari kode)

1. **Handler inline tidak cocok dengan CSS drawer.** Burger memakai `onclick="document.getElementById('sidebar').classList.remove('-translate-x-full')"` (contoh `public/admin/bookings.html` ~655). Namun `public/css/admin-theme.css` (~289-306, layar < 1024px) memaksa:
   `#sidebar:not(.sidebar-open):not([data-open="true"]) { transform: translateX(-100%) !important }`.
   Menghapus kelas Tailwind tidak berpengaruh, sehingga sidebar tetap tersembunyi dan klik tampak "tidak bekerja".
2. **Burger tidak terikat ke controller.** `public/js/admin-nav.js` (~355) hanya mengikat `[data-sidebar-toggle]`, `#btn-open-sidebar`, `#btn-hamburger`, atau `button[aria-label="Buka Menu"]`. Burger di header tidak memiliki satupun.
3. **Tombol tutup (X) juga rusak.** Inline `classList.add('-translate-x-full')` tidak menghapus `.sidebar-open`, sehingga drawer yang dibuka lewat controller tidak tertutup lewat X (backdrop dan `overflow-hidden` bisa tertinggal). Controller hanya mengikat `[data-sidebar-close]` atau `aria-label="Tutup menu"`.
4. **Breakpoint tidak seragam.** Markup memakai `md:` (768px): burger `md:hidden`, konten `md:pl-72`, sidebar `md:translate-x-0`. CSS drawer berlaku di bawah **1024px**. Pada **768-1023px**: burger hilang, sidebar tersembunyi, tetapi konten tetap diberi padding kiri 288px. Menu tidak bisa dibuka sama sekali.
5. **Area sentuh kecil.** Tombol hanya berisi ikon 24px tanpa padding.
6. **Pola tersalin di banyak halaman:** `bookings`, `categories`, `dashboard`, `finance`, `sessions`, `shortlinks`, `terms`, `wa-templates`. Periksa juga halaman lain dengan `grep -L 'data-sidebar-toggle' public/admin/*.html`.

### 3.2 Perbaikan

**Markup (semua halaman admin; dikerjakan lewat satu skrip penggantian yang idempotent, bukan edit manual):**
- **Burger:** hapus `onclick` inline. Tambahkan `type="button" data-sidebar-toggle aria-label="Buka menu" aria-controls="sidebar" aria-expanded="false"`. Ganti `md:hidden` menjadi `lg:hidden`. Beri area sentuh `inline-flex items-center justify-center w-11 h-11 -ml-2 rounded-lg`.
- **Tombol X di sidebar:** hapus `onclick` inline. Tambahkan `type="button" data-sidebar-close aria-label="Tutup menu"`. Ganti `md:hidden` menjadi `lg:hidden`.
- **Konten utama:** `md:pl-72` menjadi `lg:pl-72`.
- **`<aside id="sidebar">`:** `md:translate-x-0` menjadi `lg:translate-x-0`.

**`public/js/admin-nav.js` (fungsi `initSidebarDrawer`, ~318-400):**
- Gunakan **event delegation** pada `document` (`closest('[data-sidebar-toggle]')` dan `closest('[data-sidebar-close]')`) agar tidak bergantung pada urutan load atau elemen yang belum ada.
- Sinkronkan `aria-expanded` pada burger saat buka/tutup.
- Tutup drawer saat link menu diklik di layar < 1024px.
- Saat viewport menjadi >= 1024px (`matchMedia`/`resize`): tutup drawer dan hapus `overflow-hidden` dari `body`.
- Pertahankan perilaku yang sudah ada: Esc, klik backdrop.
- Pastikan `initSidebarDrawer()` benar-benar dipanggil di semua halaman.

### 3.3 Acceptance Criteria (Bug 1)

1. Lebar 390px, 768px, dan 1000px: ketuk burger membuka drawer; backdrop muncul; scroll halaman di belakang terkunci.
2. Tombol X, klik backdrop, tombol Esc, dan klik link menu menutup drawer; backdrop hilang dan scroll pulih.
3. Lebar >= 1024px: sidebar menetap, burger tidak tampak, tidak ada padding kosong ganda.
4. Lebar 768-1023px: burger tampil dan berfungsi; konten tidak memiliki padding kiri 288px.
5. Area sentuh burger minimal 44x44px; fokus keyboard terlihat; `aria-expanded` berubah.
6. Berlaku di **semua** halaman admin; `grep -rn "classList.remove('-translate-x-full')" public/admin/*.html` menghasilkan kosong.

---

## 4. Bug 2: Sidebar Perlu Scroll

### 4.1 Akar masalah

- `#sidebar` adalah kolom tetap setinggi layar (`fixed ... h-full flex flex-col`; di CSS `height: 100vh !important`).
- Daftar menu `<nav class="flex-1 px-md space-y-2">` (mis. `bookings.html` ~565) **tidak memiliki `overflow`**.
- Item menu sudah belasan (Dashboard, Booking, Persetujuan, Sesi Sortir, Keuangan, Manajemen Staff, Monitoring Staff, Audit Log, Kategori, Template WA, Term & Condition, Shortlink, dan menu baru ke depan), sehingga pada layar pendek item terpotong dan **Keluar** tidak terjangkau.
- Di mobile, `100vh` lebih tinggi dari area yang terlihat (bilah browser), sehingga bagian bawah sidebar tertutup.

### 4.2 Perbaikan (terpusat di `public/css/admin-theme.css`, tanpa mengedit tiap halaman)

- Tinggi sidebar memakai `100dvh` dengan fallback `100vh` pada kedua media query yang ada (~270-306).
- Susun `#sidebar` sebagai kolom flex. Bagian atas (logo, kartu pengguna) dan bagian bawah (Keluar) `flex-shrink: 0`.
- `#sidebar nav`: `flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;`.
- Footer sidebar: garis pemisah dan `padding-bottom: env(safe-area-inset-bottom)`.
- Scrollbar tipis dan senada tema (`scrollbar-width: thin`, warna `outline-variant`).
- `admin-nav.js`: saat halaman dimuat, `scrollIntoView({ block: 'nearest' })` pada item menu aktif agar tidak tersembunyi di bagian bawah.
- Jangan mengubah lebar atau offset konten.

### 4.3 Acceptance Criteria (Bug 2)

1. Tinggi viewport 500px dengan 14 item menu: area menu bisa di-scroll; logo dan tombol Keluar selalu terlihat.
2. Menu aktif terlihat tanpa scroll manual saat halaman dibuka.
3. Scroll di dalam sidebar tidak menggulir halaman di belakangnya.
4. Di mobile, bagian bawah sidebar tidak tertutup bilah browser.
5. Tidak ada regresi tampilan desktop dan tema terang/gelap.

---

## 5. Matriks Pengujian

| Lebar | Tinggi | Yang diuji |
|---|---|---|
| 390px | 700px dan 500px | Burger, drawer, scroll menu, tombol Keluar, backdrop |
| 768px | 900px | Burger tampil, tidak ada padding kiri ganda |
| 1000px | 700px | Drawer berfungsi, konten penuh |
| 1440px | 900px | Sidebar menetap, tanpa burger, scroll menu bila tinggi kurang |

Halaman minimal: `dashboard`, `bookings`, `finance`, `terms`. Lalu cek cepat halaman lain dengan perintah `grep`.

## 6. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Ada halaman admin dengan markup berbeda | Cari dengan `grep -L 'data-sidebar-toggle' public/admin/*.html`, terapkan pola sama |
| Skrip penggantian merusak markup | Skrip idempotent, lapor jumlah penggantian per file, review `git diff --stat` sebelum commit |
| Perubahan `md:` ke `lg:` mengubah tampilan tablet | Uji eksplisit di 768 dan 1000px |
| Event ganda (handler inline dan delegation) | Hapus semua `onclick` inline terkait sidebar |

## 7. Urutan Pengerjaan

1. Audit cepat (daftar halaman yang terdampak).
2. Skrip penggantian markup.
3. `admin-nav.js` (delegation dan sinkronisasi state).
4. CSS scroll sidebar.
5. Pengujian matriks Bagian 5, lalu commit.
