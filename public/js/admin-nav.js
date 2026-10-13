/* ============================================================
   ADMIN NAV & RBAC HELPER — Jadiphoto.Moment
   ============================================================ */
'use strict';

(function () {
  const token = localStorage.getItem('sf_token');
  const adminStr = localStorage.getItem('sf_admin');

  // 1. Guard Autentikasi
  const currentPath = window.location.pathname;
  if (!token && !currentPath.includes('login.html')) {
    window.location.replace('/admin/login.html');
    return;
  }

  let admin = {};
  try {
    admin = JSON.parse(adminStr || '{}');
  } catch (_) {}

  // Simpan data admin global
  window.currentUser = admin;

  // 2. DOM Ready Initializer
  document.addEventListener('DOMContentLoaded', () => {
    applyRbacUI();
    fetchPendingApprovalsCount();
  });

  // 3. Terapkan RBAC pada Antarmuka (Navigasi & Badge)
  function applyRbacUI() {
    const isOwner = admin.role === 'owner' || admin.role === 'admin';

    // Sembunyikan elemen menu bertanda data-role="owner" bagi staff
    document.querySelectorAll('[data-role="owner"]').forEach(el => {
      if (!isOwner) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    });

    // Pasang User Profile / Role Badge jika ada container
    const profileContainer = document.getElementById('user-profile-badge') || document.querySelector('.user-profile-badge');
    if (profileContainer) {
      const roleBadgeClass = isOwner
        ? 'bg-amber-500/15 text-amber-500 border border-amber-500/30'
        : 'bg-primary/15 text-primary border border-primary/30';
      const roleIcon = isOwner ? 'crown' : 'badge';
      const roleLabel = isOwner ? 'Administrator (Owner)' : 'Staff';

      profileContainer.innerHTML = `
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-full ${roleBadgeClass} text-xs font-semibold">
          <span class="material-symbols-outlined text-sm leading-none">${roleIcon}</span>
          <span>${admin.name || admin.nama || 'User'} (${roleLabel})</span>
        </div>
      `;
    }

    // Update #nav-username jika ada di header/sidebar klasik
    const navUsername = document.getElementById('nav-username');
    if (navUsername) {
      const displayName = admin.name || admin.nama || 'Admin';
      const roleLabel = isOwner ? 'Owner' : 'Staff';
      navUsername.innerHTML = `${displayName} <span class="text-xs px-2 py-0.5 rounded ${isOwner ? 'bg-amber-500/20 text-amber-500' : 'bg-primary/20 text-primary'} font-semibold ml-1">${roleLabel}</span>`;
    }

    // Sambungkan tombol logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', handleLogout);
    }

    // Sambungkan tombol ganti password
    const btnChangePass = document.getElementById('btn-change-pass');
    if (btnChangePass) {
      btnChangePass.addEventListener('click', openChangePasswordModal);
    }
  }

  // 4. Update Badge Jumlah Approval Pending di Menu
  async function fetchPendingApprovalsCount() {
    const badgeEl = document.getElementById('approval-badge-count');
    if (!badgeEl) return;

    try {
      const res = await fetch('/api/approvals?status=pending&limit=1', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const total = (data.items || []).length;
        if (total > 0) {
          badgeEl.textContent = total > 99 ? '99+' : total;
          badgeEl.classList.remove('hidden');
        } else {
          badgeEl.classList.add('hidden');
        }
      }
    } catch (_) {}
  }

  // 5. Logout Handler
  async function handleLogout() {
    if (!confirm('Apakah Anda yakin ingin keluar?')) return;
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (_) {}

    localStorage.removeItem('sf_token');
    localStorage.removeItem('sf_admin');
    window.location.replace('/admin/login.html');
  }

  // 6. Modal Ganti Password Global
  function openChangePasswordModal() {
    let modal = document.getElementById('global-change-pass-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'global-change-pass-modal';
      modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm';
      modal.innerHTML = `
        <div class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl w-full max-w-md p-6 shadow-xl relative text-on-surface">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold">Ganti Password Akun</h3>
            <button class="text-on-surface-variant hover:text-on-surface" id="close-change-pass-btn">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <form id="global-change-pass-form" class="space-y-4">
            <div id="change-pass-alert" class="hidden p-3 rounded-lg text-sm bg-error-container text-on-error-container"></div>
            <div>
              <label class="block text-xs font-semibold mb-1 text-on-surface-variant uppercase">Password Saat Ini</label>
              <input type="password" id="current-pass-input" required class="w-full bg-surface-container-low border border-outline-variant/40 rounded-lg p-2.5 text-sm focus:outline-none focus:border-primary">
            </div>
            <div>
              <label class="block text-xs font-semibold mb-1 text-on-surface-variant uppercase">Password Baru (min 8 karakter)</label>
              <input type="password" id="new-pass-input" minlength="8" required class="w-full bg-surface-container-low border border-outline-variant/40 rounded-lg p-2.5 text-sm focus:outline-none focus:border-primary">
            </div>
            <div>
              <label class="block text-xs font-semibold mb-1 text-on-surface-variant uppercase">Konfirmasi Password Baru</label>
              <input type="password" id="confirm-pass-input" minlength="8" required class="w-full bg-surface-container-low border border-outline-variant/40 rounded-lg p-2.5 text-sm focus:outline-none focus:border-primary">
            </div>
            <div class="flex justify-end gap-2 pt-2">
              <button type="button" id="cancel-change-pass-btn" class="px-4 py-2 rounded-lg text-sm font-semibold hover:bg-surface-container">Batal</button>
              <button type="submit" id="submit-change-pass-btn" class="px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-semibold hover:opacity-90">Simpan Password</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#close-change-pass-btn').addEventListener('click', () => modal.classList.add('hidden'));
      modal.querySelector('#cancel-change-pass-btn').addEventListener('click', () => modal.classList.add('hidden'));

      modal.querySelector('#global-change-pass-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPass = modal.querySelector('#current-pass-input').value;
        const newPass = modal.querySelector('#new-pass-input').value;
        const confirmPass = modal.querySelector('#confirm-pass-input').value;
        const alertEl = modal.querySelector('#change-pass-alert');

        if (newPass !== confirmPass) {
          alertEl.textContent = 'Konfirmasi password baru tidak cocok';
          alertEl.classList.remove('hidden');
          return;
        }

        const submitBtn = modal.querySelector('#submit-change-pass-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Menyimpan...';

        try {
          const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ currentPassword: currentPass, newPassword: newPass })
          });
          const resData = await res.json();
          if (!res.ok) {
            alertEl.textContent = resData.error || 'Gagal mengubah password';
            alertEl.classList.remove('hidden');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Simpan Password';
            return;
          }

          alert('Password berhasil diperbarui. Silakan login kembali.');
          localStorage.removeItem('sf_token');
          localStorage.removeItem('sf_admin');
          window.location.replace('/admin/login.html');
        } catch (_) {
          alertEl.textContent = 'Terjadi kesalahan jaringan.';
          alertEl.classList.remove('hidden');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Simpan Password';
        }
      });
    }

    modal.classList.remove('hidden');
  }

  // Export functions globally
  window.adminNav = {
    logout: handleLogout,
    openChangePassword: openChangePasswordModal,
    refreshPendingBadge: fetchPendingApprovalsCount
  };
})();
