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
  const activeToken = localStorage.getItem('sf_token') || token;
  const res = await fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${activeToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
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
    const isOwner = admin && (admin.role === 'owner');
    const [bRes, fRes, sRes] = await Promise.all([
      apiFetch('/api/bookings/admin/list'),
      isOwner ? apiFetch('/api/finance/summary') : Promise.resolve(null),
      apiFetch('/api/sessions/stats')
    ]);
    
    if (bRes && bRes.ok) {
      const bookings = await bRes.json();
      const el = document.getElementById('stat-bookings');
      if (el) el.textContent = bookings.length;
    }
    
    if (fRes && fRes.ok) {
      const fin = await fRes.json();
      const income = Number(fin.thisMonthIncome || 0);
      const el = document.getElementById('stat-income');
      if (el) {
        el.textContent = 'Rp ' + (income >= 1000000 ? (income / 1000000).toFixed(1) + 'jt' : income.toLocaleString('id-ID'));
      }
    } else if (!isOwner) {
      const el = document.getElementById('stat-income');
      if (el) el.textContent = '—';
    }

    if (sRes && sRes.ok) {
      const stats = await sRes.json();
      const el = document.getElementById('stat-active');
      if (el) el.textContent = stats.active;
    }

    // Load Marketing & Lead Sources Analytics (Fase 5)
    await loadMarketingCategories();
    await loadMarketingAnalytics();

  } catch (e) {
    console.error("Gagal memuat statistik dashboard:", e);
  }
}

// ── Helper Format & Escape ───────────────────────────────────────
function fmtRp(n) {
  return Number(n || 0).toLocaleString('id-ID');
}
function fmtShortRp(n) {
  const num = Number(n || 0);
  if (num >= 1000000) return 'Rp ' + (num / 1000000).toFixed(1) + ' jt';
  return 'Rp ' + num.toLocaleString('id-ID');
}
function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Marketing & Lead Sources Analytics (Fase 5) ───────────────────
let leadChartInstance = null;
let revenueChartInstance = null;

async function loadMarketingCategories() {
  try {
    const res = await apiFetch('/api/bookings/categories');
    if (!res.ok) return;
    const cats = await res.json();
    const sel = document.getElementById('mkt-filter-category');
    if (sel && sel.options.length <= 1) {
      sel.innerHTML = '<option value="">Semua Kategori</option>' + cats.map(c =>
        `<option value="${c.slug}">${escHtml(c.name)}</option>`
      ).join('');
    }
  } catch (_) {}
}

async function loadMarketingAnalytics() {
  const cat = document.getElementById('mkt-filter-category')?.value || '';
  const period = document.getElementById('mkt-filter-period')?.value || 'all';
  const qs = new URLSearchParams({ ...(cat && { category: cat }), ...(period && { period }) });

  try {
    const res = await apiFetch(`/api/dashboard/sumber-informasi?${qs}`);
    if (!res.ok) return;
    const data = await res.json();

    const sum = data.summary || {};
    const dist = data.distribution || [];
    const referrals = data.recent_referrals || [];

    // 1. Update KPI Summary Cards
    const kpiTopSrc = document.getElementById('kpi-top-source');
    if (kpiTopSrc) kpiTopSrc.textContent = sum.top_source || '—';
    const kpiTopSrcSub = document.getElementById('kpi-top-source-sub');
    if (kpiTopSrcSub) kpiTopSrcSub.textContent = `${sum.top_source_count || 0} booking didapat`;

    const kpiTopRev = document.getElementById('kpi-top-revenue');
    if (kpiTopRev) kpiTopRev.textContent = sum.top_revenue_source || '—';
    const kpiTopRevSub = document.getElementById('kpi-top-revenue-sub');
    if (kpiTopRevSub) kpiTopRevSub.textContent = `Omset ${fmtShortRp(sum.top_revenue_amount)}`;

    const kpiTotRev = document.getElementById('kpi-total-revenue');
    if (kpiTotRev) kpiTotRev.textContent = fmtShortRp(sum.total_revenue);
    const kpiTotBook = document.getElementById('kpi-total-bookings');
    if (kpiTotBook) kpiTotBook.textContent = `Dari ${sum.total_bookings || 0} total booking`;

    const kpiConv = document.getElementById('kpi-conversion-rate');
    if (kpiConv) kpiConv.textContent = `${sum.overall_conversion_rate || 0}%`;
    const kpiConvSub = document.getElementById('kpi-conversion-sub');
    if (kpiConvSub) kpiConvSub.textContent = `${sum.total_lunas || 0} booking lunas`;

    const totalTextEl = document.getElementById('mkt-dist-total-text');
    if (totalTextEl) totalTextEl.textContent = `Total ${sum.total_bookings || 0} Klien`;

    // 2. Render Donut Chart (Distribusi)
    renderLeadDistributionChart(dist);

    // 3. Render Bar Chart (Revenue per Channel)
    renderRevenueSourceChart(dist);

    // 4. Populate Breakdown Table
    renderBreakdownTable(dist);

    // 5. Populate Referrals List
    renderReferralsList(referrals);

  } catch (err) {
    console.error('Gagal memuat analitik marketing:', err);
  }
}

function renderLeadDistributionChart(dist) {
  const ctx = document.getElementById('leadSourceChart');
  const emptyEl = document.getElementById('leadSourceEmpty');
  const legendEl = document.getElementById('leadSourceLegend');
  if (!ctx) return;

  if (!dist || dist.length === 0) {
    ctx.style.display = 'none';
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (legendEl) legendEl.innerHTML = '<p class="text-xs text-on-surface-variant text-center py-4">Belum ada data analitik.</p>';
    return;
  }

  ctx.style.display = 'block';
  if (emptyEl) emptyEl.classList.add('hidden');

  const labels = dist.map(d => d.label);
  const counts = dist.map(d => d.count);
  const colors = dist.map(d => d.color);

  if (leadChartInstance) leadChartInstance.destroy();

  leadChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: counts,
        backgroundColor: colors,
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1b2234',
          titleFont: { size: 12, weight: 'bold' },
          bodyFont: { size: 12 },
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: function(context) {
              const item = dist[context.dataIndex];
              return ` ${item.count} Klien (${item.percentage}%)`;
            }
          }
        }
      }
    }
  });

  if (legendEl) {
    legendEl.innerHTML = dist.map(d => `
      <div class="flex items-center justify-between p-2 rounded-lg bg-surface-container border border-outline-variant/20 hover:bg-surface-container-high transition-colors mb-1.5">
        <div class="flex items-center gap-2">
          <div class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${d.color}"></div>
          <span class="text-xs font-semibold text-on-surface truncate">${escHtml(d.label)}</span>
        </div>
        <div class="flex items-center gap-2.5">
          <span class="text-[11px] text-on-surface-variant">${d.count}</span>
          <span class="text-xs font-bold text-primary w-11 text-right">${d.percentage}%</span>
        </div>
      </div>
    `).join('');
  }
}

function renderRevenueSourceChart(dist) {
  const ctx = document.getElementById('revenueSourceChart');
  if (!ctx) return;

  const validDist = dist.filter(d => Number(d.total_revenue) > 0);
  const dataList = validDist.length ? validDist : dist;
  const labels = dataList.map(d => d.label);
  const revenues = dataList.map(d => d.total_revenue);
  const colors = dataList.map(d => d.color);

  if (revenueChartInstance) revenueChartInstance.destroy();

  revenueChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Total Nilai Booking',
        data: revenues,
        backgroundColor: colors,
        borderRadius: 6,
        maxBarThickness: 36
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1b2234',
          callbacks: {
            label: function(context) {
              return ` Total: Rp ${fmtRp(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, color: '#9ca4c0' }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            font: { size: 10 },
            color: '#9ca4c0',
            callback: function(value) {
              if (value >= 1000000) return (value / 1000000) + 'jt';
              if (value >= 1000) return (value / 1000) + 'k';
              return value;
            }
          }
        }
      }
    }
  });
}

function renderBreakdownTable(dist) {
  const tbody = document.getElementById('mkt-breakdown-tbody');
  if (!tbody) return;

  if (!dist || dist.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-on-surface-variant">Belum ada data untuk periode ini</td></tr>';
    return;
  }

  tbody.innerHTML = dist.map(d => `
    <tr class="hover:bg-surface-container-low transition-colors">
      <td class="py-3 px-4">
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-full shrink-0" style="background-color: ${d.color}"></div>
          <span class="font-semibold text-on-surface">${escHtml(d.label)}</span>
        </div>
      </td>
      <td class="py-3 px-4 text-center font-bold text-on-surface">${d.count}</td>
      <td class="py-3 px-4 text-center">
        <span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-bold" style="background:${d.bg};color:${d.color}">${d.percentage}%</span>
      </td>
      <td class="py-3 px-4 text-right font-bold text-emerald-400">Rp ${fmtRp(d.total_revenue)}</td>
      <td class="py-3 px-4 text-right text-on-surface-variant">Rp ${fmtRp(d.avg_revenue)}</td>
      <td class="py-3 px-4 text-center">
        <span class="font-semibold text-on-surface">${d.lunas_count} / ${d.count}</span>
        <span class="text-[10px] text-on-surface-variant block">(${d.conversion_rate}%)</span>
      </td>
    </tr>
  `).join('');
}

function renderReferralsList(referrals) {
  const container = document.getElementById('mkt-referrals-list');
  if (!container) return;

  if (!referrals || referrals.length === 0) {
    container.innerHTML = '<div class="p-3 rounded-lg bg-surface-container border border-outline-variant/20 text-xs text-on-surface-variant text-center col-span-full">Belum ada rincian rekomendasi spesifik dari klien.</div>';
    return;
  }

  container.innerHTML = referrals.map(r => `
    <div class="p-3 rounded-xl bg-surface-container border border-outline-variant/30 flex flex-col justify-between shadow-sm">
      <div class="flex justify-between items-start gap-2 mb-1.5">
        <div class="font-semibold text-xs text-on-surface truncate">${escHtml(r.client_name)}</div>
        <span class="badge text-[10px] bg-primary/10 text-primary border-primary/20">${escHtml(r.category_name || 'Booking')}</span>
      </div>
      <div class="text-xs text-on-surface-variant italic bg-surface-container-low p-2 rounded-lg mb-2">
        "${escHtml(r.sumber_informasi_detail)}"
      </div>
      <div class="text-[10px] text-on-surface-variant/70 flex justify-between">
        <span class="capitalize">via ${escHtml(r.sumber_informasi || 'referral')}</span>
        <span>${r.event_date ? new Date(r.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : ''}</span>
      </div>
    </div>
  `).join('');
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

// ── Marketing analytics filter listeners ──────────────────────────
document.getElementById('mkt-filter-category')?.addEventListener('change', loadMarketingAnalytics);
document.getElementById('mkt-filter-period')?.addEventListener('change', loadMarketingAnalytics);
document.getElementById('btn-refresh-mkt')?.addEventListener('click', () => {
  showToast('Memperbarui data marketing...', 'info');
  loadMarketingAnalytics();
});

// ── Initial load ──────────────────────────────────────────────────
loadDashboardStats();
