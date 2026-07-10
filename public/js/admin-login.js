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
    localStorage.setItem('sf_admin', JSON.stringify(data.admin));
    window.location.replace('/admin/dashboard.html');

  } catch (err) {
    showAlert('Tidak dapat terhubung ke server. Periksa koneksi Anda.');
    setLoading(false);
  }
});

// Enter key on username → focus password
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); passwordInput.focus(); }
});
