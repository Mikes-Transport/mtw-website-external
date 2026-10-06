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
     with data-src and hides all but the first, so prefer data-src.

     A slide is not always a link: the CMS also emits a bare <img> with no
     wrapping <a> when an image has no destination set. Reading only
     anchors silently dropped those - an unlinked item added to the
     gallery just never appeared. Handle both shapes. */
  function readSlide(el) {
    var img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (!img) return null;
    var src = img.getAttribute('data-src') || img.getAttribute('src') || '';
    if (!src) return null;
    return {
      href: el.tagName === 'A' ? (el.getAttribute('href') || '') : '',
      src: src,
      file: fileName(src),
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

  /* Which slide goes in which tile.

     Return an array of SPLITTERS arrays of slides. Index 0 is the large
     tile down the left, 1 and 2 are the two stacked on the right.

     BIG_PINS: name the images you want in the large tile, in the order you
       want them to appear. Currently the first three in the CMS list:

         item-153  spin the wheel
         item-147  Hella bluetooth speaker
         item-148  Hella rugby ball

       Those go to the large tile in this order. Everything else is dealt
       out to the two small tiles. Filenames are the ones in the CMS
       (gallery-images/item-153.jpg), not positions, so this survives
       reordering - but a newly uploaded image falls through to a small
       tile unless it is added here.

       A name that no longer matches anything is reported in the console
       rather than silently ignored.

     Leave BIG_PINS empty for 'roundRobin': deal the CMS order out in
       turn, so consecutive images never share a tile. Position 1, 4, 7 go
       to the large tile, 2 and 5 to the top right, 3 and 6 to the bottom.
     'bigFirst' gives the large tile the first half of the list instead. */
  var BIG_PINS = ['item-153.jpg', 'item-147.jpg', 'item-148.jpg'];

  var DEAL = 'roundRobin';

  /* Pull the real filename out of the resize URL, which is base64 JSON:
     .../<base64>  ->  {"key":"modtransnz/gallery-images/item-153.jpg"} */
  function fileName(src) {
    var tail = src.split('/').pop();
    var b64 = tail.replace(/\.[a-z0-9]+$/i, '');
    try {
      var json = JSON.parse(window.atob(b64));
      var key = (json && json.key) || '';
      var parts = key.split('/');
      return parts[parts.length - 1] || tail;
    } catch (e) {
      return tail;
    }
  }

  function dealPinned(slides) {
    var pool = slides.slice();
    var pinned = [];
    var i, j;

    for (i = 0; i < BIG_PINS.length; i++) {
      var want = BIG_PINS[i];
      var found = false;
      for (j = 0; j < pool.length; j++) {
        if (pool[j].file === want) {
          pinned.push(pool[j]);
          pool.splice(j, 1);
          found = true;
          break;
        }
      }
      if (!found && window.console && console.warn) {
        console.warn('[gallery] BIG_PINS: no image named "' + want + '"');
      }
    }

    var groups = [pinned];
    for (i = 1; i < SPLITTERS; i++) groups.push([]);
    var smalls = SPLITTERS - 1;
    for (i = 0; i < pool.length; i++) groups[1 + (i % smalls)].push(pool[i]);
    return groups;
  }

  function deal(slides) {
    var groups = [], i, n;

    if (BIG_PINS && BIG_PINS.length) return dealPinned(slides.slice());

    if (DEAL === 'bigFirst') {
      var half = Math.ceil(slides.length / 2);
      groups.push(slides.slice(0, half));
      for (i = 1; i < SPLITTERS; i++) groups.push([]);
      var rest = slides.slice(half);
      var smalls = SPLITTERS - 1;
      for (i = 0; i < rest.length; i++) groups[1 + (i % smalls)].push(rest[i]);
      return groups;
    }

    for (i = 0; i < SPLITTERS; i++) groups.push([]);
    for (n = 0; n < slides.length; n++) groups[n % SPLITTERS].push(slides[n]);
    return groups;
  }

  function render() {
    var wrapper = document.querySelector(WRAPPER);
    if (!wrapper || !captured || !captured.length) return false;

    var narrow = isMobile();
    teardown();

    var groups;
    if (narrow) {
      /* every slide into the single slider, so nothing is lost */
      groups = [captured.slice()];
    } else {
      groups = deal(captured);
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

/* ------------------------------------------------------------------------
   Wider carousel breakpoints.

   The theme's main.js initialises the homepage carousels with a responsive
   scale that stops at 1000px:

     .featured-products ul   0:1   600:2   1000:5
     #clearance-right ul     0:1   600:2   1000:4

   There is no breakpoint above 1000, so on a wide screen every extra pixel
   of container turns into a wider card rather than another card. At 1920
   that meant 4 cards at 426px each, and at 2560 they were 586px.

   That config lives in a script on the site owner's CDN
   (site/modtransnz/template/js/custom/main.js), not in this repo, so it
   cannot be edited from here. Instead this re-initialises the two
   carousels once the theme has finished with them, using the theme's own
   options verbatim and only extending the responsive scale.

   The options are copied exactly - autoplay, loop, nav, navText and all -
   so nothing about the carousels changes except how many show. Anything
   less and the re-init would silently drop the theme's behaviour.

   The scale tops out at 10 cards at 1920 and works back down from there:
     2200:10  1920:10  1600:9  1440:8  1200:7  1000:5  600:2  0:1

   Both carousels are optional. If Owl never loads, or the theme markup is
   absent, this quietly does nothing.
   ------------------------------------------------------------------------ */

(function widenCarousels() {
  'use strict';

  var MARK = 'data-mtw-carousel';
  var NAV = ["<i class='fa fa-angle-left'></i>", "<i class='fa fa-angle-right'></i>"];

  /* Verbatim from the theme, plus the wider steps up to 9 cards at 1920. */
  var TARGETS = [
    {
      selector: 'body.public_index .featured-products ul',
      responsive: { 0: { items: 1, nav: true }, 600: { items: 2, nav: true },
                    1000: { items: 5, nav: true }, 1200: { items: 7, nav: true },
                    1440: { items: 8, nav: true }, 1600: { items: 9, nav: true },
                    1920: { items: 10, nav: true }, 2200: { items: 10, nav: true } }
    },
    {
      selector: 'body.public_index #clearance-right ul',
      responsive: { 0: { items: 1, nav: true }, 600: { items: 2, nav: true },
                    1000: { items: 5, nav: true }, 1200: { items: 7, nav: true },
                    1440: { items: 8, nav: true }, 1600: { items: 9, nav: true },
                    1920: { items: 10, nav: true }, 2200: { items: 10, nav: true } }
    }
  ];

  var OPTION_KEYS = ['margin', 'stagePadding', 'autoplay', 'autoplayTimeout',
    'autoplaySpeed', 'autoplayHoverPause', 'loop', 'nav', 'responsiveClass',
    'navText', 'items', 'rtl', 'center', 'mouseDrag', 'touchDrag',
    'smartSpeed', 'fluidSpeed', 'dots', 'animateIn', 'animateOut'];

  function build(responsive) {
    return {
      margin: 0,
      stagePadding: 0,
      autoplay: true,
      autoplayTimeout: 3000,
      autoplaySpeed: 800,
      autoplayHoverPause: true,
      loop: true,
      nav: true,
      responsiveClass: true,
      navText: NAV,
      responsive: responsive
    };
  }

  function apply($) {
    var did = 0;

    TARGETS.forEach(function (t) {
      var $el = $(t.selector);
      if (!$el.length) return;

      /* Only re-init once per element. */
      if ($el[0].getAttribute(MARK) === 'done') return;

      /* Wait until the theme has actually initialised it. An uninitialised
         <ul> has no .owl-item children; Owl also clones items when loop is
         on, so at least a couple is a safe signal. */
      if ($el.find('.owl-item').length < 2) return;

      $el.attr(MARK, 'done');

      try {
        /* Copy whatever options the theme used, so an option this file
           does not name still survives the re-init. */
        var live = $.data($el[0], 'owl.carousel');
        var opts = build(t.responsive);
        if (live && live.options) {
          OPTION_KEYS.forEach(function (k) {
            if (k !== 'responsive' && live.options[k] !== undefined) opts[k] = live.options[k];
          });
        }
        $el.owlCarousel('destroy');
        $el.owlCarousel(opts);
        did++;
      } catch (e) {
        /* If Owl is in a state we did not expect, leave the theme's own
           carousel alone rather than risk a half-built one. */
        $el.removeAttr(MARK);
        if (window.console && console.warn) console.warn('mtw: carousel widen skipped', e);
      }
    });

    return did;
  }

  /* The theme loads Owl asynchronously with $.getScript and initialises in
     its callback, so there is no event to hook - poll for it instead. */
  function waitForOwl(attempt) {
    attempt = attempt || 0;

    if (window.jQuery && jQuery.fn && jQuery.fn.owlCarousel) {
      if (apply(jQuery) > 0) return;
    }

    if (attempt < 80) {
      setTimeout(function () { waitForOwl(attempt + 1); }, 250);
    }
  }

  /* Only the homepage has these carousels. This check has to wait for the
     body: the loader is a script in <head>, so document.body is still null
     when this file first runs. */
  function init() {
    if (!document.body) return;
    if (!/public_index/.test(document.body.className || '')) return;
    waitForOwl(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ------------------------------------------------------------------------
   Placeholder category tiles.

   TEMPORARY - remove this whole block once real blocks are in place.

   The two home category rows hold four tiles each, which means four tiles
   share the full content width and end up 422px across at 1920. The grid
   in style.css only balances properly at seven.

   These blocks cannot be added from here - the tiles are CMS layout
   blocks (div#block_13..16 in layout_group_14, and the equivalents in
   layout_group_52). So three clearly-marked placeholders are injected per
   row to show the seven-across layout, and to mark where the real content
   goes.

   To make them real, delete this block from load-css.js and the
   .mtw-cat-placeholder rules from style.css, then add three blocks to each
   group in the CMS layout manager. The script also stands down on its own
   if a row already has seven or more tiles, so it will not double up once
   the real ones exist.
   ------------------------------------------------------------------------ */

(function categoryPlaceholders() {
  'use strict';

  var MARK = 'data-mtw-placeholders';
  var GROUPS = ['.layout_group_14', '.layout_group_52'];
  var WANT = 3;
  var FULL = 7;

  function placeholder(n) {
    var el = document.createElement('div');
    el.className = 'mtw-cat-placeholder';
    el.setAttribute('aria-hidden', 'true');
    var top = document.createElement('span');
    top.className = 'mtw-cat-placeholder__n';
    top.textContent = 'tile ' + n;
    var bot = document.createElement('span');
    bot.className = 'mtw-cat-placeholder__t';
    bot.textContent = 'add in CMS';
    el.appendChild(top);
    el.appendChild(bot);
    return el;
  }

  function add() {
    if (!document.body || !/public_index/.test(document.body.className || '')) return;

    GROUPS.forEach(function (sel) {
      [].forEach.call(document.querySelectorAll(sel), function (group) {
        /* Already done, or the CMS now supplies the real tiles. */
        if (group.getAttribute(MARK) === 'done') return;
        if (group.children.length >= FULL) {
          group.setAttribute(MARK, 'done');
          return;
        }

        group.setAttribute(MARK, 'done');
        var start = group.children.length;
        for (var i = 0; i < WANT; i++) {
          group.appendChild(placeholder(start + i + 1));
        }
      });
    });
  }

  /* The groups are rebuilt by the CMS layout manager after DOM ready, so
     wait for them to appear rather than running once and finding nothing. */
  function wait(tries) {
    tries = tries || 0;
    if (document.querySelector('.layout_group_14')) {
      add();
      return;
    }
    if (tries < 40) setTimeout(function () { wait(tries + 1); }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wait(0); });
  } else {
    wait(0);
  }
})();
/* ------------------------------------------------------------------------
   Brand marquee behaviour.

   Turns the static brand list in #home-brands-inner into a strip that
   scrolls right to left forever, and turns the old "View All" button into
   an "Our Brands" heading above it.

   The strip is built as its own element rather than by reusing the CMS
   list, because that list cannot be used as-is:

   - Only 10 of its 136 tiles are shown; the rest are display:none.
     Cloning all 136 gave a strip whose clones were hidden too.
   - The CMS layout manager keeps appending tiles after DOM ready, so any
     cleanup done on the real list was undone a moment later.
   - Flex gap applies between every adjacent pair of children, so the
     hidden tiles left behind added gaps and made the run width wrong.

   So the visible logos are copied into a fresh list, which is appended
   twice to give two identical runs, and the CMS list is hidden. Nothing
   the CMS does afterwards can disturb the track.

   The loop: the strip is translated leftwards by exactly one run's width
   and then snapped back to zero, landing on the start of the second
   identical run. The repeat is invisible, so there is no end stop and no
   seam.

   Motion pauses on hover and is skipped for anyone who has asked for
   reduced motion - an endless moving strip needs to be stoppable.
   ------------------------------------------------------------------------ */

(function brandsMarquee() {
  'use strict';

  var SPEED = 45;   /* px per second */
  var LIST_MARK = 'data-mtw-source';
  var TRACK_MARK = 'data-mtw-marquee';

  function reduced() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* Read the visible logos, then build our own two-run track from them. */
  function build() {
    var inner = document.querySelector('#home-brands-inner');
    if (!inner) return null;

    var btn = inner.querySelector('a.btn');
    if (btn && !btn.classList.contains('mtw-brands-btn')) {
      btn.classList.add('mtw-brands-btn');
      /* Split onto two lines. Built as elements rather than by inserting
         markup, so the words are set as text and cannot be mangled. */
      btn.textContent = '';
      ['Our', 'Brands'].forEach(function (word) {
        var w = document.createElement('span');
        w.className = 'mtw-brands-btn__w';
        w.textContent = word;
        btn.appendChild(w);
      });
    }

    var source = inner.querySelector('ul.tag-values');
    if (!source) return null;

    if (source.getAttribute(LIST_MARK) !== 'read') {
      source.setAttribute(LIST_MARK, 'read');

      var shown = [].filter.call(source.children, function (li) {
        return window.getComputedStyle(li).display !== 'none';
      });
      if (!shown.length) return null;

      var wrap = document.createElement('div');
      wrap.className = 'mtw-marquee';

      var track = document.createElement('ul');
      track.className = 'mtw-marquee__track';
      track.setAttribute(TRACK_MARK, 'built');

      /* Two identical runs: originals, then clones. */
      shown.forEach(function (li) { track.appendChild(li.cloneNode(true)); });
      shown.forEach(function (li) {
        var copy = li.cloneNode(true);
        copy.classList.add('mtw-marquee__clone');
        track.appendChild(copy);
      });

      wrap.appendChild(track);
      source.parentNode.insertBefore(wrap, source);

      /* The CMS list stays in the document for anything that looks it up,
         but is no longer what is on screen. */
      source.style.display = 'none';
      inner.setAttribute('data-mtw-marquee-wrap', 'ready');
    }

    return { inner: inner, track: inner.querySelector('.mtw-marquee__track') };
  }

  /* Width of one run including gaps, measured between the first original
     and the first clone rather than summed. */
  function runWidth(track) {
    var a = track.querySelector('li:not(.mtw-marquee__clone)');
    var b = track.querySelector('li.mtw-marquee__clone');
    if (!a || !b) return 0;
    return Math.abs(b.getBoundingClientRect().left - a.getBoundingClientRect().left);
  }

  function start() {
    var parts = build();
    if (!parts || !parts.track) return;
    var track = parts.track;

    var half = runWidth(track);
    if (!half) return;

    if (reduced()) {
      track.style.transform = 'translate3d(0, 0, 0)';
      return;
    }

    var x = 0;
    var last = null;

    function frame(now) {
      if (last === null) last = now;
      var dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      x -= SPEED * dt;
      if (x <= -half) x += half;

      track.style.transform = 'translate3d(' + x + 'px, 0, 0)';
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { half = runWidth(track); }, 200);
    });
  }

  /* Wait for the CMS layout manager to stop appending tiles, so all the
     logos exist before the visible set is read. Two consecutive identical
     counts means it has settled. */
  function whenStable(tries, same) {
    var el = document.querySelector('#home-brands-inner ul.tag-values');
    if (!el) {
      if (tries < 40) setTimeout(function () { whenStable(tries + 1, -1); }, 250);
      return;
    }
    var n = el.children.length;
    if (n === same) { start(); return; }
    if (tries < 60) setTimeout(function () { whenStable(tries + 1, n); }, 300);
  }

  function ready() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { whenStable(0, -1); });
    } else {
      whenStable(0, -1);
    }
  }

  ready();
})();
