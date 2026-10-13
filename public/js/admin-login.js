/* ============================================================
   ADMIN LOGIN — JavaScript v3
   ============================================================ */
'use strict';

// ── Redirect if already logged in ──────────────────────────────
const savedToken = localStorage.getItem('sf_token');
if (savedToken) {
  fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${savedToken}` }
  }).then(r => {
    if (r.ok) window.location.replace('/admin/dashboard.html');
  }).catch(() => {});
}

// ── DOM refs ────────────────────────────────────────────────────
const form          = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const togglePass    = document.getElementById('toggle-password');
const alertBox      = document.getElementById('login-alert');
const btnLogin      = document.getElementById('btn-login');
const btnText       = document.getElementById('btn-login-text');
const btnSpinner    = document.getElementById('btn-login-spinner');

// ── Toggle password visibility ──────────────────────────────────
if (togglePass) {
  togglePass.addEventListener('click', () => {
    const isText = passwordInput.type === 'text';
    passwordInput.type = isText ? 'password' : 'text';
    togglePass.textContent = isText ? '👁' : '🙈';
  });
}

// ── Alert helpers ───────────────────────────────────────────────
function showAlert(msg) {
  alertBox.textContent = msg;
  alertBox.classList.remove('hidden');
  alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideAlert() {
  alertBox.classList.add('hidden');
}

// ── Loading state ───────────────────────────────────────────────
function setLoading(loading) {
  btnLogin.disabled = loading;
  btnText.textContent = loading ? 'Masuk...' : 'Masuk';
  btnSpinner.classList.toggle('hidden', !loading);
}

// ── Submit handler ──────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showAlert('Username dan password wajib diisi');
    return;
  }

  setLoading(true);

  try {
    const res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      showAlert(data.error || 'Login gagal. Coba lagi.');
      setLoading(false);
      return;
    }

    localStorage.setItem('sf_token', data.token);
    localStorage.setItem('sf_admin', JSON.stringify(data.admin || data.user));

    // Jika akun baru / wajib ganti password saat login pertama
    if (data.must_change_password) {
      promptMandatoryPasswordChange(data.token, password);
      return;
    }

    window.location.replace('/admin/dashboard.html');

  } catch (err) {
    showAlert('Tidak dapat terhubung ke server. Periksa koneksi Anda.');
    setLoading(false);
  }
});

function promptMandatoryPasswordChange(token, currentPassword) {
  let modal = document.getElementById('mandatory-pass-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'mandatory-pass-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md';
    modal.innerHTML = `
      <div class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl w-full max-w-md p-6 shadow-2xl relative text-on-surface">
        <div class="mb-4 text-center">
          <div class="inline-flex p-3 rounded-full bg-amber-500/10 text-amber-500 mb-2">
            <span class="material-symbols-outlined text-2xl">lock_reset</span>
          </div>
          <h3 class="text-xl font-bold">Wajib Ganti Password</h3>
          <p class="text-xs text-on-surface-variant mt-1">Ini adalah login pertama Anda atau password Anda telah direset oleh Owner. Silakan buat password baru.</p>
        </div>
        <form id="mandatory-pass-form" class="space-y-4">
          <div id="mandatory-pass-alert" class="hidden p-3 rounded-lg text-xs bg-error-container text-on-error-container"></div>
          <div>
            <label class="block text-xs font-semibold mb-1 text-on-surface-variant">Password Baru (min 8 karakter)</label>
            <input type="password" id="mand-new-pass" minlength="8" required class="w-full bg-surface-container-low border border-outline-variant/40 rounded-lg p-2.5 text-sm focus:outline-none focus:border-primary">
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1 text-on-surface-variant">Konfirmasi Password Baru</label>
            <input type="password" id="mand-confirm-pass" minlength="8" required class="w-full bg-surface-container-low border border-outline-variant/40 rounded-lg p-2.5 text-sm focus:outline-none focus:border-primary">
          </div>
          <button type="submit" id="mand-submit-btn" class="w-full py-2.5 bg-primary text-on-primary rounded-lg text-sm font-semibold hover:opacity-90">Simpan & Masuk ke Dashboard</button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#mandatory-pass-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newPass = modal.querySelector('#mand-new-pass').value;
      const confirmPass = modal.querySelector('#mand-confirm-pass').value;
      const alertEl = modal.querySelector('#mandatory-pass-alert');

      if (newPass !== confirmPass) {
        alertEl.textContent = 'Konfirmasi password tidak cocok.';
        alertEl.classList.remove('hidden');
        return;
      }

      const btn = modal.querySelector('#mand-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';

      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ currentPassword, newPassword: newPass })
        });
        const resData = await res.json();
        if (!res.ok) {
          alertEl.textContent = resData.error || 'Gagal mengubah password.';
          alertEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Simpan & Masuk ke Dashboard';
          return;
        }

        window.location.replace('/admin/dashboard.html');
      } catch (_) {
        alertEl.textContent = 'Terjadi kesalahan jaringan.';
        alertEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Simpan & Masuk ke Dashboard';
      }
    });
  }
}

// Enter key on username → focus password
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); passwordInput.focus(); }
});
