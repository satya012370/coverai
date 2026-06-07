document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('nav');
  const toggle = document.querySelector('.nav-toggle');
  if (!nav || !toggle) return;

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', open);
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });

  nav.querySelectorAll('.nav-links a, .nav-links button').forEach(el => {
    el.addEventListener('click', () => {
      nav.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
    });
  });
});
