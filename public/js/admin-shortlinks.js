'use strict';

// ── Auth guard ──────────────────────────────────────────────────
const token = localStorage.getItem('sf_token');
const admin = JSON.parse(localStorage.getItem('sf_admin') || 'null');
if (!token || !admin) {
  window.location.replace('/admin/login.html');
}
if (document.getElementById('nav-username')) {
  document.getElementById('nav-username').textContent = admin.name || admin.username;
}
if (document.getElementById('btn-logout')) {
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('sf_token');
    localStorage.removeItem('sf_admin');
    window.location.replace('/admin/login.html');
  });
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
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Modals ────────────────────────────────────────────────────────
window.openModal = function(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
};
window.closeModal = function(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
};

// ── Shortlinks Logic ──────────────────────────────────────────────
const formCreate = document.getElementById('form-create-shortlink');
const createResult = document.getElementById('create-result');
const resultLink = document.getElementById('result-link');
const btnCopyResult = document.getElementById('btn-copy-result');
const tbody = document.getElementById('shortlinks-tbody');

async function loadShortlinks() {
  try {
    const res = await apiFetch('/api/shortlinks');
    if (!res.ok) throw new Error('Gagal mengambil data');
    const data = await res.json();
    renderTable(data);
  } catch (err) {
    showToast('Gagal memuat daftar shortlink', 'error');
  }
}

function renderTable(data) {
  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-on-surface-variant">Belum ada shortlink yang dibuat.</td></tr>';
    return;
  }
  
  tbody.innerHTML = '';
  data.forEach(item => {
    const tr = document.createElement('tr');
    const shortUrl = `${window.location.origin}/l/${item.short_code}`;
    const date = new Date(item.created_at).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    
    tr.innerHTML = `
      <td>
        <div class="flex items-center gap-2">
          <a href="${shortUrl}" target="_blank" class="font-semibold text-primary hover:underline">${item.short_code}</a>
          <button class="btn-icon text-on-surface-variant hover:text-primary transition-colors cursor-pointer border-none bg-transparent" onclick="copyToClipboard('${shortUrl}')" title="Copy">
            <span class="material-symbols-outlined text-[16px]">content_copy</span>
          </button>
        </div>
      </td>
      <td class="max-w-[200px] truncate" title="${item.original_url}">
        <a href="${item.original_url}" target="_blank" class="text-on-surface-variant hover:text-primary hover:underline">${item.original_url}</a>
      </td>
      <td class="text-sm text-on-surface-variant">${date}</td>
      <td class="text-center font-semibold">${item.total_clicks}</td>
      <td class="text-right flex items-center justify-end gap-2">
        <button class="btn btn-sm btn-outline hover:bg-surface-container border-none" onclick="showStats(${item.id})" title="Analitik">
          <span class="material-symbols-outlined text-[16px]">bar_chart</span>
        </button>
        <button class="btn btn-sm btn-outline hover:bg-surface-container border-none" onclick="openEdit(${item.id}, '${item.original_url}', '${item.short_code}')" title="Edit">
          <span class="material-symbols-outlined text-[16px]">edit</span>
        </button>
        <button class="btn btn-sm btn-outline text-error hover:bg-error/10 border-none" onclick="deleteLink(${item.id})" title="Hapus">
          <span class="material-symbols-outlined text-[16px]">delete</span>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

formCreate.addEventListener('submit', async (e) => {
  e.preventDefault();
  const urlInput = document.getElementById('original_url').value;
  const customInput = document.getElementById('custom_code').value;
  const btn = document.getElementById('btn-create');
  
  const originalText = btn.innerHTML;
  btn.innerHTML = '<div class="spinner w-4 h-4 border-2 border-white/30 border-l-white"></div>';
  btn.disabled = true;

  try {
    const res = await apiFetch('/api/shortlinks', {
      method: 'POST',
      body: JSON.stringify({ original_url: urlInput, custom_code: customInput })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Gagal membuat link');
    }
    
    const data = await res.json();
    const shortUrl = `${window.location.origin}/l/${data.short_code}`;
    
    resultLink.href = shortUrl;
    resultLink.textContent = shortUrl;
    createResult.classList.remove('hidden');
    
    // reset form
    document.getElementById('original_url').value = '';
    document.getElementById('custom_code').value = '';
    
    showToast('Shortlink berhasil dibuat!', 'success');
    loadShortlinks(); // refresh table
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
});

btnCopyResult.addEventListener('click', () => {
  copyToClipboard(resultLink.textContent);
});

window.copyToClipboard = function(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Disalin ke clipboard!', 'success');
  }).catch(() => {
    showToast('Gagal menyalin', 'error');
  });
};

window.deleteLink = async function(id) {
  if (!confirm('Yakin ingin menghapus shortlink ini?')) return;
  try {
    const res = await apiFetch(`/api/shortlinks/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Gagal menghapus');
    showToast('Shortlink dihapus', 'success');
    loadShortlinks();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ── Edit Logic ──────────────────────────────────────────────────
const formEdit = document.getElementById('form-edit-link');
window.openEdit = function(id, originalUrl, shortCode) {
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-original-url').value = originalUrl;
  document.getElementById('edit-short-code').value = shortCode;
  openModal('modal-edit-link');
};

formEdit.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const originalUrl = document.getElementById('edit-original-url').value;
  const shortCode = document.getElementById('edit-short-code').value;
  const btn = document.getElementById('btn-save-edit');
  
  btn.disabled = true;
  try {
    const res = await apiFetch(`/api/shortlinks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ original_url: originalUrl, short_code: shortCode })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Gagal menyimpan');
    }
    showToast('Shortlink diperbarui', 'success');
    closeModal('modal-edit-link');
    loadShortlinks();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Stats Logic ─────────────────────────────────────────────────
let chartInstance = null;
window.showStats = async function(id) {
  openModal('modal-stats');
  document.getElementById('stats-title').textContent = 'Memuat Analitik...';
  
  try {
    const res = await apiFetch(`/api/shortlinks/${id}/stats`);
    if (!res.ok) throw new Error('Gagal memuat analitik');
    const data = await res.json();
    
    document.getElementById('stats-title').textContent = 'Analitik Detail';
    
    // Render Chart
    const ctx = document.getElementById('clicksChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.trend.map(t => t.date),
        datasets: [{
          label: 'Klik per Hari',
          data: data.trend.map(t => t.clicks),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 } }
        }
      }
    });
    
    // Render Referrers
    const refUl = document.getElementById('stats-referrers');
    refUl.innerHTML = data.referrers.length === 0 ? '<li class="text-on-surface-variant">Belum ada data</li>' : 
      data.referrers.map(r => `<li class="flex justify-between items-center"><span class="truncate pr-2">${r.referrer}</span><span class="font-bold">${r.clicks}</span></li>`).join('');
      
    // Render Devices
    const devUl = document.getElementById('stats-devices');
    devUl.innerHTML = data.devices.length === 0 ? '<li class="text-on-surface-variant">Belum ada data</li>' : 
      data.devices.map(d => `<li class="flex justify-between items-center"><span class="truncate pr-2">${d.device}</span><span class="font-bold">${d.count}</span></li>`).join('');
      
  } catch (err) {
    document.getElementById('stats-title').textContent = 'Analitik Detail (Error)';
    showToast(err.message, 'error');
  }
};

// Initialize
loadShortlinks();

