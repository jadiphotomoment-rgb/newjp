'use strict';

/**
 * public/js/admin-pelunasan.js
 * Modul terisolasi untuk Manajemen Pelunasan & Soft Delete Booking (Fase 4).
 * Di-load oleh public/admin/bookings.html.
 */

(function () {
  // ── Helper: Format Rupiah ──────────────────────────────────────
  function fmtRp(n) {
    return Number(n || 0).toLocaleString('id-ID');
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(str) {
    if (str == null) return '';
    return String(str).replace(/"/g, '&quot;');
  }

  // ── Toast fallback jika global toast belum ada ─────────────────
  function showToast(msg, type = 'info') {
    if (typeof window.toast === 'function') {
      window.toast(msg, type);
    } else {
      alert(msg);
    }
  }

  // ── Auth token & header ─────────────────────────────────────────
  function getHeaders() {
    const t = window.TOKEN || localStorage.getItem('sf_token') || '';
    return {
      'Authorization': `Bearer ${t}`,
      'Content-Type': 'application/json'
    };
  }

  // ── Injeksi Modal ke DOM secara otomatis ────────────────────────
  function ensureModalsInDOM() {
    if (document.getElementById('modal-tagih-pelunasan')) return;

    const modalContainer = document.createElement('div');
    modalContainer.id = 'pelunasan-modals-root';
    modalContainer.style.cssText = 'position: relative; z-index: 99999;';
    modalContainer.innerHTML = `
      <!-- Modal: Buat Tagihan Pelunasan -->
      <div id="modal-tagih-pelunasan" style="display:none; position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.75); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);"
        onclick="if(event.target === this) window.AdminPelunasan.closeTagihModal()"
        class="pelunasan-modal-overlay fixed inset-0 items-center justify-center p-4">
        <div class="pelunasan-modal-card bg-surface-container-lowest border border-outline-variant/40 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200"
          style="background-color: var(--color-surface-container-lowest, #1a2030); box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.8); border: 1px solid rgba(255, 255, 255, 0.15); max-height: 90vh; display: flex; flex-direction: column;">
          <div class="p-5 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0"
            style="background-color: var(--color-surface-container-low, #1e2538);">
            <div class="flex items-center gap-2.5">
              <div class="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center font-bold">
                <span class="material-symbols-outlined text-[24px]">payments</span>
              </div>
              <div>
                <h3 class="font-headline-sm text-on-surface font-bold text-base m-0 text-white">Kirim Tagihan Pelunasan</h3>
                <p class="text-xs text-on-surface-variant m-0">Buat link unik & tagih sisa pembayaran klien</p>
              </div>
            </div>
            <button type="button" onclick="window.AdminPelunasan.closeTagihModal()"
              class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors">
              <span class="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          <form id="form-tagih-pelunasan" onsubmit="window.AdminPelunasan.submitTagihForm(event)" class="p-6 space-y-4 overflow-y-auto flex-1">
            <input type="hidden" id="tagih-booking-id" value="">

            <!-- Ringkasan Klien -->
            <div class="rounded-xl p-3.5 flex justify-between items-center text-xs"
              style="background-color: rgba(30, 37, 56, 0.7); border: 1px solid rgba(255, 255, 255, 0.1);">
              <div>
                <div class="font-bold text-white text-sm" id="tagih-client-name">—</div>
                <div class="text-on-surface-variant" id="tagih-client-info">—</div>
              </div>
              <span class="badge badge-confirmed" id="tagih-package-badge">Paket</span>
            </div>

            <!-- Total Tagihan -->
            <div>
              <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                Total Tagihan Keseluruhan (Rp) *
              </label>
              <div class="relative">
                <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-on-surface-variant">Rp</span>
                <input type="number" id="tagih-total-input" min="1000" step="1000" required
                  style="background-color: var(--color-surface-container, #232c40); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.2);"
                  class="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm font-semibold focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="0">
              </div>
              <p class="text-[11px] text-on-surface-variant mt-1">Otomatis dari harga paket, sesuaikan bila ada tambahan cetak/diskon.</p>
            </div>

            <!-- Rincian Kalkulasi: DP vs Sisa -->
            <div class="grid grid-cols-2 gap-3 p-3.5 rounded-xl"
              style="background-color: var(--color-surface-container, #232c40); border: 1px solid rgba(255, 255, 255, 0.12);">
              <div>
                <div class="text-[11px] text-on-surface-variant font-medium">DP Terbayar (Aktual)</div>
                <div class="text-sm font-bold text-emerald-400 mt-0.5" id="tagih-dp-display">Rp 0</div>
                <div class="text-[10px] text-on-surface-variant/80">Pembayaran DP approved</div>
              </div>
              <div class="text-right">
                <div class="text-[11px] text-on-surface-variant font-medium">Sisa Kekurangan</div>
                <div class="text-base font-extrabold text-primary mt-0.5" id="tagih-sisa-display">Rp 0</div>
                <div class="text-[10px] text-on-surface-variant/80">Total — DP Terbayar</div>
              </div>
            </div>

            <div id="tagih-sisa-warning" style="display:none;" class="p-3 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px]">warning</span>
              <span>Perhatian: Sisa tagihan kurang dari atau sama dengan 0.</span>
            </div>

            <!-- Catatan Tagihan -->
            <div>
              <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                Catatan Tagihan (Opsional)
              </label>
              <textarea id="tagih-catatan-input" rows="2"
                style="background-color: var(--color-surface-container, #232c40); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15);"
                placeholder="Contoh: Termasuk tambahan cetak 10R + frame minimalis"
                class="w-full px-3.5 py-2.5 rounded-xl text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"></textarea>
              <p class="text-[11px] text-on-surface-variant mt-1">Catatan ini akan tampil di halaman pelunasan klien.</p>
            </div>

            <!-- Opsi Kirim WhatsApp -->
            <div class="p-3 rounded-xl flex items-center gap-3"
              style="background-color: rgba(30, 37, 56, 0.6); border: 1px solid rgba(255, 255, 255, 0.1);">
              <input type="checkbox" id="tagih-send-wa" checked
                class="w-4 h-4 rounded text-primary focus:ring-primary bg-surface-container border-outline-variant">
              <label for="tagih-send-wa" class="text-xs text-on-surface font-medium cursor-pointer">
                Kirim detail & link pelunasan langsung ke WhatsApp klien sekarang
              </label>
            </div>

            <!-- Tombol Aksi -->
            <div class="flex justify-end gap-2.5 pt-3 border-t border-outline-variant/30 sticky bottom-0 bg-surface-container-lowest"
              style="background-color: var(--color-surface-container-lowest, #1a2030);">
              <button type="button" onclick="window.AdminPelunasan.closeTagihModal()"
                class="btn btn-outline px-4 py-2 text-sm">
                Batal
              </button>
              <button type="submit" id="btn-submit-tagihan"
                style="background: linear-gradient(135deg, #6366f1, #818cf8); color: #ffffff; font-weight: 600; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);"
                class="btn px-5 py-2 text-sm flex items-center gap-2 border-none">
                <span class="material-symbols-outlined text-[18px]">send</span>
                <span>Buat & Kirim Tagihan</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Modal: Tolak Bukti Bayar Pelunasan -->
      <div id="modal-reject-pelunasan" style="display:none; position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.75); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);"
        onclick="if(event.target === this) window.AdminPelunasan.closeRejectModal()"
        class="pelunasan-modal-overlay fixed inset-0 items-center justify-center p-4">
        <div class="pelunasan-modal-card bg-surface-container-lowest border border-outline-variant/40 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200"
          style="background-color: var(--color-surface-container-lowest, #1a2030); box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.8); border: 1px solid rgba(255, 255, 255, 0.15); max-height: 90vh; display: flex; flex-direction: column;">
          <div class="p-5 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0"
            style="background-color: var(--color-surface-container-low, #1e2538);">
            <div class="flex items-center gap-2.5 text-error">
              <span class="material-symbols-outlined text-[24px]">cancel</span>
              <div>
                <h3 class="font-headline-sm text-on-surface font-bold text-base m-0 text-white">Tolak Bukti Bayar</h3>
                <p class="text-xs text-on-surface-variant m-0">Klien akan diminta upload ulang</p>
              </div>
            </div>
            <button type="button" onclick="window.AdminPelunasan.closeRejectModal()"
              class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors">
              <span class="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          <form id="form-reject-pelunasan" onsubmit="window.AdminPelunasan.submitRejectForm(event)" class="p-6 space-y-4 overflow-y-auto flex-1">
            <input type="hidden" id="reject-tagihan-id" value="">
            <input type="hidden" id="reject-booking-id" value="">

            <p class="text-xs text-on-surface-variant leading-relaxed">
              Silakan tuliskan alasan penolakan. Alasan ini akan dikirimkan otomatis ke WhatsApp klien beserta link pelunasan untuk mengupload bukti baru.
            </p>

            <!-- Quick reason chips -->
            <div>
              <div class="text-[11px] font-semibold text-on-surface-variant mb-1.5 uppercase tracking-wider">Pilih Alasan Cepat:</div>
              <div class="flex flex-wrap gap-1.5">
                <button type="button" onclick="window.AdminPelunasan.setQuickReject('Nominal transfer tidak sesuai dengan sisa tagihan')"
                  class="px-2.5 py-1 rounded-lg text-xs bg-surface-container hover:bg-surface-container-high border border-outline-variant/40 text-on-surface-variant transition-colors">
                  Nominal kurang
                </button>
                <button type="button" onclick="window.AdminPelunasan.setQuickReject('Foto bukti transfer tidak terbaca / buram')"
                  class="px-2.5 py-1 rounded-lg text-xs bg-surface-container hover:bg-surface-container-high border border-outline-variant/40 text-on-surface-variant transition-colors">
                  Bukti buram
                </button>
                <button type="button" onclick="window.AdminPelunasan.setQuickReject('Dana belum masuk ke rekening kami, mohon cek kembali status transfer')"
                  class="px-2.5 py-1 rounded-lg text-xs bg-surface-container hover:bg-surface-container-high border border-outline-variant/40 text-on-surface-variant transition-colors">
                  Dana belum masuk
                </button>
                <button type="button" onclick="window.AdminPelunasan.setQuickReject('Nama pemilik rekening atau nomor rekening tujuan tidak sesuai')"
                  class="px-2.5 py-1 rounded-lg text-xs bg-surface-container hover:bg-surface-container-high border border-outline-variant/40 text-on-surface-variant transition-colors">
                  Salah rekening
                </button>
              </div>
            </div>

            <div>
              <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                Alasan Penolakan *
              </label>
              <textarea id="reject-reason-input" rows="3" required
                style="background-color: var(--color-surface-container, #232c40); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15);"
                placeholder="Tulis alasan jelas mengapa bukti transfer ditolak..."
                class="w-full px-3.5 py-2.5 rounded-xl text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-error focus:ring-1 focus:ring-error"></textarea>
            </div>

            <div class="flex justify-end gap-2.5 pt-3 border-t border-outline-variant/30 sticky bottom-0 bg-surface-container-lowest"
              style="background-color: var(--color-surface-container-lowest, #1a2030);">
              <button type="button" onclick="window.AdminPelunasan.closeRejectModal()"
                class="btn btn-outline px-4 py-2 text-sm">
                Batal
              </button>
              <button type="submit" id="btn-submit-reject"
                class="btn btn-danger px-5 py-2 text-sm flex items-center gap-2">
                <span class="material-symbols-outlined text-[18px]">cancel</span>
                <span>Tolak & Kirim WA</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Modal: Preview Bukti Full-size -->
      <div id="modal-preview-pelunasan" style="display:none; position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.85); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);"
        onclick="if(event.target === this) window.AdminPelunasan.closePreviewModal()"
        class="pelunasan-modal-overlay fixed inset-0 items-center justify-center p-4">
        <div class="pelunasan-modal-card bg-surface-container-lowest border border-outline-variant/40 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
          style="background-color: var(--color-surface-container-lowest, #1a2030); box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.8); border: 1px solid rgba(255, 255, 255, 0.15);">
          <div class="p-4 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0"
            style="background-color: var(--color-surface-container-low, #1e2538);">
            <div class="flex items-center gap-2 text-on-surface font-semibold text-sm">
              <span class="material-symbols-outlined text-[20px] text-primary">receipt_long</span>
              <span id="preview-title" class="text-white">Bukti Transfer Pelunasan</span>
            </div>
            <div class="flex items-center gap-2">
              <a id="preview-open-link" href="#" target="_blank"
                class="btn btn-outline btn-sm px-3 py-1 text-xs flex items-center gap-1">
                <span class="material-symbols-outlined text-[14px]">open_in_new</span>
                <span>Tab Baru</span>
              </a>
              <button type="button" onclick="window.AdminPelunasan.closePreviewModal()"
                class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors">
                <span class="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
          </div>
          <div class="p-4 flex-1 overflow-auto flex items-center justify-center bg-black/40" id="preview-body">
            <img id="preview-img" src="" alt="Bukti Transfer" class="max-h-[70vh] max-w-full object-contain rounded-lg shadow-xl">
          </div>
        </div>
      </div>

      <!-- Modal: Tambah Booking Manual -->
      <div id="modal-create-booking" style="display:none; position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.75); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);"
        onclick="if(event.target === this) window.AdminPelunasan.closeCreateBookingModal()"
        class="pelunasan-modal-overlay fixed inset-0 items-center justify-center p-4">
        <div class="pelunasan-modal-card bg-surface-container-lowest border border-outline-variant/40 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[92vh]"
          style="background-color: var(--color-surface-container-lowest, #1a2030); box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.8); border: 1px solid rgba(255, 255, 255, 0.15);">
          <div class="p-5 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0"
            style="background-color: var(--color-surface-container-low, #1e2538);">
            <div class="flex items-center gap-2.5">
              <div class="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center font-bold">
                <span class="material-symbols-outlined text-[24px]">add_circle</span>
              </div>
              <div>
                <h3 class="font-headline-sm text-on-surface font-bold text-base m-0 text-white">Tambah Booking Manual</h3>
                <p class="text-xs text-on-surface-variant m-0">Input booking klien dari chat, telepon, atau walk-in</p>
              </div>
            </div>
            <button type="button" onclick="window.AdminPelunasan.closeCreateBookingModal()"
              class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors">
              <span class="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          <form id="form-create-booking" onsubmit="window.AdminPelunasan.submitCreateBookingForm(event)" class="p-6 space-y-4 overflow-y-auto flex-1">

            <!-- Kategori -->
            <div>
              <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                Kategori Booking *
              </label>
              <select id="new-booking-category" required
                class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm font-semibold text-on-surface focus:outline-none focus:border-primary">
                <option value="">Pilih Kategori...</option>
              </select>
            </div>

            <!-- Nama & WA -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Nama Klien *
                </label>
                <input type="text" id="new-booking-client-name" required placeholder="Contoh: Rina Suryani"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
              </div>
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  No. WhatsApp *
                </label>
                <input type="tel" id="new-booking-client-phone" required placeholder="08xxxxxxxxxx"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
              </div>
            </div>

            <!-- Tanggal & Jam -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Tanggal Acara *
                </label>
                <input type="date" id="new-booking-event-date" required
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
              </div>
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Jam Mulai (Opsional)
                </label>
                <input type="time" id="new-booking-event-time"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
              </div>
            </div>

            <!-- Lokasi -->
            <div>
              <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                Lokasi / Venue (Opsional)
              </label>
              <input type="text" id="new-booking-location" placeholder="Studio Jadiphoto / Hotel / Alamat Klien"
                class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
            </div>

            <!-- Harga Paket & DP -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Harga Paket (Rp)
                </label>
                <input type="number" id="new-booking-price" min="0" step="1000" placeholder="0"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
              </div>
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Biaya DP / Booking (Rp)
                </label>
                <input type="number" id="new-booking-dp" min="0" step="1000" placeholder="0"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
              </div>
            </div>

            <!-- Status Awal & Sumber Informasi -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Status Awal
                </label>
                <select id="new-booking-status"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
                  <option value="confirmed" selected>Dikonfirmasi (confirmed)</option>
                  <option value="pending_dp">Menunggu DP (pending_dp)</option>
                  <option value="lunas">Langsung Lunas (lunas)</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5">
                  Sumber Informasi
                </label>
                <select id="new-booking-source"
                  class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
                  <option value="">— Tidak Diisi —</option>
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                  <option value="google">Google Search</option>
                  <option value="referral">Rekomendasi teman/keluarga</option>
                  <option value="event">Event / Pameran</option>
                  <option value="lainnya">Lainnya</option>
                </select>
              </div>
            </div>

            <!-- Detail Sumber Informasi -->
            <div id="new-booking-source-detail-wrap" style="display:none;">
              <label class="block text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-1.5" id="new-booking-source-detail-label">
                Keterangan Sumber
              </label>
              <input type="text" id="new-booking-source-detail" placeholder="Nama perekomendasi atau keterangan lainnya"
                class="w-full px-3.5 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:border-primary">
            </div>

            <div class="flex justify-end gap-2.5 pt-4 border-t border-outline-variant/30 sticky bottom-0 bg-surface-container-lowest">
              <button type="button" onclick="window.AdminPelunasan.closeCreateBookingModal()"
                class="btn btn-outline px-4 py-2 text-sm">
                Batal
              </button>
              <button type="submit" id="btn-submit-new-booking"
                class="btn btn-primary px-5 py-2 text-sm flex items-center gap-2">
                <span class="material-symbols-outlined text-[18px]">add_circle</span>
                <span>Simpan Booking</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(modalContainer);

    // Event listener untuk auto kalkulasi sisa saat total tagihan diketik
    const totalInput = document.getElementById('tagih-total-input');
    if (totalInput) {
      totalInput.addEventListener('input', () => {
        window.AdminPelunasan.recalculateSisa();
      });
    }

    // Event listener untuk toggle detail sumber informasi
    const sourceSelect = document.getElementById('new-booking-source');
    if (sourceSelect) {
      sourceSelect.addEventListener('change', () => {
        const wrap = document.getElementById('new-booking-source-detail-wrap');
        const label = document.getElementById('new-booking-source-detail-label');
        const input = document.getElementById('new-booking-source-detail');
        if (!wrap) return;
        if (sourceSelect.value === 'referral') {
          wrap.style.display = 'block';
          if (label) label.textContent = 'Nama Perekomendasi *';
          if (input) input.placeholder = 'Contoh: Teman kampus (Annisa)';
        } else if (sourceSelect.value === 'lainnya') {
          wrap.style.display = 'block';
          if (label) label.textContent = 'Keterangan Sumber Informasi *';
          if (input) input.placeholder = 'Contoh: Spanduk bazar / Brosur';
        } else {
          wrap.style.display = 'none';
        }
      });
    }
  }

  // ── Objek Utama AdminPelunasan ──────────────────────────────────
  window.AdminPelunasan = {
    currentBooking: null,
    _escapeAttached: false,

    init() {
      ensureModalsInDOM();
      if (!this._escapeAttached) {
        this._escapeAttached = true;
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            window.AdminPelunasan.closeTagihModal();
            window.AdminPelunasan.closeRejectModal();
            window.AdminPelunasan.closePreviewModal();
            window.AdminPelunasan.closeCreateBookingModal();
          }
        });
      }
    },

    // ── Build HTML Section Pelunasan untuk Detail Panel ───────────
    renderSection(booking) {
      this.init();
      this.currentBooking = booking;

      // Hitung DP terbayar (aktual dari payments approved tipe dp)
      const approvedDp = (booking.payments || [])
        .filter(p => p.status === 'approved' && p.payment_type === 'dp')
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);

      const pkgPrice = Number(booking.package_price || 0);
      const estimasiSisa = Math.max(0, pkgPrice - approvedDp);

      const tagihanList = booking.pelunasan || [];
      const hasActiveTagihan = tagihanList.some(t => ['sent', 'menunggu_verifikasi'].includes(t.status));
      const hasLunas = tagihanList.some(t => t.status === 'lunas') || booking.status === 'lunas';

      let tagihanHtml = '';
      if (tagihanList.length === 0) {
        tagihanHtml = `
          <div class="bg-surface-container-low/60 border border-outline-variant/30 rounded-xl p-4 text-center">
            <span class="material-symbols-outlined text-[32px] text-on-surface-variant/50 mb-1">receipt</span>
            <p class="text-xs text-on-surface-variant mb-3">Belum ada tagihan pelunasan yang dibuat untuk booking ini.</p>
            ${booking.status !== 'cancelled' ? `
              <button class="btn btn-primary btn-sm w-full justify-center flex items-center gap-1.5"
                onclick="window.AdminPelunasan.openTagihModal(${booking.id})">
                <span class="material-symbols-outlined text-[16px]">payments</span>
                <span>Tagih Pelunasan (Sisa Rp ${fmtRp(estimasiSisa)})</span>
              </button>
            ` : ''}
          </div>
        `;
      } else {
        tagihanHtml = tagihanList.map(t => {
          const isLunas = t.status === 'lunas';
          const isReview = t.status === 'menunggu_verifikasi';
          const isRejected = t.status === 'rejected';
          const isSent = t.status === 'sent';
          const isCancelled = t.status === 'cancelled';

          const clientUrl = `${location.origin}/pelunasan?token=${t.token || ''}`;

          let statusBadge = '';
          if (isLunas) statusBadge = '<span class="badge badge-lunas">✅ Lunas</span>';
          else if (isReview) statusBadge = '<span class="badge badge-pelunasan_review animate-pulse">⏳ Menunggu Verifikasi</span>';
          else if (isRejected) statusBadge = '<span class="badge badge-cancelled">❌ Bukti Ditolak</span>';
          else if (isSent) statusBadge = '<span class="badge badge-menunggu_pelunasan">📨 Tagihan Terkirim</span>';
          else if (isCancelled) statusBadge = '<span class="badge badge-cancelled">Dibatalkan</span>';

          return `
            <div class="bg-surface-container-low border border-outline-variant/40 rounded-xl p-4 mb-3 shadow-sm">
              <div class="flex justify-between items-start mb-2.5">
                <div>
                  <div class="text-[11px] text-on-surface-variant font-medium">Tagihan #${t.id} · ${fmtDate(t.created_at)}</div>
                  <div class="text-base font-extrabold text-on-surface">Rp ${fmtRp(t.sisa_kekurangan)}</div>
                </div>
                ${statusBadge}
              </div>

              <div class="text-xs text-on-surface-variant space-y-1 mb-3 pt-2 border-t border-outline-variant/20">
                <div class="flex justify-between">
                  <span>Total Tagihan:</span>
                  <span class="font-semibold text-on-surface">Rp ${fmtRp(t.total_tagihan)}</span>
                </div>
                <div class="flex justify-between">
                  <span>DP Terbayar:</span>
                  <span class="font-semibold text-emerald-400">Rp ${fmtRp(t.dp_terbayar)}</span>
                </div>
                ${t.catatan ? `
                  <div class="mt-2 p-2 bg-surface-container rounded text-[11px] text-on-surface italic">
                    "${escHtml(t.catatan)}"
                  </div>
                ` : ''}
              </div>

              ${isRejected && t.reject_reason ? `
                <div class="p-2.5 bg-error/10 border border-error/30 rounded-lg text-xs text-error font-medium mb-3">
                  <strong>Alasan ditolak:</strong> ${escHtml(t.reject_reason)}
                </div>
              ` : ''}

              <!-- Bukti Transfer (jika ada) -->
              ${t.bukti_file_url ? (() => {
                const secureUrl = '/api/upload/private/pelunasan/' + t.id + '?token=' + (window.TOKEN || localStorage.getItem('sf_token'));
                const isPdf = ((t.bukti_filename || t.bukti_file_url || '').toLowerCase()).includes('.pdf');
                return `
                <div class="mb-3 p-3 bg-surface-container rounded-xl border border-outline-variant/30">
                  <div class="text-[11px] font-semibold text-on-surface-variant uppercase tracking-wider mb-2 flex items-center justify-between">
                    <span>Bukti Pelunasan</span>
                    ${t.paid_at ? `<span class="text-[10px] text-on-surface-variant lowercase">${fmtDate(t.paid_at)}</span>` : ''}
                  </div>
                  <div class="flex items-center gap-3">
                    ${isPdf ? `
                      <a href="${escAttr(secureUrl)}" target="_blank"
                        class="btn btn-outline btn-sm text-xs flex items-center gap-1.5 text-primary">
                        <span class="material-symbols-outlined text-[16px]">picture_as_pdf</span>
                        <span>Buka Bukti Pelunasan (PDF)</span>
                      </a>
                    ` : `
                      <img src="${escAttr(secureUrl)}" alt="Bukti Pelunasan"
                        onclick="window.AdminPelunasan.previewBukti('${escAttr(secureUrl)}')"
                        class="w-16 h-16 object-cover rounded-lg border border-outline-variant/40 cursor-pointer hover:opacity-80 transition-opacity bg-black/10">
                      <div class="flex flex-col gap-1">
                        <button type="button" class="btn btn-outline btn-sm text-xs py-1 px-2.5"
                          onclick="window.AdminPelunasan.previewBukti('${escAttr(secureUrl)}')">
                          <span class="material-symbols-outlined text-[14px]">zoom_in</span> Lihat Bukti Pelunasan
                        </button>
                      </div>
                    `}
                  </div>
                </div>`;
              })() : ''}

              <!-- Tombol Aksi Verifikasi / Approval -->
              ${isReview ? `
                <div class="flex flex-col gap-2 pt-2 border-t border-outline-variant/30">
                  <button class="btn btn-primary btn-sm justify-center w-full py-2 font-semibold shadow-sm"
                    onclick="window.AdminPelunasan.approvePelunasan(${t.id}, ${booking.id})">
                    <span class="material-symbols-outlined text-[18px]">verified</span>
                    <span>Approve Pelunasan & Set Lunas</span>
                  </button>
                  <button class="btn btn-danger btn-sm justify-center w-full py-2 font-semibold"
                    onclick="window.AdminPelunasan.openRejectModal(${t.id}, ${booking.id})">
                    <span class="material-symbols-outlined text-[18px]">cancel</span>
                    <span>Tolak Bukti & Minta Upload Ulang</span>
                  </button>
                </div>
              ` : ''}

              <!-- Tombol Operasional Tagihan Belum Lunas -->
              ${(isSent || isRejected) ? `
                <div class="flex flex-wrap gap-2 pt-2 border-t border-outline-variant/20">
                  <button class="btn btn-outline btn-sm text-xs flex-1 justify-center"
                    onclick="window.AdminPelunasan.copyLink('${escAttr(t.token || '')}')">
                    <span class="material-symbols-outlined text-[14px]">content_copy</span>
                    <span>Salin Link</span>
                  </button>
                  <button class="btn btn-outline btn-sm text-xs flex-1 justify-center text-[#25D366] border-[#25D366]/30 bg-[#25D366]/5 hover:bg-[#25D366]/10"
                    onclick="window.AdminPelunasan.resendWA(${t.id})">
                    <span class="material-symbols-outlined text-[14px]">send</span>
                    <span>Kirim WA</span>
                  </button>
                  <button class="btn btn-outline btn-sm text-xs text-error border-error/30 hover:bg-error/10"
                    onclick="window.AdminPelunasan.cancelTagihan(${t.id}, ${booking.id})" title="Batalkan Tagihan">
                    <span class="material-symbols-outlined text-[14px]">delete</span>
                  </button>
                </div>
              ` : ''}

              ${isLunas ? `
                <div class="pt-2 border-t border-outline-variant/20 flex justify-between items-center text-xs">
                  <span class="text-emerald-400 font-semibold flex items-center gap-1">
                    <span class="material-symbols-outlined text-[16px]">check_circle</span>
                    Pemasukan tercatat di Finance
                  </span>
                  <a href="${clientUrl}" target="_blank" class="text-primary hover:underline text-[11px]">
                    Buka Halaman 🔗
                  </a>
                </div>
              ` : ''}
            </div>
          `;
        }).join('');

        // Jika belum lunas dan tidak ada tagihan aktif menunggu verifikasi, sediakan opsi tambah tagihan
        if (!hasLunas && !hasActiveTagihan && booking.status !== 'cancelled') {
          tagihanHtml += `
            <button class="btn btn-outline btn-sm w-full justify-center mt-2 flex items-center gap-1.5 border-dashed"
              onclick="window.AdminPelunasan.openTagihModal(${booking.id})">
              <span class="material-symbols-outlined text-[16px]">add_circle</span>
              <span>Buat Tagihan Baru</span>
            </button>
          `;
        }
      }

      // Gabungkan dengan Danger Actions (Soft Delete)
      return `
        <div class="bg-surface-container-lowest border border-outline-variant/30 p-4 rounded-lg mt-3">
          <div class="detail-section-title flex justify-between items-center">
            <span>💰 Pelunasan & Tagihan</span>
            ${hasLunas ? '<span class="badge badge-lunas text-[11px]">LUNAS</span>' : ''}
          </div>
          ${tagihanHtml}
        </div>

        <!-- Opsi Soft Delete Booking -->
        <div class="border-t border-outline-variant/30 pt-4 mt-4">
          <button type="button" class="btn btn-outline btn-sm text-error border-error/30 hover:bg-error/10 w-full justify-center flex items-center gap-1.5"
            onclick="window.AdminPelunasan.softDeleteBooking(${booking.id}, '${escAttr(booking.client_name)}')">
            <span class="material-symbols-outlined text-[16px]">delete_forever</span>
            <span>Batalkan & Arsipkan Booking (Soft Delete)</span>
          </button>
          <p class="text-[10px] text-on-surface-variant/70 text-center mt-1">Data riwayat pembayaran DP/pelunasan tidak akan dihapus.</p>
        </div>
      `;
    },

    // ── Open Tagih Modal ──────────────────────────────────────────
    openTagihModal(bookingId) {
      this.init();
      const b = this.currentBooking && this.currentBooking.id == bookingId
        ? this.currentBooking
        : window.currentBookingData;

      if (!b) {
        showToast('Data booking tidak ditemukan', 'error');
        return;
      }

      const approvedDp = (b.payments || [])
        .filter(p => p.status === 'approved' && p.payment_type === 'dp')
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);

      const pkgPrice = Number(b.package_price || 0);

      document.getElementById('tagih-booking-id').value = b.id;
      document.getElementById('tagih-client-name').textContent = b.client_name;
      document.getElementById('tagih-client-info').textContent = `${b.client_phone} · ${fmtDate(b.event_date)}`;
      document.getElementById('tagih-package-badge').textContent = b.package_name || b.category_name || 'Paket';

      // Prefill total dengan package_price jika ada
      document.getElementById('tagih-total-input').value = pkgPrice || '';
      document.getElementById('tagih-dp-display').textContent = `Rp ${fmtRp(approvedDp)}`;
      document.getElementById('tagih-catatan-input').value = '';
      document.getElementById('tagih-send-wa').checked = true;

      this.recalculateSisa();

      const modal = document.getElementById('modal-tagih-pelunasan');
      if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '99999';
      }
    },

    closeTagihModal() {
      const modal = document.getElementById('modal-tagih-pelunasan');
      if (modal) modal.style.display = 'none';
    },

    recalculateSisa() {
      const b = this.currentBooking || window.currentBookingData;
      const approvedDp = b ? (b.payments || [])
        .filter(p => p.status === 'approved' && p.payment_type === 'dp')
        .reduce((sum, p) => sum + Number(p.amount || 0), 0) : 0;

      const totalVal = Number(document.getElementById('tagih-total-input')?.value || 0);
      const sisa = totalVal - approvedDp;

      const sisaEl = document.getElementById('tagih-sisa-display');
      const warnEl = document.getElementById('tagih-sisa-warning');

      if (sisaEl) {
        sisaEl.textContent = `Rp ${fmtRp(sisa)}`;
        if (sisa <= 0) {
          sisaEl.className = 'text-base font-extrabold text-error mt-0.5';
          if (warnEl) warnEl.style.display = 'flex';
        } else {
          sisaEl.className = 'text-base font-extrabold text-primary mt-0.5';
          if (warnEl) warnEl.style.display = 'none';
        }
      }
    },

    // ── Submit Tagihan Baru ───────────────────────────────────────
    async submitTagihForm(e) {
      e.preventDefault();
      const bookingId = document.getElementById('tagih-booking-id').value;
      const totalTagihan = document.getElementById('tagih-total-input').value;
      const catatan = document.getElementById('tagih-catatan-input').value;
      const sendWa = document.getElementById('tagih-send-wa').checked;

      const btn = document.getElementById('btn-submit-tagihan');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner w-4 h-4 border-2 mr-2"></span> Memproses...';

      try {
        const res = await fetch('/api/pelunasan', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            booking_id: bookingId,
            total_tagihan: totalTagihan,
            catatan: catatan
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Gagal membuat tagihan');
        }

        const tagihan = data.tagihan;
        showToast('Tagihan pelunasan berhasil dibuat!', 'success');

        // Jika opsi kirim WA dicentang
        if (sendWa && tagihan && tagihan.id) {
          try {
            await fetch(`/api/pelunasan/${tagihan.id}/send-wa`, {
              method: 'POST',
              headers: getHeaders()
            });
            showToast('Pesan WhatsApp tagihan berhasil dikirim ke klien!', 'success');
          } catch (_) {
            showToast('Tagihan tersimpan, namun WA gagal terkirim.', 'info');
          }
        }

        this.closeTagihModal();

        // Refresh panel booking dan daftar booking
        if (typeof window.openPanel === 'function') {
          window.openPanel(bookingId);
        }
        if (typeof window.loadBookings === 'function') {
          window.loadBookings();
        }
      } catch (err) {
        showToast(err.message || 'Terjadi kesalahan sistem', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    },

    // ── Approve Pelunasan ─────────────────────────────────────────
    async approvePelunasan(tagihanId, bookingId) {
      if (!confirm('Approve pembayaran pelunasan ini?\n\nBooking akan ditandai LUNAS dan pemasukan otomatis tercatat di modul Keuangan.')) {
        return;
      }

      try {
        const res = await fetch(`/api/pelunasan/${tagihanId}/verify`, {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ action: 'approve' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal approve pelunasan');

        showToast('✅ Pelunasan berhasil diverifikasi! Status booking LUNAS.', 'success');

        if (typeof window.openPanel === 'function') window.openPanel(bookingId);
        if (typeof window.loadBookings === 'function') window.loadBookings();
      } catch (err) {
        showToast(err.message || 'Gagal memproses verifikasi', 'error');
      }
    },

    // ── Open Reject Modal ─────────────────────────────────────────
    openRejectModal(tagihanId, bookingId) {
      this.init();
      document.getElementById('reject-tagihan-id').value = tagihanId;
      document.getElementById('reject-booking-id').value = bookingId;
      document.getElementById('reject-reason-input').value = '';

      const modal = document.getElementById('modal-reject-pelunasan');
      if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '99999';
      }
    },

    closeRejectModal() {
      const modal = document.getElementById('modal-reject-pelunasan');
      if (modal) modal.style.display = 'none';
    },

    setQuickReject(reason) {
      const input = document.getElementById('reject-reason-input');
      if (input) input.value = reason;
    },

    async submitRejectForm(e) {
      e.preventDefault();
      const tagihanId = document.getElementById('reject-tagihan-id').value;
      const bookingId = document.getElementById('reject-booking-id').value;
      const reason = document.getElementById('reject-reason-input').value.trim();

      if (!reason) {
        showToast('Alasan penolakan wajib diisi', 'error');
        return;
      }

      const btn = document.getElementById('btn-submit-reject');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner w-4 h-4 border-2 mr-2"></span> Mengirim...';

      try {
        const res = await fetch(`/api/pelunasan/${tagihanId}/verify`, {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ action: 'reject', reason })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menolak bukti bayar');

        showToast('Bukti ditolak. Pesan WA dan link upload ulang terkirim ke klien.', 'info');
        this.closeRejectModal();

        if (typeof window.openPanel === 'function') window.openPanel(bookingId);
        if (typeof window.loadBookings === 'function') window.loadBookings();
      } catch (err) {
        showToast(err.message || 'Gagal memproses penolakan', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    },

    // ── Batalkan Tagihan ──────────────────────────────────────────
    async cancelTagihan(tagihanId, bookingId) {
      if (!confirm('Batalkan tagihan pelunasan ini?\nLink pembayaran klien akan dinonaktifkan.')) {
        return;
      }

      try {
        const res = await fetch(`/api/pelunasan/${tagihanId}/cancel`, {
          method: 'PATCH',
          headers: getHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal membatalkan tagihan');

        showToast('Tagihan berhasil dibatalkan', 'info');
        if (typeof window.openPanel === 'function') window.openPanel(bookingId);
        if (typeof window.loadBookings === 'function') window.loadBookings();
      } catch (err) {
        showToast(err.message || 'Gagal membatalkan', 'error');
      }
    },

    // ── Resend WhatsApp ───────────────────────────────────────────
    async resendWA(tagihanId) {
      if (!confirm('Kirim ulang rincian tagihan ke WhatsApp klien sekarang?')) return;
      try {
        const res = await fetch(`/api/pelunasan/${tagihanId}/send-wa`, {
          method: 'POST',
          headers: getHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal mengirim WA');
        showToast('Pesan tagihan berhasil dikirim ke WhatsApp klien!', 'success');
      } catch (err) {
        showToast(err.message || 'Gagal menghubungi WhatsApp gateway', 'error');
      }
    },

    // ── Copy Pelunasan Link ───────────────────────────────────────
    copyLink(token) {
      if (!token) {
        showToast('Token link tidak tersedia', 'error');
        return;
      }
      const url = `${location.origin}/pelunasan?token=${token}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('🔗 Link pelunasan berhasil disalin!', 'success');
      }).catch(() => {
        prompt('Salin link pelunasan ini:', url);
      });
    },

    // ── Preview Bukti Bayar ───────────────────────────────────────
    previewBukti(url) {
      this.init();
      const modal = document.getElementById('modal-preview-pelunasan');
      const img = document.getElementById('preview-img');
      const link = document.getElementById('preview-open-link');

      if (img) img.src = url;
      if (link) link.href = url;
      if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '99999';
      }
    },

    closePreviewModal() {
      const modal = document.getElementById('modal-preview-pelunasan');
      if (modal) modal.style.display = 'none';
    },

    // ── Soft Delete Booking ───────────────────────────────────────
    async softDeleteBooking(bookingId, clientName) {
      const promptText = `Apakah Anda yakin ingin membatalkan & mengarsipkan booking #${bookingId} (${clientName || 'Klien'})?\n\n• Status booking akan menjadi dibatalkan.\n• Data booking disembunyikan dari daftar utama.\n• Riwayat pembayaran DP dan pelunasan tetap aman tersimpan.`;
      if (!confirm(promptText)) return;

      try {
        const res = await fetch(`/api/bookings/admin/${bookingId}`, {
          method: 'DELETE',
          headers: getHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menghapus booking');

        showToast('Booking berhasil dibatalkan dan diarsipkan (soft delete)', 'success');

        if (typeof window.closePanel === 'function') window.closePanel();
        if (typeof window.loadBookings === 'function') window.loadBookings();
        if (window.calendar) window.calendar.refetchEvents();
      } catch (err) {
        showToast(err.message || 'Gagal melakukan soft delete', 'error');
      }
    },

    // ── Create Booking Manual ─────────────────────────────────────
    async openCreateBookingModal() {
      this.init();
      const sel = document.getElementById('new-booking-category');
      if (sel && sel.options.length <= 1) {
        try {
          const res = await fetch('/api/bookings/categories');
          const cats = await res.json();
          sel.innerHTML = '<option value="">Pilih Kategori...</option>' + cats.map(c =>
            `<option value="${c.id}">${escHtml(c.name)}</option>`
          ).join('');
        } catch (_) {}
      }

      const today = new Date().toISOString().slice(0, 10);
      const dateInput = document.getElementById('new-booking-event-date');
      if (dateInput && !dateInput.value) dateInput.value = today;

      const modal = document.getElementById('modal-create-booking');
      if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '99999';
      }
    },

    closeCreateBookingModal() {
      const modal = document.getElementById('modal-create-booking');
      if (modal) modal.style.display = 'none';
    },

    async submitCreateBookingForm(e) {
      e.preventDefault();
      const category_id = document.getElementById('new-booking-category').value;
      const client_name = document.getElementById('new-booking-client-name').value.trim();
      const client_phone = document.getElementById('new-booking-client-phone').value.trim();
      const event_date = document.getElementById('new-booking-event-date').value;
      const event_time = document.getElementById('new-booking-event-time').value || null;
      const location = document.getElementById('new-booking-location').value.trim() || null;
      const package_price = document.getElementById('new-booking-price').value || null;
      const dp_amount = document.getElementById('new-booking-dp').value || null;
      const status = document.getElementById('new-booking-status').value || 'confirmed';
      const sumber_informasi = document.getElementById('new-booking-source').value || null;
      const sumber_informasi_detail = document.getElementById('new-booking-source-detail').value.trim() || null;

      if (!category_id || !client_name || !client_phone || !event_date) {
        showToast('Kategori, nama klien, WhatsApp, dan tanggal wajib diisi', 'error');
        return;
      }

      const btn = document.getElementById('btn-submit-new-booking');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner w-4 h-4 border-2 mr-2"></span> Menyimpan...';

      try {
        const res = await fetch('/api/bookings/admin/create', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            category_id,
            client_name,
            client_phone,
            event_date,
            event_time,
            location,
            package_price,
            dp_amount,
            status,
            sumber_informasi,
            sumber_informasi_detail
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menyimpan booking');

        showToast('✅ Booking baru berhasil ditambahkan!', 'success');
        document.getElementById('form-create-booking').reset();
        this.closeCreateBookingModal();

        if (typeof window.loadBookings === 'function') window.loadBookings();
        if (window.calendar) window.calendar.refetchEvents();
      } catch (err) {
        showToast(err.message || 'Terjadi kesalahan sistem', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }
  };

  // Inisialisasi saat script dimuat
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.AdminPelunasan.init());
  } else {
    window.AdminPelunasan.init();
  }
})();
