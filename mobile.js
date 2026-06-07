document.addEventListener('DOMContentLoaded', () => {
  const nav    = document.querySelector('nav');
  const toggle = document.querySelector('.nav-toggle');
  if (!nav || !toggle) return;

  // Create overlay element and append to body
  const overlay = document.createElement('div');
  overlay.className = 'nav-overlay';
  document.body.appendChild(overlay);

  function openNav() {
    nav.classList.add('nav-open');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden'; // prevent scroll behind drawer
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
  }

  function closeNav() {
    nav.classList.remove('nav-open');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  }

  // Toggle on hamburger click
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    nav.classList.contains('nav-open') ? closeNav() : openNav();
  });

  // Close when overlay (dimmed background) is tapped
  overlay.addEventListener('click', closeNav);

  // Close when any nav link or button is tapped
  nav.querySelectorAll('.nav-links a, .nav-links button').forEach(el => {
    el.addEventListener('click', closeNav);
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });

  // Close if screen resizes to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeNav();
  });
});
