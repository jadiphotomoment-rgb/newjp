// Script ini HARUS ada di <head> untuk mencegah Flash of Unstyled Content (FOUC)
(function () {
  var t = localStorage.getItem('sf_theme');
  if (t === 'light') document.documentElement.classList.add('light');
})();

function toggleTheme() {
  var isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('sf_theme', isLight ? 'light' : 'dark');
  document.querySelectorAll('.theme-icon').forEach(function(el) {
    el.textContent = isLight ? '🌙' : '☀️';
  });
}

document.addEventListener('DOMContentLoaded', function () {
  var isLight = document.documentElement.classList.contains('light');
  document.querySelectorAll('.theme-icon').forEach(function(el) {
    el.textContent = isLight ? '🌙' : '☀️';
  });
});
