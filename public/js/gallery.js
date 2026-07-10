/* ============================================================
   GALLERY — JavaScript v3
   Features: lazy loading, selection limit, lightbox, submit
   ============================================================ */
'use strict';

// ── Parse URL params ─────────────────────────────────────────────
const params      = new URLSearchParams(location.search);
const sessionUuid = params.get('session');

// ── State ────────────────────────────────────────────────────────
let sessionData   = null;
let allFiles      = [];
let selectedFiles = new Map(); // fileId → { id, name }
let photoLimit    = 10;

// ── DOM refs ─────────────────────────────────────────────────────
const stateLoading  = document.getElementById('state-loading');
const stateError    = document.getElementById('state-error');
const stateExpired  = document.getElementById('state-expired');
const stateSuccess  = document.getElementById('state-success');
const galleryPage   = document.getElementById('gallery-page');
const galleryGrid   = document.getElementById('gallery-grid');
const btnSubmit     = document.getElementById('btn-submit');
const btnSubmitText = document.getElementById('btn-submit-text');
const btnSubmitSpin = document.getElementById('btn-submit-spinner');
const sentinel      = document.getElementById('load-more-sentinel');
const lightbox      = document.getElementById('lightbox');
const lightboxImg   = document.getElementById('lightbox-img');
const lightboxName  = document.getElementById('lightbox-name');
const toastContainer = document.getElementById('toast-container');

// ── Show/hide states ─────────────────────────────────────────────
function showState(name) {
  stateLoading.style.display  = 'none';
  stateError.style.display    = 'none';
  stateExpired.style.display  = 'none';
  stateSuccess.style.display  = 'none';
  galleryPage.style.display   = 'none';

  if (name === 'loading') stateLoading.style.display  = '';
  if (name === 'error')   stateError.style.display    = '';
  if (name === 'expired') stateExpired.style.display  = '';
  if (name === 'success') stateSuccess.style.display  = '';
  if (name === 'gallery') galleryPage.style.display   = '';
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success:'✅', error:'❌', info:'ℹ️' };
  toast.innerHTML = `<span aria-hidden="true">${icons[type]||'📢'}</span><span>${msg}</span>`;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 4000);
}

// ── Show error state ──────────────────────────────────────────────
function showError(msg, hints = []) {
  showState('error');
  document.getElementById('error-msg').textContent = msg;
  const hintsEl = document.getElementById('error-hints');
  if (hints.length) {
    hintsEl.innerHTML = hints.map(h => `<li>${h}</li>`).join('');
    hintsEl.style.display = '';
  } else {
    hintsEl.style.display = 'none';
  }
}

// ── Update quota UI ───────────────────────────────────────────────
function updateQuotaUI() {
  const count = selectedFiles.size;
  const pct   = photoLimit > 0 ? Math.min(100, (count / photoLimit) * 100) : 0;

  document.getElementById('hdr-selected').textContent = count;
  document.getElementById('hdr-limit').textContent    = photoLimit;
  document.getElementById('ftr-selected').textContent = count;

  const fill = document.getElementById('quota-fill');
  fill.style.width = `${pct}%`;
  fill.classList.toggle('full', count >= photoLimit);

  const remaining = photoLimit - count;
  document.getElementById('ftr-limit-info').textContent =
    count >= photoLimit ? ' (limit tercapai!)' : ` (sisa ${remaining})`;

  btnSubmit.disabled = (count === 0);
  btnSubmitText.textContent = count > 0 ? `Kirim ${count} Foto` : 'Kirim Pilihan';

  allFiles.forEach(file => {
    const card = document.getElementById(`card-${file.id}`);
    if (!card) return;
    const isSelected = selectedFiles.has(file.id);
    const isLocked   = !isSelected && count >= photoLimit;
    card.classList.toggle('selected', isSelected);
    card.classList.toggle('locked', isLocked);
    card.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });
}

// ── Toggle file selection ─────────────────────────────────────────
function toggleSelect(file) {
  if (selectedFiles.has(file.id)) {
    selectedFiles.delete(file.id);
  } else {
    if (selectedFiles.size >= photoLimit) {
      showToast(`Batas ${photoLimit} foto sudah tercapai! Batalkan pilihan dulu.`, 'error');
      return;
    }
    selectedFiles.set(file.id, file);
  }
  updateQuotaUI();
}

// ── HTML escape helpers ───────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(str) { return String(str).replace(/"/g, '&quot;'); }

// ── Lazy load observer ────────────────────────────────────────────
const imgObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const img = entry.target;
    if (!img.dataset.src) return;
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
    imgObserver.unobserve(img);
  });
}, { rootMargin: '200px 0px' });

// ── Batch rendering ───────────────────────────────────────────────
const BATCH_SIZE = 24;
let renderIndex  = 0;

function renderNextBatch() {
  const batch = allFiles.slice(renderIndex, renderIndex + BATCH_SIZE);
  if (!batch.length) { batchObserver.disconnect(); return; }
  const frag = document.createDocumentFragment();
  batch.forEach(file => frag.appendChild(createPhotoCard(file)));
  galleryGrid.appendChild(frag);
  renderIndex += batch.length;
}

const batchObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) renderNextBatch();
}, { rootMargin: '400px' });

// ── Create photo card ──────────────────────────────────────────────
function createPhotoCard(file) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.id        = `card-${file.id}`;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-pressed', 'false');
  card.setAttribute('aria-label', `Pilih foto: ${file.name}`);

  card.innerHTML = `
    <img
      class="loading"
      data-src="${escAttr(file.thumbnailUrl)}"
      alt="${escAttr(file.name)}"
      loading="lazy"
      decoding="async"
    >
    <div class="skeleton" aria-hidden="true"></div>
    <div class="photo-overlay" aria-hidden="true">
      <span class="photo-name">${escHtml(file.name)}</span>
    </div>
    <div class="photo-check" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <button class="photo-expand" aria-label="Perbesar foto ${escAttr(file.name)}" tabindex="-1">⛶</button>
  `;

  const img = card.querySelector('img');

  img.addEventListener('load', () => {
    img.classList.add('loaded');
    img.classList.remove('loading');
  });
  img.addEventListener('error', () => {
    // Thumbnail proxy server gagal — tampilkan placeholder
    img.classList.add('error');
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%231a1a2e' width='200' height='200'/%3E%3Ctext x='100' y='95' text-anchor='middle' fill='%234a4870' font-size='32'%3E%F0%9F%93%B7%3C/text%3E%3Ctext x='100' y='125' text-anchor='middle' fill='%234a4870' font-size='11'%3EGagal muat%3C/text%3E%3C/svg%3E";
  });

  imgObserver.observe(img);

  card.addEventListener('click', (e) => {
    if (e.target.closest('.photo-expand')) return;
    if (card.classList.contains('locked')) {
      showToast(`Batas ${photoLimit} foto sudah tercapai.`, 'error');
      return;
    }
    toggleSelect(file);
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
  });

  card.querySelector('.photo-expand').addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(file);
  });

  return card;
}

// ── Lightbox ──────────────────────────────────────────────────────
function openLightbox(file) {
  lightboxName.textContent = file.name;
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Reset state dulu
  lightboxImg.classList.remove('lb-loading', 'lb-loaded');
  lightboxImg.alt = file.name;

  // Tampilkan thumbnail INSTAN (sudah ada di browser cache)
  lightboxImg.src = file.thumbnailUrl;
  lightboxImg.classList.add('lb-loading');  // blur = loading indicator
  lightbox.classList.add('lb-loading');     // tampilkan spinner

  // Preload full-res di background tanpa memblokir tampilan
  const hiRes = new Image();
  hiRes.src = file.fullUrl;
  hiRes.onload = () => {
    // Guard: pastikan lightbox masih open untuk foto yang sama
    if (lightbox.classList.contains('open') && lightboxImg.alt === file.name) {
      lightboxImg.src = file.fullUrl;
      lightboxImg.classList.remove('lb-loading');
      lightboxImg.classList.add('lb-loaded');
      lightbox.classList.remove('lb-loading'); // sembunyikan spinner
    }
  };
  hiRes.onerror = () => {
    // Gagal ambil full-res — tetap tampilkan thumbnail (tidak crash)
    if (lightboxImg.alt === file.name) {
      lightboxImg.classList.remove('lb-loading');
      lightboxImg.classList.add('lb-loaded');
      lightbox.classList.remove('lb-loading');
    }
  };
}

function closeLightbox() {
  lightbox.classList.remove('open', 'lb-loading');
  document.body.style.overflow = '';
  lightboxImg.src = '';
  lightboxImg.classList.remove('lb-loading', 'lb-loaded');
  lightboxImg.alt = 'Preview foto';
}

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox();
});

// ── Submit ────────────────────────────────────────────────────────
btnSubmit.addEventListener('click', () => {
  if (!selectedFiles.size) return;

  const selected = [...selectedFiles.values()];
  document.getElementById('confirm-desc').textContent =
    `Anda akan mengirim ${selected.length} foto ke fotografer. Setelah dikirim, pilihan tidak dapat diubah.`;

  const ol = document.getElementById('confirm-ol');
  ol.innerHTML = selected.map(f => `<li>${escHtml(f.name)}</li>`).join('');

  document.getElementById('modal-confirm-submit').classList.add('open');
});

document.getElementById('btn-cancel-submit').addEventListener('click', () => {
  document.getElementById('modal-confirm-submit').classList.remove('open');
});
document.getElementById('modal-submit-close').addEventListener('click', () => {
  document.getElementById('modal-confirm-submit').classList.remove('open');
});
document.getElementById('modal-confirm-submit').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-confirm-submit'))
    document.getElementById('modal-confirm-submit').classList.remove('open');
});

document.getElementById('btn-confirm-submit').addEventListener('click', async () => {
  const btnConfirm = document.getElementById('btn-confirm-submit');
  const btnText    = document.getElementById('btn-confirm-text');
  const spinner    = document.getElementById('btn-confirm-spinner');

  btnConfirm.disabled = true;
  btnText.textContent = 'Mengirim...';
  spinner.classList.remove('hidden');

  const selected = [...selectedFiles.values()];

  try {
    const res = await fetch('/api/notify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionUuid, selectedFiles: selected }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Gagal mengirim pilihan', 'error');
      btnConfirm.disabled = false;
      btnText.textContent = '✅ Ya, Kirim!';
      spinner.classList.add('hidden');
      return;
    }

    document.getElementById('modal-confirm-submit').classList.remove('open');
    document.getElementById('success-msg').textContent = data.message || 'Pilihan foto berhasil dikirim!';
    document.getElementById('success-ol').innerHTML = selected.map(f => `<li>${escHtml(f.name)}</li>`).join('');
    showState('success');

  } catch (err) {
    showToast('Koneksi gagal: ' + err.message, 'error');
    btnConfirm.disabled = false;
    btnText.textContent = '✅ Ya, Kirim!';
    spinner.classList.add('hidden');
  }
});

// ── Main init ─────────────────────────────────────────────────────
async function init() {
  if (!sessionUuid) {
    showError('Link tidak valid. Parameter session tidak ditemukan.');
    return;
  }

  showState('loading');
  document.getElementById('loading-msg').textContent = 'Memeriksa sesi...';

  // 1. Fetch session
  try {
    const res = await fetch(`/api/sessions/${sessionUuid}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error || 'Sesi tidak ditemukan.');
      return;
    }
    sessionData = await res.json();
  } catch (err) {
    showError('Tidak dapat terhubung ke server: ' + err.message);
    return;
  }

  // Check session status
  if (sessionData.status === 'expired') {
    showState('expired');
    return;
  }
  if (sessionData.status === 'completed') {
    document.getElementById('expired-title').textContent = '✓ Sudah Dikirim';
    document.getElementById('expired-msg').textContent   = 'Pilihan foto untuk sesi ini sudah pernah dikirim. Hubungi fotografer jika ada perubahan.';
    showState('expired');
    return;
  }

  photoLimit = sessionData.photo_limit;
  document.getElementById('hdr-client-name').textContent = sessionData.client_name;
  document.title = `Pilih Foto — ${sessionData.client_name}`;
  document.getElementById('hdr-limit').textContent = photoLimit;
  document.getElementById('hdr-limit-text').innerHTML = ` dari <span id="hdr-limit">${photoLimit}</span> foto`;

  // 2. Fetch Drive files
  document.getElementById('loading-msg').textContent = 'Memuat foto dari Google Drive...';

  try {
    const res  = await fetch(`/api/drive/files?session=${sessionUuid}`);
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Gagal memuat foto.', data.hint || []);
      return;
    }

    if (!data.files || !data.files.length) {
      showError('Tidak ada foto ditemukan di folder ini.', data.hint || []);
      return;
    }

    allFiles = data.files;

  } catch (err) {
    showError('Gagal memuat foto: ' + err.message);
    return;
  }

  // 3. Render gallery
  showState('gallery');
  updateQuotaUI();
  renderNextBatch();
  batchObserver.observe(sentinel);
}

// ── Boot ──────────────────────────────────────────────────────────
init();
