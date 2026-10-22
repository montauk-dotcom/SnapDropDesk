/* Theme + accent colour, shared by the phone page and the desktop window. */
(() => {
  'use strict';
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };

  /** Text colour that stays readable on top of the accent (yellow gets dark text, blue gets white). */
  const inkFor = (hex) => {
    const L = lum(hex);
    return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#ffffff' : '#1b1a17';
  };

  window.applyAppearance = ({ theme, accent } = {}) => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (/^#[0-9a-f]{6}$/i.test(accent || '')) {
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-ink', inkFor(accent));
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', accent);
    }
  };
})();
