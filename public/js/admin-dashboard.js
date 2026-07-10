/* ============================================================
   ADMIN DASHBOARD — JavaScript v3
   ============================================================ */
'use strict';

// ── Auth guard ──────────────────────────────────────────────────
const token = localStorage.getItem('sf_token');
const admin = JSON.parse(localStorage.getItem('sf_admin') || 'null');
if (!token || !admin) {
  window.location.replace('/admin/login.html');
}

// ── Authenticated fetch helper ──────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('sf_token');
    localStorage.removeItem('sf_admin');
    window.location.replace('/admin/login.html');
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Toast ────────────────────────────────────────────────────────
const toastContainer = document.getElementById('toast-container');
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span aria-hidden="true">${icons[type] || '📢'}</span><span>${msg}</span>`;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ── Modal helpers ────────────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.add('open');
  const first = m.querySelector('input, button, textarea');
  if (first) setTimeout(() => first.focus(), 50);
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}
function closeAllModals() {
  document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
}

// Close on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeAllModals();
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllModals();
});

// ── Set admin UI ─────────────────────────────────────────────────
const navUsername = document.getElementById('nav-username');
if (navUsername && admin) {
  navUsername.textContent = admin.name || admin.username;
}

// ── Logout ───────────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('sf_token');
  localStorage.removeItem('sf_admin');
  window.location.replace('/admin/login.html');
});

// ── Cek DB Neon ──────────────────────────────────────────────────
const btnCekDb = document.getElementById('btn-cek-db');
if (btnCekDb) {
  btnCekDb.addEventListener('click', async () => {
    btnCekDb.disabled = true;
    btnCekDb.innerHTML = '⚡ Checking...';
    try {
      const res = await apiFetch('/api/auth/check-db');
      const data = await res.json();
      if (data.status === 'success') {
        showToast(`✅ ${data.message} (Versi: ${data.version.split(',')[0]})`, 'success');
      } else {
        showToast('❌ Gagal: ' + data.error, 'error');
      }
    } catch (err) {
      showToast('❌ Gagal cek database: ' + err.message, 'error');
    } finally {
      btnCekDb.disabled = false;
      btnCekDb.innerHTML = '⚡ Cek DB Neon';
    }
  });
}

// ── Load stats ───────────────────────────────────────────────────
async function loadStats() {
  try {
    const res  = await apiFetch('/api/sessions/stats');
    const data = await res.json();
    document.getElementById('stat-total').textContent     = data.total;
    document.getElementById('stat-active').textContent    = data.active;
    document.getElementById('stat-completed').textContent = data.completed;
    document.getElementById('stat-photos').textContent    = data.totalPics;
  } catch (_) {}
}

// ── Format date WIB ──────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Jakarta', hour12: false
  });
}

// ── Status badge ─────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    active:    ['badge-active',    '● Aktif'],
    completed: ['badge-completed', '✓ Selesai'],
    expired:   ['badge-expired',   '✕ Kadaluarsa'],
  };
  const [cls, label] = map[status] || ['badge-expired', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── HTML escape ──────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Sessions state ───────────────────────────────────────────────
let sessions = [];

// ── Gallery URL helper ────────────────────────────────────────────
function galleryUrl(uuid, shortSlug) {
  if (shortSlug) return `${location.origin}/s/${shortSlug}`;
  return `${location.origin}/gallery.html?session=${uuid}`;
}

// ── Copy Text Helper ──────────────────────────────────────────────
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Link berhasil disalin!', 'success'));
}
window.copyText = copyText;

// ── Action buttons ────────────────────────────────────────────────
function actionButtons(s) {
  const btns = [];
  btns.push(`<button class="btn btn-outline btn-sm" onclick="showShareLink('${s.uuid}', '${s.short_slug || ''}')" title="Link galeri" aria-label="Bagikan link">🔗 Link</button>`);
  
  if (s.status === 'completed') {
    btns.push(`<button class="btn btn-outline btn-sm" onclick="viewSelections('${s.uuid}')" title="Lihat pilihan foto" aria-label="Lihat seleksi">👁 Seleksi & Status</button>`);
  }
  
  btns.push(`<button class="btn btn-outline btn-sm" onclick="openEditSessionModal('${s.uuid}')" title="Edit Data Sesi" aria-label="Edit Sesi">✏️ Edit</button>`);

  if (s.status !== 'active') {
    btns.push(`<button class="btn btn-outline btn-sm" onclick="reopenSession('${s.uuid}')" title="Buka kembali" aria-label="Buka kembali sesi">♻️</button>`);
  }
  if (s.status === 'active') {
    btns.push(`<button class="btn btn-outline btn-sm" onclick="expireSession('${s.uuid}')" title="Nonaktifkan" aria-label="Nonaktifkan sesi">⏸</button>`);
  }
  btns.push(`<button class="btn btn-danger btn-sm" onclick="confirmDelete('${s.uuid}','${escHtml(s.client_name)}')" title="Hapus sesi" aria-label="Hapus sesi">🗑</button>`);
  return btns.join('');
}

// ── Render table ─────────────────────────────────────────────────
function renderTable(data) {
  const tbody = document.getElementById('sessions-tbody');
  tbody.innerHTML = data.map(s => `
    <tr data-uuid="${s.uuid}">
      <td class="td-name">
        ${escHtml(s.client_name)}
        ${s.short_slug ? `<br><span class="short-link-chip" onclick="copyText('${location.origin}/s/${s.short_slug}')" title="Salin Short Link">🔗 /s/${s.short_slug}</span>` : ''}
        <span>${escHtml(s.folder_id)}</span>
      </td>
      <td>${s.photo_limit} foto</td>
      <td>${s.photo_count} / ${s.photo_limit}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${formatDate(s.created_at)}</td>
      <td class="td-actions">${actionButtons(s)}</td>
    </tr>
  `).join('');
}

// ── Render mobile cards ───────────────────────────────────────────
function renderCards(data) {
  const container = document.getElementById('sessions-cards');
  container.innerHTML = data.map(s => `
    <div class="session-card" data-uuid="${s.uuid}">
      <div class="session-card-header">
        <div>
          <div class="session-card-name">
            ${escHtml(s.client_name)}
            ${s.short_slug ? `<br><span class="short-link-chip" style="margin-top:4px;" onclick="copyText('${location.origin}/s/${s.short_slug}')" title="Salin Short Link">🔗 /s/${s.short_slug}</span>` : ''}
          </div>
          <div class="session-card-meta">${formatDate(s.created_at)}</div>
        </div>
        ${statusBadge(s.status)}
      </div>
      <div class="session-card-body">
        <span>Dipilih: <strong>${s.photo_count}</strong> / ${s.photo_limit}</span>
        <span>Limit: <strong>${s.photo_limit}</strong> foto</span>
      </div>
      <div class="session-card-footer">
        ${actionButtons(s)}
      </div>
    </div>
  `).join('');
}

// ── Load sessions ────────────────────────────────────────────────
async function loadSessions() {
  const loadingEl  = document.getElementById('sessions-loading');
  const emptyEl    = document.getElementById('sessions-empty');
  const tableWrap  = document.getElementById('sessions-table-wrap');
  const cardsWrap  = document.getElementById('sessions-cards');

  loadingEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  tableWrap.classList.add('hidden');
  cardsWrap.classList.add('hidden');

  try {
    const res = await apiFetch('/api/sessions');
    sessions  = await res.json();

    loadingEl.classList.add('hidden');

    if (!sessions.length) {
      emptyEl.classList.remove('hidden');
      return;
    }

    renderTable(sessions);
    renderCards(sessions);
    tableWrap.classList.remove('hidden');
    cardsWrap.classList.remove('hidden');

  } catch (err) {
    loadingEl.classList.add('hidden');
    showToast('Gagal memuat sesi: ' + err.message, 'error');
  }
}

// ── Show share link modal ─────────────────────────────────────────
function showShareLink(uuid, shortSlug) {
  const url = galleryUrl(uuid, shortSlug);
  document.getElementById('gallery-link-input').value = url;
  document.getElementById('btn-open-gallery').href = url;
  openModal('modal-created');
}
window.showShareLink = showShareLink;

// ── View selections modal ─────────────────────────────────────────
async function viewSelections(uuid) {
  openModal('modal-selections');
  const content = document.getElementById('modal-sel-content');
  const session = sessions.find(s => s.uuid === uuid) || {};

  content.innerHTML = `<div class="loading-overlay" style="min-height:120px;"><div class="spinner"></div></div>`;

  try {
    const res   = await apiFetch(`/api/sessions/${uuid}/selections`);
    const items = await res.json();

    if (!items.length) {
      content.innerHTML = `<p style="color:var(--text-2); text-align:center; padding:32px;">Belum ada seleksi tersimpan.</p>`;
      document.getElementById('modal-sel-status-panel').style.display = 'none';
      return;
    }

    const listHtml = items.map((f, i) => {
      const noteHtml = f.note ? `<br><em style="font-size:0.85em;color:var(--text-2);">Catatan: ${escHtml(f.note)}</em>` : '';
      return `<li style="margin-bottom:8px;">${escHtml(f.file_name)}${noteHtml}</li>`;
    }).join('');
    
    content.innerHTML = `
      <div style="margin-bottom:16px;">
        <p style="color:var(--text-2); font-size:0.875rem;">
          <strong style="color:var(--text-0);">${escHtml(session.client_name || '')}</strong> —
          ${items.length} foto terpilih dari limit ${session.photo_limit || '?'}
        </p>
      </div>
      <div class="confirm-list"><ol>${listHtml}</ol></div>
      <div style="margin-top:16px; display:flex; justify-content:flex-end;">
        <button class="btn btn-outline btn-sm" onclick="copySelections(${JSON.stringify(items.map(f=>f.file_name))})" aria-label="Salin daftar filename">
          📋 Salin Daftar
        </button>
      </div>
    `;

    // ── Update Status UI ──
    const statusPanel = document.getElementById('modal-sel-status-panel');
    if (session.status === 'completed') {
      statusPanel.style.display = 'block';
      document.getElementById('update-edit-status').value = session.edit_status || 'received';
      document.getElementById('update-edit-note').value = session.edit_note || '';
      
      const btnUpdate = document.getElementById('btn-update-status');
      btnUpdate.onclick = () => updateEditStatus(uuid);
    } else {
      statusPanel.style.display = 'none';
    }

  } catch (err) {
    content.innerHTML = `<p style="color:var(--red); padding:16px;">Gagal memuat seleksi: ${err.message}</p>`;
    document.getElementById('modal-sel-status-panel').style.display = 'none';
  }
}
window.viewSelections = viewSelections;

// ── Update Edit Status ────────────────────────────────────────────
async function updateEditStatus(uuid) {
  const btn = document.getElementById('btn-update-status');
  const txt = document.getElementById('btn-update-status-text');
  const spinner = document.getElementById('btn-update-status-spinner');
  const editStatus = document.getElementById('update-edit-status').value;
  const editNote = document.getElementById('update-edit-note').value.trim();

  btn.disabled = true;
  txt.textContent = 'Menyimpan...';
  spinner.classList.remove('hidden');

  try {
    const res = await apiFetch(`/api/sessions/${uuid}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ editStatus, editNote }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    
    showToast('Status pesanan berhasil diperbarui', 'success');
    closeModal('modal-selections');
    loadSessions();
  } catch (err) {
    showToast('Gagal update status: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    txt.textContent = 'Simpan Status';
    spinner.classList.add('hidden');
  }
}

function copySelections(names) {
  const text = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('Daftar disalin ke clipboard!', 'success'));
}
window.copySelections = copySelections;

// ── Reopen session ────────────────────────────────────────────────
async function reopenSession(uuid) {
  if (!confirm('Buka kembali sesi ini? Seleksi lama akan direset.')) return;
  try {
    const res = await apiFetch(`/api/sessions/${uuid}/reopen`, { method: 'PATCH' });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('Sesi berhasil dibuka kembali', 'success');
    loadSessions(); loadStats();
  } catch (err) {
    showToast('Gagal membuka sesi: ' + err.message, 'error');
  }
}
window.reopenSession = reopenSession;

// ── Expire session ────────────────────────────────────────────────
async function expireSession(uuid) {
  if (!confirm('Nonaktifkan sesi ini?')) return;
  try {
    const res = await apiFetch(`/api/sessions/${uuid}/expire`, { method: 'PATCH' });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('Sesi dinonaktifkan', 'info');
    loadSessions(); loadStats();
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
}
window.expireSession = expireSession;

// ── Delete session ────────────────────────────────────────────────
let pendingDeleteUuid = null;

function confirmDelete(uuid, name) {
  pendingDeleteUuid = uuid;
  document.getElementById('modal-del-desc').textContent =
    `Hapus sesi "${name}"? Semua data seleksi foto akan dihapus permanen.`;
  openModal('modal-confirm-delete');
}
window.confirmDelete = confirmDelete;

document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
  if (!pendingDeleteUuid) return;
  const spinner = document.getElementById('btn-del-spinner');
  const btn     = document.getElementById('btn-confirm-delete');
  btn.disabled = true; spinner.classList.remove('hidden');

  try {
    const res = await apiFetch(`/api/sessions/${pendingDeleteUuid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    closeAllModals();
    showToast('Sesi berhasil dihapus', 'success');
    loadSessions(); loadStats();
  } catch (err) {
    showToast('Hapus gagal: ' + err.message, 'error');
  } finally {
    btn.disabled = false; spinner.classList.add('hidden');
    pendingDeleteUuid = null;
  }
});

// ── Create new session ────────────────────────────────────────────
function openNewSessionModal() {
  document.getElementById('form-new-session').reset();
  document.getElementById('modal-alert').classList.add('hidden');
  openModal('modal-new-session');
}

document.getElementById('btn-new-session').addEventListener('click', openNewSessionModal);

// Wire up "empty state" button
const btnNewEmpty = document.getElementById('btn-new-session-empty');
if (btnNewEmpty) btnNewEmpty.addEventListener('click', openNewSessionModal);

document.getElementById('form-new-session').addEventListener('submit', async (e) => {
  e.preventDefault();

  const alertEl   = document.getElementById('modal-alert');
  const btnCreate = document.getElementById('btn-create');
  const btnText   = document.getElementById('btn-create-text');
  const spinner   = document.getElementById('btn-create-spinner');

  const clientName = document.getElementById('client-name').value.trim();
  const folderUrl  = document.getElementById('folder-url').value.trim();
  const photoLimit = document.getElementById('photo-limit').value;

  alertEl.classList.add('hidden');

  if (!clientName || !folderUrl || !photoLimit) {
    alertEl.textContent = 'Semua field wajib diisi';
    alertEl.classList.remove('hidden');
    return;
  }

  btnCreate.disabled = true;
  btnText.textContent = 'Membuat...';
  spinner.classList.remove('hidden');

  try {
    const res  = await apiFetch('/api/sessions', {
      method: 'POST',
      body:   JSON.stringify({ clientName, folderUrl, photoLimit }),
    });
    const data = await res.json();

    if (!res.ok) {
      alertEl.textContent = data.error || 'Gagal membuat sesi';
      alertEl.classList.remove('hidden');
      return;
    }

    closeAllModals();
    document.getElementById('gallery-link-input').value = data.galleryUrl;
    document.getElementById('btn-open-gallery').href    = data.galleryUrl;
    openModal('modal-created');

    loadSessions(); loadStats();
    showToast('Sesi berhasil dibuat!', 'success');

  } catch (err) {
    alertEl.textContent = 'Server error: ' + err.message;
    alertEl.classList.remove('hidden');
  } finally {
    btnCreate.disabled = false;
    btnText.textContent = 'Buat Sesi';
    spinner.classList.add('hidden');
  }
});

// ── Edit session ──────────────────────────────────────────────────
function openEditSessionModal(uuid) {
  const session = sessions.find(s => s.uuid === uuid);
  if (!session) return;

  document.getElementById('edit-session-uuid').value = session.uuid;
  document.getElementById('edit-client-name').value = session.client_name || '';
  document.getElementById('edit-folder-url').value = session.folder_url || '';
  document.getElementById('edit-photo-limit').value = session.photo_limit || 10;
  
  document.getElementById('modal-edit-alert').classList.add('hidden');
  openModal('modal-edit-session');
}
window.openEditSessionModal = openEditSessionModal;

document.getElementById('form-edit-session').addEventListener('submit', async (e) => {
  e.preventDefault();

  const alertEl   = document.getElementById('modal-edit-alert');
  const btnUpdate = document.getElementById('btn-update-session');
  const btnText   = document.getElementById('btn-update-session-text');
  const spinner   = document.getElementById('btn-update-session-spinner');

  const uuid       = document.getElementById('edit-session-uuid').value;
  const clientName = document.getElementById('edit-client-name').value.trim();
  const folderUrl  = document.getElementById('edit-folder-url').value.trim();
  const photoLimit = document.getElementById('edit-photo-limit').value;

  alertEl.classList.add('hidden');

  if (!clientName || !folderUrl || !photoLimit) {
    alertEl.textContent = 'Semua field wajib diisi';
    alertEl.classList.remove('hidden');
    return;
  }

  btnUpdate.disabled = true;
  btnText.textContent = 'Menyimpan...';
  spinner.classList.remove('hidden');

  try {
    const res  = await apiFetch(`/api/sessions/${uuid}`, {
      method: 'PATCH',
      body:   JSON.stringify({ clientName, folderUrl, photoLimit }),
    });
    const data = await res.json();

    if (!res.ok) {
      alertEl.textContent = data.error || 'Gagal memperbarui sesi';
      alertEl.classList.remove('hidden');
      return;
    }

    closeModal('modal-edit-session');
    loadSessions();
    showToast('Sesi berhasil diperbarui!', 'success');

  } catch (err) {
    alertEl.textContent = 'Server error: ' + err.message;
    alertEl.classList.remove('hidden');
  } finally {
    btnUpdate.disabled = false;
    btnText.textContent = 'Simpan Perubahan';
    spinner.classList.add('hidden');
  }
});

// ── Copy link button ──────────────────────────────────────────────
document.getElementById('btn-copy-link').addEventListener('click', () => {
  const val = document.getElementById('gallery-link-input').value;
  navigator.clipboard.writeText(val).then(() => {
    showToast('Link berhasil disalin!', 'success');
    const btn = document.getElementById('btn-copy-link');
    btn.textContent = '✓ Disalin';
    setTimeout(() => { btn.textContent = 'Salin'; }, 2000);
  });
});

// ── Change password ───────────────────────────────────────────────
document.getElementById('btn-change-pass').addEventListener('click', () => {
  document.getElementById('form-change-pass').reset();
  const alertEl = document.getElementById('modal-pass-alert');
  alertEl.className = 'alert hidden';
  openModal('modal-change-pass');
});

document.getElementById('form-change-pass').addEventListener('submit', async (e) => {
  e.preventDefault();

  const alertEl  = document.getElementById('modal-pass-alert');
  const btnSave  = document.getElementById('btn-save-pass');
  const spinner  = document.getElementById('btn-pass-spinner');

  const currentPassword = document.getElementById('pass-current').value;
  const newPassword     = document.getElementById('pass-new').value;
  const confirmPassword = document.getElementById('pass-confirm').value;

  alertEl.className = 'alert hidden';

  if (newPassword !== confirmPassword) {
    alertEl.textContent = 'Password baru tidak cocok';
    alertEl.className = 'alert alert-error';
    return;
  }
  if (newPassword.length < 6) {
    alertEl.textContent = 'Password baru minimal 6 karakter';
    alertEl.className = 'alert alert-error';
    return;
  }

  btnSave.disabled = true; spinner.classList.remove('hidden');

  try {
    const res  = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body:   JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();

    if (!res.ok) {
      alertEl.textContent = data.error || 'Gagal mengubah password';
      alertEl.className = 'alert alert-error';
      return;
    }

    closeAllModals();
    showToast('Password berhasil diubah!', 'success');

  } catch (err) {
    alertEl.textContent = 'Server error: ' + err.message;
    alertEl.className = 'alert alert-error';
  } finally {
    btnSave.disabled = false; spinner.classList.add('hidden');
  }
});

// ── Wire all modal close buttons ──────────────────────────────────
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', closeAllModals);
});
['modal-created-close','modal-sel-close','modal-pass-close','modal-pass-close2','modal-del-close','modal-del-cancel']
  .forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', closeAllModals);
  });

document.getElementById('btn-created-done').addEventListener('click', closeAllModals);

// ── Initial load ──────────────────────────────────────────────────
loadStats();
loadSessions();
