// ── SORTIR FOTO — Theme Manager ────────────────────────────────
// Dijalankan di <head> untuk mencegah FOUC (Flash of Unstyled Content)
(function () {
  var t = localStorage.getItem('sf_theme');
  if (t === 'light') document.documentElement.classList.add('light');
})();

// Sync semua theme-toggle icons
function _syncThemeIcons(isLight) {
  // Emoji icons (legacy)
  document.querySelectorAll('.theme-icon').forEach(function(el) {
    el.textContent = isLight ? '🌙' : '☀️';
  });
  // Material Symbols icons di header (menggunakan textContent dari span.material-symbols-outlined)
  document.querySelectorAll('[data-theme-icon]').forEach(function(el) {
    el.textContent = isLight ? 'dark_mode' : 'light_mode';
  });
}

function toggleTheme() {
  var isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('sf_theme', isLight ? 'light' : 'dark');
  _syncThemeIcons(isLight);
}

document.addEventListener('DOMContentLoaded', function () {
  var isLight = document.documentElement.classList.contains('light');
  _syncThemeIcons(isLight);
});
