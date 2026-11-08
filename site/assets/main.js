// PhoneDesk website: small touches only. Everything works without this file.
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Nav border once the page scrolls.
  var nav = document.querySelector('.nav');
  function onScroll() { if (nav) nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Fade sections in as they arrive.
  var items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el, i) { el.style.transitionDelay = Math.min(i % 4, 3) * 70 + 'ms'; io.observe(el); });
  } else items.forEach(function (el) { el.classList.add('in'); });

  // Hero phone: cycle through the screens.
  function cycler(box, dots, ms) {
    if (!box) return null;
    var imgs = box.querySelectorAll('img.cycle'), i = 0, timer = null;
    function go(n) {
      imgs[i].classList.remove('on'); if (dots) dots.children[i].classList.remove('on');
      i = (n + imgs.length) % imgs.length;
      imgs[i].classList.add('on'); if (dots) dots.children[i].classList.add('on');
    }
    function start() { if (!reduce && ms) { stop(); timer = setInterval(function () { go(i + 1); }, ms); } }
    function stop() { clearInterval(timer); timer = null; }
    start();
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    return { go: go, stop: stop };
  }
  cycler(document.querySelector('#hero-phone .phone-screen'), document.getElementById('hero-dots'), 3600);

  // Lyrics styles: tabs switch the phone picture.
  var ly = cycler(document.getElementById('ly-screens'), null, 0);
  var tabs = document.querySelectorAll('.ly-tabs [role=tab]');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
      if (ly) ly.go(+t.getAttribute('data-i'));
    });
    t.addEventListener('keydown', function (e) {
      var k = e.key, n = +t.getAttribute('data-i');
      if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'ArrowRight' && k !== 'ArrowLeft') return;
      e.preventDefault();
      var next = tabs[(n + (k === 'ArrowDown' || k === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); next.click();
    });
  });

  // Download buttons: straight to the installer of the latest release, with its version and size.
  function fill(rel) {
    var exe = (rel.assets || []).filter(function (a) { return /^PhoneDesk-Setup-.*\.exe$/i.test(a.name); })[0];
    if (!exe) return;
    var v = String(rel.tag_name || '').replace(/^v/i, ''), mb = (exe.size / 1048576).toFixed(0);
    document.querySelectorAll('.dl-link').forEach(function (a) { a.href = exe.browser_download_url; });
    document.querySelectorAll('.dl-meta').forEach(function (s) { s.textContent = 'v' + v + ' · ' + mb + ' MB · free'; });
  }
  try {
    var cached = JSON.parse(sessionStorage.getItem('pd-rel') || 'null');
    if (cached) fill(cached);
  } catch (e) {}
  if (window.fetch) {
    fetch('https://api.github.com/repos/icdmkg2/phonedesk/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel) return;
        fill(rel);
        try { sessionStorage.setItem('pd-rel', JSON.stringify({ tag_name: rel.tag_name, assets: (rel.assets || []).map(function (a) { return { name: a.name, size: a.size, browser_download_url: a.browser_download_url }; }) })); } catch (e) {}
      })
      .catch(function () {});
  }

  // Changelog: click a screenshot to see it large; highlight the version in view.
  var box = null;
  document.addEventListener('click', function (e) {
    var img = e.target.closest && e.target.closest('.notes .shots img');
    if (img) {
      if (!box) { box = document.createElement('div'); box.className = 'lightbox'; box.innerHTML = '<img alt="">'; document.body.appendChild(box); box.addEventListener('click', function () { box.classList.remove('on'); }); }
      box.firstChild.src = img.src; box.firstChild.alt = img.alt;
      box.classList.add('on');
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box) box.classList.remove('on'); });
  var toc = document.querySelectorAll('.cl-toc a');
  if (toc.length && 'IntersectionObserver' in window) {
    var map = {};
    toc.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var vo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        toc.forEach(function (a) { a.classList.remove('on'); });
        var a = map[e.target.id]; if (a) { a.classList.add('on'); if (a.scrollIntoView && a.parentNode.scrollHeight > a.parentNode.clientHeight) a.parentNode.scrollTop = a.offsetTop - 120; }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    document.querySelectorAll('.release').forEach(function (r) { vo.observe(r); });
  }
})();
