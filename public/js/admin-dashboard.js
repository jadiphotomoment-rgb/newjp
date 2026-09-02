/* ============================================================
   ADMIN DASHBOARD — JavaScript v4 (Stitch Design)
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

// ── Load Stats (Dashboard specific) ──────────────────────────────
async function loadDashboardStats() {
  try {
    const [bRes, fRes, sRes] = await Promise.all([
      apiFetch('/api/bookings/admin/list'),
      apiFetch('/api/finance/summary'),
      apiFetch('/api/sessions/stats')
    ]);
    
    if (bRes.ok) {
      const bookings = await bRes.json();
      const el = document.getElementById('stat-bookings');
      if (el) el.textContent = bookings.length;
    }
    
    if (fRes.ok) {
      const fin = await fRes.json();
      const income = Number(fin.thisMonthIncome || 0);
      const el = document.getElementById('stat-income');
      if (el) {
        el.textContent = 'Rp ' + (income >= 1000000 ? (income / 1000000).toFixed(1) + 'jt' : income.toLocaleString('id-ID'));
      }
    }

    if (sRes.ok) {
      const stats = await sRes.json();
      const el = document.getElementById('stat-active');
      if (el) el.textContent = stats.active;

      if (stats.leadSources) {
        renderLeadSourcesChart(stats.leadSources);
      }
    }

  } catch (e) {
    console.error("Gagal memuat statistik dashboard:", e);
  }
}

// ── Render Chart ──────────────────────────────────────────────────
let leadChartInstance = null;
function renderLeadSourcesChart(sources) {
  const ctx = document.getElementById('leadSourceChart');
  const emptyEl = document.getElementById('leadSourceEmpty');
  const legendEl = document.getElementById('leadSourceLegend');
  
  if (!ctx) return;

  if (!sources || sources.length === 0) {
    ctx.style.display = 'none';
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (legendEl) legendEl.innerHTML = '';
    return;
  }

  ctx.style.display = 'block';
  if (emptyEl) emptyEl.classList.add('hidden');

  const labels = sources.map(s => s.source || 'Lainnya');
  const data = sources.map(s => s.count);
  const total = data.reduce((a, b) => a + b, 0);

  // Modern colors based on Lumina Design System
  const bgColors = [
    '#e91d75', // Primary
    '#07006c', // On Primary Fixed
    '#565e74', // Secondary
    '#595c5e', // Tertiary
    '#ba1a1a', // Error
    '#767586', // Outline
    '#c0c1ff', // Primary Dim
    '#dae2fd', // Secondary Container
  ];

  if (leadChartInstance) {
    leadChartInstance.destroy();
  }

  leadChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: bgColors,
        borderWidth: 0,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#213145',
          titleFont: { family: 'Helvetica Neue', size: 13, weight: 'bold' },
          bodyFont: { family: 'Helvetica Neue', size: 13 },
          padding: 12,
          cornerRadius: 8,
          displayColors: true
        }
      }
    }
  });

  // Custom Legend for better Typography (Bold)
  if (legendEl) {
    let legendHtml = '<div class="flex flex-col gap-3">';
    sources.forEach((s, idx) => {
      const color = bgColors[idx % bgColors.length];
      const pct = Math.round((s.count / total) * 100);
      legendHtml += `
        <div class="flex items-center justify-between p-3 rounded-lg bg-surface-container-low border border-outline-variant/20 hover:bg-surface-container transition-colors">
          <div class="flex items-center gap-3">
            <div class="w-4 h-4 rounded-full" style="background-color: ${color}"></div>
            <span class="font-body-md text-on-surface font-bold">${s.source || 'Lainnya'}</span>
          </div>
          <div class="flex items-center gap-4">
            <span class="font-label-md text-on-surface-variant font-bold">${s.count} Klien</span>
            <span class="font-headline-md text-primary font-bold text-right w-12">${pct}%</span>
          </div>
        </div>
      `;
    });
    legendHtml += '</div>';
    legendEl.innerHTML = legendHtml;
  }
}

// ── Ganti Password ───────────────────────────────────────────────
document.getElementById('btn-change-pass')?.addEventListener('click', () => {
  document.getElementById('form-change-pass').reset();
  const alertEl = document.getElementById('modal-pass-alert');
  if (alertEl) alertEl.classList.add('hidden');
  openModal('modal-change-pass');
});

document.getElementById('form-change-pass')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('modal-pass-alert');
  const spinner = document.getElementById('btn-pass-spinner');
  const btnSave = document.getElementById('btn-save-pass');

  const currentPassword = document.getElementById('pass-current').value;
  const newPassword = document.getElementById('pass-new').value;
  const confirmPass = document.getElementById('pass-confirm').value;

  if (alertEl) alertEl.classList.add('hidden');

  if (newPassword !== confirmPass) {
    if (alertEl) {
      alertEl.textContent = 'Konfirmasi password tidak cocok.';
      alertEl.classList.remove('hidden');
    }
    return;
  }

  if (btnSave) btnSave.disabled = true;
  if (spinner) spinner.classList.remove('hidden');

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (alertEl) {
        alertEl.textContent = data.error || 'Gagal mengubah password';
        alertEl.classList.remove('hidden');
      }
      return;
    }

    closeAllModals();
    showToast('Password berhasil diubah!', 'success');

  } catch (err) {
    if (alertEl) {
      alertEl.textContent = 'Server error: ' + err.message;
      alertEl.classList.remove('hidden');
    }
  } finally {
    if (btnSave) btnSave.disabled = false;
    if (spinner) spinner.classList.add('hidden');
  }
});

// Wire modal close buttons
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', closeAllModals);
});
['modal-pass-close','modal-pass-close2'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closeAllModals);
});

// ── Initial load ──────────────────────────────────────────────────
loadDashboardStats();
