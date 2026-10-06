(function mtwRegoDrawer() {
  'use strict';

  if (window.__mtwRegoDrawerLoaded) return;
  window.__mtwRegoDrawerLoaded = true;

  /* --- config ----------------------------------------------------------- */

  var DEFAULTS = {
    /* Where "View all parts" goes. Gets ?rego=XXXX appended. */
    regoPageUrl: 'page/19/testing-page',

    /* Round icon, fixed to the corner. false = only use data-mtw-rego-open. */
    floatingButton: true,
    position: { right: '20px', bottom: '20px' },

    /* Nav mode: a CSS selector. When set, the icon goes inside that element
       (inheriting its text colour) and the floating icon is not used. */
    navTarget: '',
    navPosition: 'append',
    navLabel: '',
    accent: '#d71920',
    zIndex: 99999,

    label: 'Find your trailer by registration',
    title: 'Find your trailer',
    intro: 'Enter your registration number to see your trailer and its parts.',

    csvSource: 'firebase',

    firebase: {
      config: {
        apiKey: 'AIzaSyA6i9ZVdE1xmSzjebcx1zUJpA-Zuy_DgSs',
        authDomain: 'mtw-lookup.firebaseapp.com',
        projectId: 'mtw-lookup',
        appId: '1:365628896617:web:f3d718fad93b14501679f8'
      },
      /* Same named app as model-lookup.js, so if both scripts are on one page
         they share a single Firebase instance instead of making two. */
      appName: 'mtw-model-lookup',
      collection: 'csv-data',
      document: 'chassis_master_mte_export',
      field: 'link',
      api: 'https://firestore.googleapis.com/v1/projects',
      appModule: 'https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js',
      module: 'https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js',
      timeoutMs: 8000
    },

    papaUrl: 'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
    csvUrl: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/data/rego_search.csv',

    trailerMapUrl: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/img/trailers.json',
    trailerMapMirrors: [
      'https://cdn.jsdelivr.net/gh/Mikes-Transport/mtw-website-external@main/model-lookup/img/trailers.json',
      'https://raw.githubusercontent.com/Mikes-Transport/mtw-website-external/main/model-lookup/img/trailers.json'
    ],
    imgBase: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/img/',
    imgMirrors: [
      'https://cdn.jsdelivr.net/gh/Mikes-Transport/mtw-website-external@main/model-lookup/img/',
      'https://raw.githubusercontent.com/Mikes-Transport/mtw-website-external/main/model-lookup/img/'
    ],
    drawingRetries: 2,
    imageTimeoutMs: 8000,

    columns: { rego: 'registration' },
    codePattern: /^CODE(\d+)$/i,
    redactWords: ['Alion'],
    cacheHours: 12,

    /* The summary cards. Same fields as the full widget; only ones with a
       value are shown. */
    factFields: [
      { label: 'Axles', key: 'axle' },
      { label: 'Suspension', key: 'suspension_type_and_component_part_no' },
      { label: 'Brakes', key: 'brake_valves_type' },
      { label: 'GVM', key: 'gvw_atm' },
      { label: 'Tare', key: 'tare' },
      { label: 'Coupling', key: 'king_pin_type_and_serial_no' },
      { label: 'Tyres', key: 'tyre_type_and_size' },
      { label: 'Built for', key: 'built_for' }
    ]
  };

  /* Settings the drawer shares with the full widget, so a page that already
     configures model-lookup.js does not have to repeat them. */
  var SHARED_KEYS = ['firebase', 'csvSource', 'csvUrl', 'papaUrl', 'trailerMapUrl',
    'trailerMapMirrors', 'imgBase', 'imgMirrors', 'redactWords', 'columns',
    'factFields', 'cacheHours'];

  function merge(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (over) {
      for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
      if (over.columns && base.columns) out.columns = merge(base.columns, over.columns);
      if (over.position && base.position) out.position = merge(base.position, over.position);
      if (over.firebase && base.firebase) {
        out.firebase = merge(base.firebase, over.firebase);
        if (over.firebase.config && base.firebase.config) {
          out.firebase.config = merge(base.firebase.config, over.firebase.config);
        }
      }
    }
    return out;
  }

  var userCfg = window.MTWRegoDrawer || {};
  var sharedCfg = {};
  SHARED_KEYS.forEach(function (k) {
    if (window.MTWModelLookup && window.MTWModelLookup[k] !== undefined) {
      sharedCfg[k] = window.MTWModelLookup[k];
    }
  });
  var cfg = merge(merge(DEFAULTS, sharedCfg), userCfg);

  /* --- helpers ---------------------------------------------------------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function warn() {
    if (window.console && console.warn) {
      console.warn.apply(console, ['[rego-drawer]'].concat([].slice.call(arguments)));
    }
  }

  function regoKey(v) {
    return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(label + ' timed out')); }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  function loadFonts() {
    if (document.querySelector('link[data-mtw-ml-fonts]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500&display=swap';
    link.setAttribute('data-mtw-ml-fonts', '');
    document.head.appendChild(link);
  }

  /* --- cache (same keys and shape as model-lookup.js) -------------------- */

  function cacheGet(key) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return null;
      var hit = JSON.parse(raw);
      if (!hit || !hit.at || !hit.body) return null;
      if (Date.now() - hit.at > cfg.cacheHours * 3600 * 1000) return null;
      return hit.body;
    } catch (e) { return null; }
  }

  function cacheSet(key, body) {
    try {
      window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), body: body }));
    } catch (e) { /* the cache is an optimisation, never a requirement */ }
  }

  /* Validated so an HTML error page or login redirect (still HTTP 200) is never
     returned or cached as if it were the CSV. */
  function getText(url, validate) {
    var hit = cacheGet('mtw-ml:' + url);
    if (hit != null && (!validate || validate(hit))) return Promise.resolve(hit);

    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
        return r.text();
      })
      .then(function (body) {
        if (validate && !validate(body)) throw new Error(url + ' did not look like the CSV');
        cacheSet('mtw-ml:' + url, body);
        return body;
      });
  }

  /* --- csv: firebase first, csvUrl as the backup ------------------------- */

  var papaPromise = null;
  function loadPapa() {
    if (window.Papa && window.Papa.parse) return Promise.resolve(window.Papa);
    if (!cfg.papaUrl) return Promise.resolve(null);
    if (papaPromise) return papaPromise;

    papaPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = cfg.papaUrl;
      s.async = true;
      s.onload = function () { resolve(window.Papa || null); };
      s.onerror = function () {
        warn('PapaParse did not load, using the built-in CSV parser');
        resolve(null);
      };
      document.head.appendChild(s);
    });
    return papaPromise;
  }

  function firebaseConfigIsPlaceholder(config) {
    if (!config) return true;
    return ['apiKey', 'appId'].some(function (k) {
      return !config[k] || /^YOUR_/i.test(String(config[k]));
    });
  }

  /* Initialise Firebase ourselves, then read the document. */
  function linkViaSdk() {
    var f = cfg.firebase;

    if (firebaseConfigIsPlaceholder(f.config)) {
      return Promise.reject(new Error('firebase.config still has placeholder apiKey/appId'));
    }

    var run = Promise.all([import(f.appModule), import(f.module)]).then(function (mods) {
      var appMod = mods[0];
      var fs = mods[1];

      if (!appMod.initializeApp || !appMod.getApps || !fs.getFirestore || !fs.doc || !fs.getDoc) {
        throw new Error('Firebase modules are missing expected exports');
      }

      var app = appMod.getApps().filter(function (a) { return a.name === f.appName; })[0] ||
                appMod.initializeApp(f.config, f.appName);

      return fs.getDoc(fs.doc(fs.getFirestore(app), f.collection, f.document));
    }).then(function (snap) {
      if (!snap || !snap.exists || !snap.exists()) {
        throw new Error('no ' + f.collection + '/' + f.document);
      }
      var link = (snap.data() || {})[f.field];
      if (!link) throw new Error('no "' + f.field + '" in that document');
      return String(link);
    });

    return withTimeout(run, f.timeoutMs, 'Firebase SDK read');
  }

  /* Firestore REST: same document, no SDK and no key needed. */
  function linkViaRest() {
    var f = cfg.firebase;
    var projectId = f.config && f.config.projectId;
    if (!projectId) return Promise.reject(new Error('firebase.config.projectId is not set'));

    var url = f.api + '/' + projectId + '/databases/(default)/documents/' +
              encodeURIComponent(f.collection) + '/' + encodeURIComponent(f.document);

    return withTimeout(
      fetch(url, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
        return r.json();
      }),
      f.timeoutMs, 'Firestore REST read'
    ).then(function (doc) {
      var field = doc && doc.fields && doc.fields[f.field];
      var link = field && field.stringValue;
      if (!link) throw new Error('no "' + f.field + '" in that document');
      return String(link);
    });
  }

  function firestoreCsvLink() {
    return linkViaSdk().catch(function (e) {
      warn('Firebase SDK route failed (' + (e && e.message) + '), trying REST');
      return linkViaRest();
    });
  }

  function looksLikeCsv(text) {
    return typeof text === 'string' && text.slice(0, 20000).indexOf(cfg.columns.rego) > -1;
  }

  function loadCsvText() {
    if (cfg.csvSource !== 'firebase') return getText(cfg.csvUrl, looksLikeCsv);

    return firestoreCsvLink()
      .then(function (link) { return getText(link, looksLikeCsv); })
      .catch(function (e) {
        warn('could not load the CSV via Firebase (' + (e && e.message) + '), falling back to csvUrl');
        return getText(cfg.csvUrl, looksLikeCsv);
      });
  }

  function parseCsvAsync(text) {
    return loadPapa().then(function (papa) {
      if (!papa || !papa.parse) return parseCsv(text);

      var res = papa.parse(String(text).replace(/^\uFEFF/, ''), {
        header: false,
        skipEmptyLines: 'greedy'
      });
      if (!res || !res.data || !res.data.length) return { header: [], rows: [] };

      var header = (res.data.shift() || []).map(function (h) { return String(h).trim(); });
      var rows = res.data.filter(function (r) {
        return r.length > 1 || (r[0] || '').trim() !== '';
      });
      return { header: header, rows: rows };
    });
  }

  /* Fallback parser for when PapaParse is blocked. Quoted fields contain
     commas throughout this file, so a plain split(',') would shift columns. */
  function parseCsv(text) {
    var rows = [], row = [], field = '', quoted = false, i, ch;
    text = String(text).replace(/^\uFEFF/, '');

    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);

      if (quoted) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
        continue;
      }

      if (ch === '"') { quoted = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }

      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
        continue;
      }

      field += ch;
    }

    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);

    if (!rows.length) return { header: [], rows: [] };
    var header = rows.shift().map(function (h) { return h.trim(); });
    return {
      header: header,
      rows: rows.filter(function (r) { return r.length > 1 || (r[0] || '').trim() !== ''; })
    };
  }

  /* --- shaping ---------------------------------------------------------- */

  /* CODE columns grouped by number, because the header repeats some of them
     (CODE100 twice, CODE250 three times...). */
  function codeColumns(header) {
    var byNumber = {};
    header.forEach(function (name, i) {
      var m = name.match(cfg.codePattern);
      if (!m) return;
      var n = parseInt(m[1], 10);
      (byNumber[n] = byNumber[n] || []).push(i);
    });
    return byNumber;
  }

  /* How many distinct part codes this row carries. */
  function countCodes(row, byNumber) {
    var count = 0;
    Object.keys(byNumber).forEach(function (n) {
      var cols = byNumber[n];
      for (var i = 0; i < cols.length; i++) {
        if ((row[cols[i]] || '').trim()) { count++; return; }
      }
    });
    return count;
  }

  /* Every plausible rego in a messy cell: "31DJA  ( New 55BQZ)" is findable by
     both 31DJA and 55BQZ. */
  function regoCandidates(raw) {
    var text = String(raw || '').trim();
    if (!text) return [];

    var out = [];
    var add = function (v) {
      var k = regoKey(v);
      if (k.length >= 2 && k.length <= 8 && out.indexOf(k) === -1) out.push(k);
    };

    add(text);

    var m;
    if ((m = text.match(/\(([^)]*)\)/))) add(m[1]);
    if ((m = text.match(/[-–—]\s*'?([A-Za-z0-9]{2,8})\s*$/))) add(m[1]);
    if ((m = text.match(/\s{2,}([A-Za-z0-9]{2,8})\s*$/))) add(m[1]);

    return out;
  }

  /* Only the columns the drawer shows are kept. */
  function shape(parsed) {
    var header = parsed.header;
    var first = {};
    header.forEach(function (name, i) { if (first[name] === undefined) first[name] = i; });

    var keys = ['trailer_type', 'model_no'];
    cfg.factFields.forEach(function (f) { if (keys.indexOf(f.key) === -1) keys.push(f.key); });
    var cols = keys.map(function (k) { return { key: k, i: first[k] }; })
      .filter(function (c) { return c.i !== undefined; });

    var byNumber = codeColumns(header);
    var regoIndex = header.indexOf(cfg.columns.rego);
    var index = {};

    parsed.rows.forEach(function (row) {
      var candidates = regoIndex === -1 ? [] : regoCandidates(row[regoIndex]);
      if (!candidates.length) return;

      var specs = {};
      cols.forEach(function (c) {
        var v = (row[c.i] || '').trim();
        if (v) specs[c.key] = v;
      });

      var rec = {
        rego: candidates[0],
        candidates: candidates,
        specs: specs,
        type: specs.trailer_type || '',
        model: specs.model_no || '',
        codeCount: countCodes(row, byNumber)
      };

      /* First match wins, unless a later row for the same rego has parts and
         the earlier one does not. */
      candidates.forEach(function (k) {
        var prev = index[k];
        if (!prev || (!prev.codeCount && rec.codeCount)) index[k] = rec;
      });
    });

    return index;
  }

  function find(raw, index) {
    var key = regoKey(raw);
    if (key.length < 2) return { rec: null, short: true };

    if (index[key]) return { rec: index[key] };

    /* Partly-remembered rego: accept it only if it points at one trailer. */
    var hits = [];
    for (var k in index) {
      if (Object.prototype.hasOwnProperty.call(index, k) && k.indexOf(key) > -1) hits.push(k);
    }
    if (hits.length === 1) return { rec: index[hits[0]] };
    return { rec: null, ambiguous: hits.length > 1 };
  }

  /* Scrubs supplier names from displayed values. Display only. */
  function display(value) {
    var s = String(value == null ? '' : value);

    cfg.redactWords.forEach(function (w) {
      var safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(safe + '\\b', 'gi'), ' ');
    });

    s = s.replace(/\s*\/\s*/g, '/').replace(/\s{2,}/g, ' ').trim();

    var trimmed = s.replace(/^[\s,;:.\-\/]+/, '').replace(/[\s,;:.\-\/]+$/, '').trim();
    if (trimmed) s = trimmed;

    return s || '\u2014';
  }

  /* --- trailer drawings -------------------------------------------------- */

  function validTrailerMap(m) {
    return !!(m && Array.isArray(m.match) && m.images && typeof m.images === 'object');
  }

  /* trailers.json with retries and backup hosts. If this fails there are no
     drawings, so it is worth being persistent. */
  function loadTrailerMap() {
    var cacheKey = 'mtw-ml:' + cfg.trailerMapUrl;
    var hit = cacheGet(cacheKey);
    if (hit != null) {
      try {
        var cached = JSON.parse(hit);
        if (validTrailerMap(cached)) return Promise.resolve(cached);
      } catch (e) { /* fall through to the network */ }
    }

    var urls = [cfg.trailerMapUrl].concat(cfg.trailerMapMirrors || []).filter(function (u, i, a) {
      return u && a.indexOf(u) === i;
    });

    function once(url, bust) {
      var full = url + (bust ? (url.indexOf('?') > -1 ? '&' : '?') + 'r=' + Date.now() : '');
      return withTimeout(
        fetch(full, { credentials: 'omit' }).then(function (r) {
          if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
          return r.json();
        }),
        cfg.imageTimeoutMs, 'trailers.json'
      ).then(function (m) {
        if (!validTrailerMap(m)) throw new Error(url + ' is not a valid trailer map');
        return m;
      });
    }

    function round(n) {
      var chain = Promise.reject(new Error('start'));
      urls.forEach(function (u) {
        chain = chain.catch(function () { return once(u, n > 0); });
      });
      return chain.catch(function (e) {
        if (n >= cfg.drawingRetries) throw e;
        return new Promise(function (r) { setTimeout(r, 400 * (n + 1)); })
          .then(function () { return round(n + 1); });
      });
    }

    return round(0).then(function (m) {
      cacheSet(cacheKey, JSON.stringify(m));
      return m;
    });
  }

  /* Which drawing a trailer type gets, or null (a normal case for a few types). */
  function drawingSlug(type, map) {
    if (!map || !map.match) return null;

    var n = String(type || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!n) return null;

    for (var i = 0; i < map.match.length; i++) {
      var rule = map.match[i];
      if (!rule.re) continue;
      var re;
      try { re = new RegExp(rule.re, 'i'); } catch (e) { continue; }
      if (!re.test(n)) continue;
      if (!map.images[rule.image]) continue;
      return rule.image;
    }
    return null;
  }

  var drawingOk = {};

  function tryImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        img.onload = img.onerror = null;
        reject(new Error('timed out'));
      }, cfg.imageTimeoutMs);

      img.onload = function () {
        if (done) return;
        done = true; clearTimeout(t);
        resolve(url);
      };
      img.onerror = function () {
        if (done) return;
        done = true; clearTimeout(t);
        reject(new Error('failed'));
      };
      img.src = url;
    });
  }

  /* Preloads the PNG across the primary host and its mirrors, retrying with a
     backoff, and resolves with a URL that is known to have loaded. */
  function loadDrawing(slug) {
    if (drawingOk[slug]) return Promise.resolve(drawingOk[slug]);

    var bases = [cfg.imgBase].concat(cfg.imgMirrors || []).filter(function (b, i, a) {
      return b && a.indexOf(b) === i;
    });
    if (!bases.length) bases = [''];

    function round(n) {
      var chain = Promise.reject(new Error('start'));
      bases.forEach(function (base) {
        chain = chain.catch(function () {
          return tryImage(base + slug + '.png' + (n ? '?r=' + Date.now() : ''));
        });
      });
      return chain.catch(function (e) {
        if (n >= cfg.drawingRetries) throw e;
        return new Promise(function (r) { setTimeout(r, 400 * (n + 1)); })
          .then(function () { return round(n + 1); });
      });
    }

    return round(0).then(function (url) {
      drawingOk[slug] = url;
      return url;
    });
  }

  /* --- data (loaded once, on first use) ---------------------------------- */

  var dataPromise = null;
  var trailerMap = null;

  function ensureData() {
    if (dataPromise) return dataPromise;

    dataPromise = Promise.all([
      loadCsvText().then(parseCsvAsync),
      loadTrailerMap().catch(function (e) {
        warn('no trailer drawings (will retry on search):', e && e.message);
        return null;
      })
    ]).then(function (both) {
      if (!both[0].rows.length) throw new Error('CSV had no data rows');
      trailerMap = both[1];
      return shape(both[0]);
    }).catch(function (e) {
      /* Not kept, so the next search tries again instead of replaying the
         same failure. */
      dataPromise = null;
      throw e;
    });

    return dataPromise;
  }

  /* --- styles ------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById('mtw-rd-styles')) return;

    var pos = cfg.position || {};
    var css = [
      '.mtw-rd,.mtw-rd *,.mtw-rd-fab{box-sizing:border-box}',
      '.mtw-rd [hidden]{display:none!important}',

      /* floating icon */
      '.mtw-rd-fab{position:fixed;z-index:' + cfg.zIndex + ';' +
        (pos.right != null ? 'right:' + pos.right + ';' : '') +
        (pos.left != null ? 'left:' + pos.left + ';' : '') +
        (pos.bottom != null ? 'bottom:' + pos.bottom + ';' : '') +
        (pos.top != null ? 'top:' + pos.top + ';' : '') +
        'width:56px;height:56px;border-radius:50%;border:0;padding:0;cursor:pointer;' +
        'display:flex;align-items:center;justify-content:center;color:#fff;background:' + cfg.accent + ';' +
        'box-shadow:0 6px 20px rgba(15,23,42,.28);transition:transform .15s ease,box-shadow .15s ease}',
      '.mtw-rd-fab:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(15,23,42,.32)}',
      '.mtw-rd-fab:focus-visible{outline:3px solid #fff;outline-offset:-6px;box-shadow:0 0 0 3px ' + cfg.accent + '}',
      '.mtw-rd-fab svg{width:26px;height:26px}',

      /* nav icon: inline, transparent, takes the nav's text colour */
      '.mtw-rd-nav{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;' +
        'height:40px;min-width:40px;padding:0 8px;border:0;border-radius:10px;background:transparent;' +
        'color:inherit;font:inherit;font-weight:700;line-height:1;cursor:pointer}',
      '.mtw-rd-nav:hover{background:rgba(127,127,127,.18)}',
      '.mtw-rd-nav:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
      '.mtw-rd-nav svg{width:24px;height:24px;flex:none}',
      '.mtw-rd-nav span{font-size:14px}',
      '.mtw-rd-nav-li{list-style:none;display:flex;align-items:center}',

      /* drawer shell */
      '.mtw-rd{position:fixed;inset:0;z-index:' + cfg.zIndex + ';visibility:hidden;' +
        'transition:visibility 0s linear .3s;color:#1b2433;' +
        "font-family:'Manrope',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
        'font-size:15px;line-height:1.4}',
      '.mtw-rd.is-open{visibility:visible;transition-delay:0s}',
      '.mtw-rd__scrim{position:absolute;inset:0;background:rgba(15,23,42,.45);opacity:0;transition:opacity .3s ease}',
      '.mtw-rd.is-open .mtw-rd__scrim{opacity:1}',
      '.mtw-rd__panel{position:absolute;top:0;right:0;bottom:0;width:min(460px,100%);background:#fff;' +
        'box-shadow:-12px 0 40px rgba(15,23,42,.2);display:flex;flex-direction:column;' +
        'transform:translateX(100%);transition:transform .3s cubic-bezier(.22,.8,.3,1)}',
      '.mtw-rd.is-open .mtw-rd__panel{transform:none}',

      /* header + search */
      '.mtw-rd__top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;' +
        'padding:20px 20px 0}',
      '.mtw-rd__heading{margin:0;font-size:20px;font-weight:800;letter-spacing:-.01em}',
      '.mtw-rd__close{flex:none;width:36px;height:36px;margin:-4px -6px 0 0;border:0;border-radius:50%;' +
        'background:transparent;color:#5b6678;cursor:pointer;display:flex;align-items:center;justify-content:center}',
      '.mtw-rd__close:hover{background:#f0f3f8;color:#1b2433}',
      '.mtw-rd__close:focus-visible,.mtw-rd__input:focus-visible,.mtw-rd__go:focus-visible,' +
        '.mtw-rd__cta:focus-visible,.mtw-rd__retry:focus-visible{outline:2px solid ' + cfg.accent + ';outline-offset:2px}',
      '.mtw-rd__close svg{width:20px;height:20px}',
      '.mtw-rd__search{display:flex;gap:8px;padding:16px 20px 0}',
      '.mtw-rd__input{flex:1;min-width:0;height:46px;padding:0 14px;border:1px solid #d5dbe5;border-radius:12px;' +
        'background:#fff;color:#1b2433;font:inherit;font-size:16px;font-weight:600;text-transform:uppercase;' +
        'letter-spacing:.04em}',
      '.mtw-rd__input::placeholder{color:#8a94a6;font-weight:500;text-transform:none;letter-spacing:0}',
      '.mtw-rd__go{flex:none;height:46px;padding:0 18px;border:0;border-radius:12px;background:#1b2433;' +
        'color:#fff;font:inherit;font-weight:700;cursor:pointer}',
      '.mtw-rd__go:hover{background:#2a3548}',
      '.mtw-rd__go[disabled]{opacity:.6;cursor:default}',

      /* body */
      '.mtw-rd__body{flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch}',
      '.mtw-rd__msg{margin:0;padding:14px 16px;border-radius:12px;background:#f6f8fb;color:#5b6678;font-weight:500}',
      '.mtw-rd__msg--error{background:#fdf0f0;color:#9b1c1c}',
      '.mtw-rd__retry{margin-top:10px;display:block;border:0;background:none;padding:0;color:inherit;' +
        'font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}',
      '.mtw-rd__spin{display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:-2px;' +
        'border:2px solid #cfd6e2;border-top-color:#1b2433;border-radius:50%;animation:mtw-rd-spin .7s linear infinite}',
      '@keyframes mtw-rd-spin{to{transform:rotate(360deg)}}',

      /* result */
      '.mtw-rd__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.mtw-rd__eyebrow{margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5b6678}',
      '.mtw-rd__title{margin:0;font-size:24px;font-weight:800;letter-spacing:-.01em;overflow-wrap:anywhere}',
      '.mtw-rd__chip{flex:none;padding:3px 8px;border-radius:6px;background:#e3e9f2;color:#3b4658;' +
        "font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:500}",
      '.mtw-rd__art{margin-top:16px;border-radius:14px;background:#f0f3f8;border:1px solid #e1e6ee;' +
        'aspect-ratio:3/1;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.mtw-rd__art img{display:block;width:100%;height:100%;object-fit:contain}',
      '.mtw-rd__art.is-loading{background:linear-gradient(100deg,#f0f3f8 30%,#e6ebf3 50%,#f0f3f8 70%);' +
        'background-size:200% 100%;animation:mtw-rd-shimmer 1.2s linear infinite}',
      '@keyframes mtw-rd-shimmer{to{background-position:-200% 0}}',
      '.mtw-rd__info{margin-top:16px;padding:12px;border-radius:14px;background:#f6f8fb;border:1px solid #e1e6ee}',
      '.mtw-rd__info-title{margin:2px 4px 10px;font-size:11px;font-weight:800;letter-spacing:.1em;' +
        'text-transform:uppercase;color:#5b6678}',
      '.mtw-rd__facts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0}',
      '.mtw-rd__fact{margin:0;padding:12px;border-radius:10px;background:#fff;min-width:0}',
      '.mtw-rd__fact dt{margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:.08em;' +
        'text-transform:uppercase;color:#5b6678}',
      '.mtw-rd__fact dd{margin:0;font-size:15px;font-weight:700;overflow-wrap:anywhere}',

      /* footer */
      '.mtw-rd__foot{flex:none;padding:14px 20px calc(14px + env(safe-area-inset-bottom,0px));' +
        'border-top:1px solid #e1e6ee;background:#fff}',
      '.mtw-rd__note{margin:0 0 10px;font-size:13px;color:#5b6678;font-weight:500}',
      '.mtw-rd__cta{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:50px;' +
        'border-radius:12px;background:' + cfg.accent + ';color:#fff;font:inherit;font-size:16px;font-weight:800;' +
        'text-decoration:none;cursor:pointer}',
      '.mtw-rd__cta:hover{filter:brightness(.92);color:#fff}',
      '.mtw-rd__cta svg{width:18px;height:18px}',

      '@media (prefers-reduced-motion:reduce){.mtw-rd,.mtw-rd__scrim,.mtw-rd__panel,.mtw-rd-fab{transition:none!important}' +
        '.mtw-rd__art.is-loading,.mtw-rd__spin{animation:none!important}}'
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'mtw-rd-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* --- ui ---------------------------------------------------------------- */

  var ICON_TRUCK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>' +
    '<path d="M15 18H9"/>' +
    '<path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>' +
    '<circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';

  var ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var ICON_ARROW =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  var ui = null;            // built on first use
  var isOpen = false;
  var lastFocus = null;
  var prevOverflow = '';
  var prevPadding = '';
  var searchToken = 0;

  function build() {
    if (ui) return ui;
    injectStyles();
    loadFonts();

    var root = el('div', 'mtw-rd');
    root.setAttribute('data-mtw-rd', '');

    var scrim = el('div', 'mtw-rd__scrim');
    scrim.addEventListener('click', close);
    root.appendChild(scrim);

    var panel = el('aside', 'mtw-rd__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'mtw-rd-heading');

    var top = el('div', 'mtw-rd__top');
    var heading = el('h2', 'mtw-rd__heading', cfg.title);
    heading.id = 'mtw-rd-heading';
    top.appendChild(heading);
    var closeBtn = el('button', 'mtw-rd__close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener('click', close);
    top.appendChild(closeBtn);
    panel.appendChild(top);

    var form = el('form', 'mtw-rd__search');
    form.setAttribute('role', 'search');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'mtw-rd__input';
    input.placeholder = 'Registration, e.g. B736U';
    input.setAttribute('aria-label', 'Registration number');
    input.autocomplete = 'off';
    input.autocapitalize = 'characters';
    input.spellcheck = false;
    input.maxLength = 30;
    var go = el('button', 'mtw-rd__go', 'Search');
    go.type = 'submit';
    form.appendChild(input);
    form.appendChild(go);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      search(input.value);
    });
    panel.appendChild(form);

    var body = el('div', 'mtw-rd__body');
    body.setAttribute('aria-live', 'polite');
    panel.appendChild(body);

    var foot = el('div', 'mtw-rd__foot');
    foot.hidden = true;
    var note = el('p', 'mtw-rd__note');
    var cta = el('a', 'mtw-rd__cta');
    foot.appendChild(note);
    foot.appendChild(cta);
    panel.appendChild(foot);

    root.appendChild(panel);

    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;

      var nodes = [].slice.call(panel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled])'))
        .filter(function (n) { return n.offsetParent !== null; });
      if (!nodes.length) return;

      var firstEl = nodes[0], lastEl = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    });

    document.body.appendChild(root);

    ui = { root: root, input: input, go: go, body: body, foot: foot, note: note, cta: cta };
    message('', cfg.intro);
    return ui;
  }

  function message(kind, text, retry) {
    var b = clear(ui.body);
    ui.foot.hidden = true;
    var m = el('p', 'mtw-rd__msg' + (kind === 'error' ? ' mtw-rd__msg--error' : ''));
    if (kind === 'loading') {
      m.appendChild(el('span', 'mtw-rd__spin'));
      m.appendChild(document.createTextNode(text));
    } else {
      m.textContent = text;
    }
    if (retry) {
      var r = el('button', 'mtw-rd__retry', 'Try again');
      r.type = 'button';
      r.addEventListener('click', retry);
      m.appendChild(r);
    }
    b.appendChild(m);
  }

  function partsUrl(rego) {
    var base = String(cfg.regoPageUrl || '/');
    var hash = '';
    var h = base.indexOf('#');
    if (h > -1) { hash = base.slice(h); base = base.slice(0, h); }
    return base + (base.indexOf('?') > -1 ? '&' : '?') + 'rego=' + encodeURIComponent(rego) + hash;
  }

  function renderResult(rec) {
    var b = clear(ui.body);

    var head = el('div', 'mtw-rd__head');
    var titles = el('div');
    titles.appendChild(el('p', 'mtw-rd__eyebrow', 'Trailer'));
    titles.appendChild(el('h3', 'mtw-rd__title', rec.model || rec.type || 'Trailer'));
    head.appendChild(titles);
    head.appendChild(el('span', 'mtw-rd__chip', '[' + rec.rego + ']'));
    b.appendChild(head);

    /* Drawing. The box is held open with a shimmer while it loads, and removed
       entirely if the type has no artwork or every host fails, so the page
       never shows an empty grey rectangle. */
    var slug = drawingSlug(rec.type, trailerMap);
    if (slug) {
      var art = el('div', 'mtw-rd__art is-loading');
      var img = document.createElement('img');
      img.alt = (rec.type || 'Trailer') + ' side view';
      img.decoding = 'async';
      art.appendChild(img);
      b.appendChild(art);

      loadDrawing(slug).then(function (url) {
        img.src = url;
        art.classList.remove('is-loading');
      }, function () {
        warn('drawing failed on every host:', slug);
        if (art.parentNode) art.parentNode.removeChild(art);
      });
    }

    var info = el('div', 'mtw-rd__info');
    info.appendChild(el('p', 'mtw-rd__info-title', 'Trailer information'));
    var dl = el('dl', 'mtw-rd__facts');
    var shown = 0;
    cfg.factFields.forEach(function (f) {
      var v = rec.specs[f.key];
      if (!v) return;
      var box = el('div', 'mtw-rd__fact');
      box.appendChild(el('dt', null, f.label));
      box.appendChild(el('dd', null, display(v)));
      dl.appendChild(box);
      shown++;
    });
    if (shown) info.appendChild(dl);
    else info.appendChild(el('p', 'mtw-rd__msg', 'No summary recorded for this trailer.'));
    b.appendChild(info);

    /* Footer: the button that carries the rego to the full page. */
    ui.cta.href = partsUrl(rec.rego);
    clear(ui.cta);
    ui.cta.appendChild(document.createTextNode('View all parts'));
    var arrow = el('span');
    arrow.innerHTML = ICON_ARROW;
    ui.cta.appendChild(arrow.firstChild);

    ui.note.textContent = rec.codeCount
      ? rec.codeCount + (rec.codeCount === 1 ? ' part' : ' parts') + ' listed for this trailer'
      : 'No parts list for this trailer yet \u2013 the full page has everything we hold on it.';
    ui.foot.hidden = false;

    b.scrollTop = 0;
  }

  function search(raw) {
    build();
    var token = ++searchToken;

    if (regoKey(raw).length < 2) {
      message('', 'Enter your registration number.');
      return;
    }

    ui.go.disabled = true;
    message('loading', 'Looking up your trailer\u2026');

    ensureData().then(function (index) {
      /* trailers.json can have failed at load; one more try per search rather
         than going without drawings for the whole visit. */
      if (trailerMap) return index;
      return loadTrailerMap().then(function (m) { trailerMap = m; return index; }, function () { return index; });
    }).then(function (index) {
      if (token !== searchToken) return;
      ui.go.disabled = false;

      var found = find(raw, index);
      if (found.rec) { renderResult(found.rec); return; }

      if (found.ambiguous) {
        message('', 'That matches more than one trailer \u2013 please enter the full registration.');
      } else {
        message('', "We don't have a record of that registration. Check the number and try again.");
      }
    }).catch(function (e) {
      if (token !== searchToken) return;
      ui.go.disabled = false;
      warn('lookup failed:', e && e.message);
      message('error', "We couldn't load the trailer database.", function () { search(raw); });
    });
  }

  /* --- open / close ------------------------------------------------------ */

  function open() {
    build();
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement;

    var sb = window.innerWidth - document.documentElement.clientWidth;
    prevOverflow = document.body.style.overflow;
    prevPadding = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (sb > 0) document.body.style.paddingRight = sb + 'px';

    ui.root.classList.add('is-open');
    if (fab) fab.setAttribute('aria-expanded', 'true');

    /* Start the download now so it is usually done by the time they search. */
    ensureData().catch(function () { /* surfaced when they actually search */ });

    setTimeout(function () {
      try { ui.input.focus({ preventScroll: true }); } catch (e) { ui.input.focus(); }
    }, 60);
  }

  function close() {
    if (!isOpen || !ui) return;
    isOpen = false;
    ui.root.classList.remove('is-open');
    document.body.style.overflow = prevOverflow;
    document.body.style.paddingRight = prevPadding;
    if (fab) fab.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  /* --- boot -------------------------------------------------------------- */

  var fab = null;

  function warm() {
    ensureData().catch(function () { /* a real search reports it */ });
  }

  function makeButton(cls) {
    var b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', cfg.label);
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.title = cfg.label;
    b.innerHTML = ICON_TRUCK;
    if (cls === 'mtw-rd-nav' && cfg.navLabel) b.appendChild(el('span', null, cfg.navLabel));
    b.addEventListener('click', open);
    /* Hovering or touching the icon is a strong hint they are about to
       search, so the CSV can start downloading before they click. */
    b.addEventListener('pointerenter', warm);
    b.addEventListener('touchstart', warm, { passive: true });
    return b;
  }

  function placeFloating() {
    injectStyles();
    fab = makeButton('mtw-rd-fab');
    document.body.appendChild(fab);
  }

  /* Looks for the nav for ~5s, because themes often render menus after
     DOMContentLoaded. Falls back to the floating icon rather than leaving the
     feature invisible. */
  function placeInNav(triesLeft) {
    var host = null;
    try { host = document.querySelector(cfg.navTarget); } catch (e) {
      warn('navTarget is not a valid selector:', cfg.navTarget);
    }

    if (host) {
      injectStyles();
      fab = makeButton('mtw-rd-nav');
      var node = fab;
      if (/^(UL|OL)$/.test(host.tagName)) {
        node = el('li', 'mtw-rd-nav-li');
        node.appendChild(fab);
      }
      if (cfg.navPosition === 'prepend') host.insertBefore(node, host.firstChild);
      else host.appendChild(node);
      return;
    }

    if (triesLeft > 0 && cfg.navTarget) {
      setTimeout(function () { placeInNav(triesLeft - 1); }, 250);
      return;
    }

    warn('nav target "' + cfg.navTarget + '" not found; using the floating icon instead');
    placeFloating();
  }

  function start() {
    if (cfg.navTarget) placeInNav(20);
    else if (cfg.floatingButton) placeFloating();

    /* Any element can open it. Delegated, so triggers added later still work. */
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('[data-mtw-rego-open]');
      if (!t) return;
      e.preventDefault();
      open();
    });

    /* Small public API, attached to the config object the page already owns. */
    userCfg.open = open;
    userCfg.close = close;
    userCfg.search = function (rego) {
      open();
      build().input.value = String(rego || '');
      search(rego);
    };
    window.MTWRegoDrawer = userCfg;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else start();
})();
