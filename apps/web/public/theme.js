(function () {
  try {
    var match = document.cookie.match(/(?:^|;\s*)vly_theme=([^;]*)/);
    var preference = match ? decodeURIComponent(match[1]) : 'system';
    var root = document.documentElement;
    if (preference === 'light' || preference === 'dark') {
      root.setAttribute('data-theme', preference);
      return;
    }
    root.setAttribute(
      'data-theme',
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    );
  } catch (error) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
