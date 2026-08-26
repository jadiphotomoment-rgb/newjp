/* ============================================================
   GALLERY — JavaScript v4
   Features: lazy loading, selection limit, lightbox,
             favorites/wishlist, photo notes, order tracker, submit
   ============================================================ */
'use strict';

// ── Parse URL params ─────────────────────────────────────────────
const params      = new URLSearchParams(location.search);
const sessionUuid = params.get('session');
const STORAGE_KEY_FAV = sessionUuid ? `sf_fav_${sessionUuid}` : null;
const STORAGE_KEY_SEL = sessionUuid ? `sf_sel_${sessionUuid}` : null;

// ── State ────────────────────────────────────────────────────────
let sessionData   = null;
let allFiles      = [];
let selectedFiles = new Map(); // fileId → { id, name, note }
let favorites     = new Set(); // fileId → favorited
let photoLimit    = 10;
let filterFav     = false;

// ── Load favorites dari localStorage ────────────────────────────
if (STORAGE_KEY_FAV) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_FAV) || '[]');
    favorites = new Set(saved);
  } catch (_) {}
}

// ── Load selectedFiles dari localStorage (persist antar refresh) ─
if (STORAGE_KEY_SEL) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_SEL) || '[]');
    // saved = array of { id, name, note }
    saved.forEach(entry => selectedFiles.set(entry.id, entry));
  } catch (_) {}
}

// ── Peringatan sebelum menutup/refresh halaman ───────────────────
window.addEventListener('beforeunload', (e) => {
  if (selectedFiles.size > 0) {
    e.preventDefault();
    // Teks ini mungkin tidak ditampilkan oleh browser modern, tapi event-nya cukup
    e.returnValue = 'Anda memiliki pilihan foto yang belum dikirim. Yakin ingin meninggalkan halaman?';
  }
});

// ── DOM refs ─────────────────────────────────────────────────────
const stateLoading   = document.getElementById('state-loading');
const stateError     = document.getElementById('state-error');
const stateExpired   = document.getElementById('state-expired');
const stateSuccess   = document.getElementById('state-success');
const stateTracker   = document.getElementById('state-tracker');
const galleryPage    = document.getElementById('gallery-page');
const galleryGrid    = document.getElementById('gallery-grid');
const btnSubmit      = document.getElementById('btn-submit');
const btnSubmitText  = document.getElementById('btn-submit-text');
const btnSubmitSpin  = document.getElementById('btn-submit-spinner');
const sentinel       = document.getElementById('load-more-sentinel');
const lightbox       = document.getElementById('lightbox');
const lightboxImg    = document.getElementById('lightbox-img');
const lightboxName   = document.getElementById('lightbox-name');
const toastContainer = document.getElementById('toast-container');

// ── Show/hide states ─────────────────────────────────────────────
function showState(name) {
  stateLoading.style.display  = 'none';
  stateError.style.display    = 'none';
  stateExpired.style.display  = 'none';
  stateSuccess.style.display  = 'none';
  galleryPage.style.display   = 'none';
  if (stateTracker) stateTracker.style.display = 'none';

  if (name === 'loading') stateLoading.style.display  = '';
  if (name === 'error')   stateError.style.display    = '';
  if (name === 'expired') stateExpired.style.display  = '';
  if (name === 'success') stateSuccess.style.display  = '';
  if (name === 'tracker') { if (stateTracker) stateTracker.style.display = ''; }
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

  getVisibleFiles().forEach(file => {
    const card = document.getElementById(`card-${file.id}`);
    if (!card) return;
    const isSelected = selectedFiles.has(file.id);
    const isLocked   = !isSelected && count >= photoLimit;
    card.classList.toggle('selected', isSelected);
    card.classList.toggle('locked', isLocked);
    card.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    // Update note textarea visibility
    const noteWrap = card.querySelector('.photo-note-wrap');
    if (noteWrap) noteWrap.style.display = isSelected ? '' : 'none';
  });
}

// ── Get visible files (respecting filter) ────────────────────────
function getVisibleFiles() {
  return filterFav ? allFiles.filter(f => favorites.has(f.id)) : allFiles;
}

// ── Save favorites to localStorage ──────────────────────────────
function saveFavorites() {
  if (STORAGE_KEY_FAV) {
    localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify([...favorites]));
  }
}

// ── Save selectedFiles to localStorage ───────────────────────────
function saveSelections() {
  if (STORAGE_KEY_SEL) {
    localStorage.setItem(STORAGE_KEY_SEL, JSON.stringify([...selectedFiles.values()]));
  }
}

// ── Clear savedSelections (setelah submit berhasil) ───────────────
function clearSelections() {
  if (STORAGE_KEY_SEL) {
    localStorage.removeItem(STORAGE_KEY_SEL);
  }
}

// ── Toggle favorite ──────────────────────────────────────────────
function toggleFavorite(file, btn) {
  if (favorites.has(file.id)) {
    favorites.delete(file.id);
    btn.classList.remove('fav-active');
    btn.setAttribute('aria-pressed', 'false');
  } else {
    favorites.add(file.id);
    btn.classList.add('fav-active');
    btn.setAttribute('aria-pressed', 'true');
  }
  saveFavorites();
  updateFavCounter();
  if (filterFav) applyFilter();
}

// ── Update favorites counter ─────────────────────────────────────
function updateFavCounter() {
  const counter = document.getElementById('fav-count');
  if (counter) counter.textContent = favorites.size;
}

// ── Apply filter (fav or all) ────────────────────────────────────
function applyFilter() {
  const visible = getVisibleFiles();
  // Hide all cards
  allFiles.forEach(f => {
    const card = document.getElementById(`card-${f.id}`);
    if (card) card.style.display = 'none';
  });
  // Show visible
  visible.forEach(f => {
    const card = document.getElementById(`card-${f.id}`);
    if (card) card.style.display = '';
  });
  const emptyMsg = document.getElementById('fav-empty-msg');
  if (emptyMsg) emptyMsg.style.display = (filterFav && visible.length === 0) ? '' : 'none';
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
    selectedFiles.set(file.id, { id: file.id, name: file.name, note: '' });
  }
  saveSelections(); // ← persist ke localStorage setiap ada perubahan
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
  // Re-apply filter after new batch
  if (filterFav) applyFilter();
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

  const isFav = favorites.has(file.id);

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
    <button class="photo-fav-btn${isFav ? ' fav-active' : ''}" aria-label="Favorit ${escAttr(file.name)}" aria-pressed="${isFav}" tabindex="-1">❤️</button>
    <button class="photo-expand" aria-label="Perbesar foto ${escAttr(file.name)}" tabindex="-1">⛶</button>
    <div class="photo-note-wrap" style="display:none">
      <textarea
        class="photo-note-input"
        placeholder="Tulis catatan edit (opsional)..."
        maxlength="200"
        aria-label="Catatan untuk foto ${escAttr(file.name)}"
      ></textarea>
    </div>
  `;

  const img     = card.querySelector('img');
  const favBtn  = card.querySelector('.photo-fav-btn');
  const noteInput = card.querySelector('.photo-note-input');

  img.addEventListener('load', () => { img.classList.add('loaded'); img.classList.remove('loading'); });
  img.addEventListener('error', () => {
    img.classList.add('error');
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%231a1a2e' width='200' height='200'/%3E%3Ctext x='100' y='95' text-anchor='middle' fill='%234a4870' font-size='32'%3E%F0%9F%93%B7%3C/text%3E%3Ctext x='100' y='125' text-anchor='middle' fill='%234a4870' font-size='11'%3EGagal muat%3C/text%3E%3C/svg%3E";
  });

  imgObserver.observe(img);

  // Note input — sync to selectedFiles map
  noteInput.addEventListener('input', (e) => {
    e.stopPropagation();
    const entry = selectedFiles.get(file.id);
    if (entry) {
      entry.note = noteInput.value;
      saveSelections(); // ← persist note ke localStorage
    }
  });
  noteInput.addEventListener('click', e => e.stopPropagation());
  noteInput.addEventListener('keydown', e => e.stopPropagation());

  // Favorite button
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(file, favBtn);
  });

  // Card click = select
  card.addEventListener('click', (e) => {
    if (e.target.closest('.photo-expand') || e.target.closest('.photo-fav-btn') || e.target.closest('.photo-note-wrap')) return;
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
  lightboxImg.classList.remove('lb-loading', 'lb-loaded');
  lightboxImg.alt = file.name;
  lightboxImg.src = file.thumbnailUrl;
  lightboxImg.classList.add('lb-loading');
  lightbox.classList.add('lb-loading');
  const hiRes = new Image();
  hiRes.src = file.fullUrl;
  hiRes.onload = () => {
    if (lightbox.classList.contains('open') && lightboxImg.alt === file.name) {
      lightboxImg.src = file.fullUrl;
      lightboxImg.classList.remove('lb-loading');
      lightboxImg.classList.add('lb-loaded');
      lightbox.classList.remove('lb-loading');
    }
  };
  hiRes.onerror = () => {
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
  ol.innerHTML = selected.map(f => {
    const note = f.note && f.note.trim() ? ` <em style="font-size:0.85em;opacity:0.7">— ${escHtml(f.note)}</em>` : '';
    return `<li>${escHtml(f.name)}${note}</li>`;
  }).join('');
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

  // Sync notes dari DOM ke map sebelum kirim
  selectedFiles.forEach((entry, fileId) => {
    const card = document.getElementById(`card-${fileId}`);
    if (card) {
      const noteInput = card.querySelector('.photo-note-input');
      if (noteInput) entry.note = noteInput.value.trim();
    }
  });

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
    document.getElementById('success-ol').innerHTML = selected.map(f => {
      const note = f.note ? ` <em style="opacity:0.7;font-size:0.85em">— ${escHtml(f.note)}</em>` : '';
      return `<li>${escHtml(f.name)}${note}</li>`;
    }).join('');
    showState('success');

    // Hapus data pilihan dari localStorage setelah submit berhasil
    clearSelections();
    localStorage.removeItem(STORAGE_KEY_FAV); // bersihkan juga favorites

    // Refresh page jadi tracker setelah 3 detik
    setTimeout(() => location.reload(), 3000);

  } catch (err) {
    showToast('Koneksi gagal: ' + err.message, 'error');
    btnConfirm.disabled = false;
    btnText.textContent = '✅ Ya, Kirim!';
    spinner.classList.add('hidden');
  }
});

// ── Order Progress Tracker ────────────────────────────────────────
function showTracker(session) {
  if (!stateTracker) return;

  const statusLabels = {
    received: { label: 'Pilihan Diterima', icon: '✅', desc: 'Fotografer telah menerima pilihan foto Anda.' },
    editing:  { label: 'Sedang Diedit',    icon: '🎨', desc: 'Foto Anda sedang dalam proses pengeditan.' },
    done:     { label: 'Selesai!',          icon: '🎉', desc: 'Foto sudah selesai diedit dan siap untuk diunduh!' },
  };

  const steps    = ['received', 'editing', 'done'];
  const current  = session.edit_status || 'received';
  const curIndex = steps.indexOf(current);
  const info     = statusLabels[current] || statusLabels.received;

  const stepsHtml = steps.map((step, i) => {
    const s  = statusLabels[step];
    const state = i < curIndex ? 'done' : i === curIndex ? 'active' : 'pending';
    return `
      <div class="tracker-step tracker-step-${state}">
        <div class="tracker-dot">${state === 'done' ? '✓' : state === 'active' ? s.icon : ''}</div>
        <div class="tracker-step-label">${s.label}</div>
      </div>
    `;
  }).join('<div class="tracker-line"></div>');

  const editNoteHtml = session.edit_note
    ? `<div class="tracker-note"><strong>Catatan dari Fotografer:</strong><br>${escHtml(session.edit_note)}</div>`
    : '';

  stateTracker.innerHTML = `
    <div class="tracker-card">
      <div class="tracker-header">
        <div class="tracker-icon-big">${info.icon}</div>
        <h2 class="tracker-title">${info.label}</h2>
        <p class="tracker-subtitle">Halo, <strong>${escHtml(session.client_name)}</strong>! Berikut status pesanan foto Anda.</p>
      </div>
      <div class="tracker-steps">${stepsHtml}</div>
      <p class="tracker-desc">${info.desc}</p>
      ${editNoteHtml}
      <p class="tracker-refresh">Status ini diperbarui oleh fotografer secara langsung. Muat ulang halaman ini untuk melihat update terbaru.</p>
      <button class="btn btn-outline" onclick="location.reload()">🔄 Refresh Status</button>
    </div>
  `;
  showState('tracker');
}

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

  // ── Sesi completed → tampilkan Order Tracker ──────────────────
  if (sessionData.status === 'completed') {
    showTracker(sessionData);
    return;
  }

  photoLimit = sessionData.photo_limit;
  document.getElementById('hdr-client-name').textContent = sessionData.client_name;
  document.title = `Pilih Foto — ${sessionData.client_name}`;
  document.getElementById('hdr-limit').textContent = photoLimit;
  document.getElementById('hdr-limit-text').innerHTML = ` dari <span id="hdr-limit">${photoLimit}</span> foto`;

  // 2. Setup filter bar
  const filterBar = document.getElementById('gallery-filter-bar');
  if (filterBar) {
    updateFavCounter();
    document.getElementById('btn-filter-all').addEventListener('click', () => {
      filterFav = false;
      filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('btn-filter-all').classList.add('active');
      applyFilter();
    });
    document.getElementById('btn-filter-fav').addEventListener('click', () => {
      filterFav = true;
      filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('btn-filter-fav').classList.add('active');
      applyFilter();
    });

    const btnDriveLink = document.getElementById('btn-drive-link');
    if (btnDriveLink && sessionData.folder_url) {
      btnDriveLink.href = sessionData.folder_url;
      btnDriveLink.style.display = 'inline-flex';
    }
  }

  // 3. Fetch Drive files
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

  // 4. Render gallery
  showState('gallery');

  // Restore pilihan dari localStorage yang tersimpan sebelumnya
  if (selectedFiles.size > 0) {
    showToast(`♻️ ${selectedFiles.size} pilihan foto sebelumnya berhasil dipulihkan.`, 'info');
  }

  updateQuotaUI();
  updateFavCounter();
  renderNextBatch();
  batchObserver.observe(sentinel);
}

// ── Boot ──────────────────────────────────────────────────────────
init();
