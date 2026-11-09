// Changelog page only: click a screenshot to see it large; the version index marks the version in view.
// The page reads in full without it.
(function () {
  'use strict';
  var box = null;
  function close() { if (box) box.classList.remove('on'); }
  document.addEventListener('click', function (e) {
    var img = e.target.closest && e.target.closest('.notes .shots img');
    if (!img) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Screenshot');
      box.setAttribute('aria-modal', 'true');
      box.innerHTML = '<img alt="">';
      document.body.appendChild(box);
      box.addEventListener('click', close);
    }
    box.firstChild.src = img.src;
    box.firstChild.alt = img.alt;
    box.classList.add('on');
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  // Picking a version in the index: jump there and hold the spot while the screenshots above it load
  // (they are lazy, so each one that loads would push the target down and the scroll would end short).
  var holding = null;
  function release() { holding = null; }
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (t) { window.addEventListener(t, release, { passive: true }); });
  document.addEventListener('load', function () { if (holding) holding.scrollIntoView({ block: 'start', behavior: 'instant' }); }, true);
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.cl-toc a');
    if (!a) return;
    var target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    history.replaceState(null, '', a.getAttribute('href'));
    holding = target;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    setTimeout(function () { if (holding === target) holding = null; }, 4000);
  });

  var toc = document.querySelectorAll('.cl-toc a');
  if (!toc.length || !('IntersectionObserver' in window)) return;
  var map = {};
  toc.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      toc.forEach(function (a) { a.classList.remove('on'); });
      var a = map[e.target.id];
      if (a) { a.classList.add('on'); a.parentNode.scrollTop = a.offsetTop - 120; }
    });
  }, { rootMargin: '-30% 0px -60% 0px' });
  document.querySelectorAll('.release').forEach(function (r) { io.observe(r); });
})();
