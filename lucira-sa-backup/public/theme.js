(function () {
  var STORAGE_KEY = 'dashboard-theme';
  var root = document.documentElement;

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  // Applied immediately (before paint) so there's no flash of the wrong theme.
  applyTheme(localStorage.getItem(STORAGE_KEY));

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;

    function currentTheme() {
      return root.getAttribute('data-theme')
        || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    }

    function updateLabel() {
      btn.textContent = currentTheme() === 'dark' ? '☀️ Light' : '🌙 Dark';
    }
    updateLabel();

    btn.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem(STORAGE_KEY, next);
      updateLabel();
    });
  });
})();
