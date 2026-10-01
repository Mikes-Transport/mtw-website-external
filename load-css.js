(function loadCss() {
  const href = "https://raw.githack.com/Mikes-Transport/mtw-website-external/main/style.css";
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
})();


/* ------------------------------------------------------------------------
   Homepage gallery: split one full-width slideshow into three independent
   ones - one large down the left, two stacked on the right - so visitors
   see three different images immediately instead of one.

   Below MOBILE_MAX the layout collapses back to a single full-width slider,
   matching the one-at-a-time behaviour of the mobile gallery. On narrow
   screens all the slides are moved into that one slider rather than the
   other two simply being hidden, so no slide becomes unreachable.

   The theme builds #gallery_scroller_1 from CMS slides and hands it to
   nivoSlider (a fade slider showing a single image at a time). We take the
   slide list, deal it out, and initialise nivoSlider on each with a
   different pause time so they never flip in lockstep.

   Runs after the theme's own nivoSlider init and replaces its output, so
   the markup is rebuilt from data captured earlier. Nothing the theme did
   is reused.

   Safe to run twice: it bails if it has already rebuilt a scroller.
   ------------------------------------------------------------------------ */
(function splitHomepageGallery() {
  'use strict';

  /* --- knobs -------------------------------------------------------- */
  var SPLITTERS = 3;               // one large left, two stacked right
  var PAUSE = [7000, 8300, 9600];  // ms per slider, staggered
  var SPEED = 500;                 // nivo fade duration

  /* Must match the 991px breakpoint in style.css. Kept as one literal here
     and one there rather than sharing a constant, so this file stays
     usable on its own. */
  var MOBILE_MAX = 991;

  var TARGET = '#gallery_scroller_1'; // the desktop gallery
  var WRAPPER = '#gallery_1';         // its container
  var MARK = 'data-mtw-split';        // idempotency flag

  var captured = null;                // slides captured pre-init
  var builtFor = null;                // 'wide' | 'narrow'

  function toArray(nodeList) {
    return Array.prototype.slice.call(nodeList);
  }

  function isMobile() {
    return window.innerWidth <= MOBILE_MAX;
  }

  /* Pull href + image out of a theme slide. The theme lazy-loads images
     with data-src and hides all but the first, so prefer data-src. */
  function readSlide(a) {
    var img = a.querySelector('img');
    if (!img) return null;
    var src = img.getAttribute('data-src') || img.getAttribute('src') || '';
    if (!src) return null;
    return {
      href: a.getAttribute('href') || '',
      src: src,
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || ''
    };
  }

  /* Capture before the theme's nivoSlider restructures the DOM. */
  function capture() {
    var scroller = document.querySelector(TARGET);
    if (!scroller || scroller.getAttribute(MARK)) return;
    captured = toArray(scroller.children).map(readSlide).filter(Boolean);
    scroller.setAttribute(MARK, 'captured');
  }

  function buildSlider(index, slides) {
    var wrap = document.createElement('div');
    wrap.className = 'mtw-gallery-slider';
    wrap.id = 'mtw_gallery_' + (index + 1);

    var scroller = document.createElement('div');
    scroller.className = 'gallery_scroller';
    scroller.setAttribute(MARK, 'built');

    slides.forEach(function (slide) {
      var a = document.createElement('a');
      a.href = slide.href;
      a.style.display = 'block';

      var img = document.createElement('img');
      img.src = slide.src;
      img.setAttribute('alt', slide.alt);
      if (slide.title) img.setAttribute('title', slide.title);
      img.style.display = 'block';

      a.appendChild(img);
      scroller.appendChild(a);
    });

    wrap.appendChild(scroller);
    return wrap;
  }

  function teardown() {
    var wrapper = document.querySelector(WRAPPER);
    if (!wrapper || !window.jQuery) return;
    toArray(wrapper.querySelectorAll('.nivoSlider')).forEach(function (el) {
      try { window.jQuery(el).nivoSlider('destroy'); } catch (e) {}
    });
  }

  function render() {
    var wrapper = document.querySelector(WRAPPER);
    if (!wrapper || !captured || !captured.length) return false;

    var narrow = isMobile();
    teardown();

    var groups = [];
    if (narrow) {
      /* every slide into the single slider, so nothing is lost */
      groups = [captured.slice()];
    } else {
      /* round-robin so consecutive slides land in different sliders */
      for (var i = 0; i < SPLITTERS; i++) groups.push([]);
      captured.forEach(function (slide, i) {
        groups[i % SPLITTERS].push(slide);
      });
    }

    wrapper.innerHTML = '';
    wrapper.setAttribute(MARK, 'split');
    builtFor = narrow ? 'narrow' : 'wide';

    var holder = document.createElement('div');
    holder.className = 'mtw-gallery';
    if (narrow) holder.classList.add('is-single');

    groups.forEach(function (slides, i) {
      if (slides.length) holder.appendChild(buildSlider(i, slides));
    });

    wrapper.appendChild(holder);
    return true;
  }

  function initSliders(attempt) {
    var tries = attempt || 0;
    if (!(window.jQuery && window.jQuery.fn && window.jQuery.fn.nivoSlider)) {
      if (tries < 40) return setTimeout(function () { initSliders(tries + 1); }, 250);
      return;
    }
    var $ = window.jQuery;
    toArray(document.querySelectorAll(WRAPPER + ' .mtw-gallery-slider')).forEach(function (el, i) {
      var scroller = el.querySelector('.gallery_scroller');
      if (!scroller || $(scroller).data('nivoSlider')) return;
      $(scroller).nivoSlider({
        effect: 'fade',
        slices: 15,
        boxCols: 8,
        boxRows: 4,
        animSpeed: SPEED,
        pauseTime: PAUSE[i % PAUSE.length],
        startSlide: 0
      });
    });
  }

  function start() {
    if (!render()) return;
    initSliders(0);
  }

  /* Rebuild only when the layout actually changes shape - crossing the
     mobile breakpoint - not on every resize event. */
  var timer = null;
  function onResize() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var next = isMobile() ? 'narrow' : 'wide';
      if (next === builtFor) return;
      start();
    }, 200);
  }

  /* The theme initialises nivoSlider on window load. Capture on DOM ready,
     then rebuild on load so we run after it and simply discard its work. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', capture);
  } else {
    capture();
  }

  if (document.readyState === 'complete') {
    setTimeout(start, 0);
  } else {
    window.addEventListener('load', function () { setTimeout(start, 0); });
  }

  window.addEventListener('resize', onResize);
})();
