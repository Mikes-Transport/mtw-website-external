/* ------------------------------------------------------------------------
   Model lookup

   Rego search, clickable trailer diagram, full build sheet, and parts list.

   Loaded the same way as the other external scripts on this site:

     <div id="mtw-model-lookup"></div>
     <script src="https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/model-lookup.js"></script>

   ONE CSV HOLDS EVERYTHING
   ------------------------
   rego_search.csv is fetched whole and parsed in the browser. It is 3,426 rows
   x 333 columns and arrives at 258 KB gzipped, so it is cached in
   localStorage after the first load and never re-fetched.

   Two things come out of it, and they are deliberately kept apart:

     parts     CODE1..CODE250 for the searched row -> the parts cards.
               This is the ONLY source of product information. Nothing in the
               spec columns is ever treated as a part number.

     build     the trailer_type / year / axle / hub / bearing / seal ... columns
               -> the build sheet and the per-component info panel.

   A hotspot on the diagram shows the build-sheet fields for that component.
   It never invents a product, because only CODE1..CODE250 is trusted for that.

   Rows with no codes are still searchable - the build sheet is real data for
   them - but the parts area says plainly that there is no parts list yet
   rather than showing an empty grid.

   THREE THINGS IN THE CSV THAT ARE EASY TO GET WRONG
   ---------------------------------------------------
   Duplicate column names. The header contains CODE100 twice, CODE250 three
   times, and CODE244..CODE249 twice. Looking a column up by name therefore
   breaks, so CODE columns are grouped by their number and every matching
   position is read, first non-empty wins. CODE100 is the one that matters -
   its data sits in the first of the two.

   Messy registrations. Some rows hold "31DJA  ( New 55BQZ)", "22HMZ -'5108G",
   "Model MTE3-24KL" or a lowercase rego. regoCandidates() pulls every
   plausible rego out of a cell so "31DJA  ( New 55BQZ)" is still findable by
   both 31DJA and 55BQZ.

   Empty code cells. Blank, and the occasional description sitting in a CODE
   column. Both are skipped. Anything left that resolves to no product is
   listed under the parts grid, never dropped silently.

   CART
   ----
     {cartOrigin}/cart/add?quantity[{productId}]={qty}

   Issued as a top-level navigation - a small offscreen popup that closes
   itself, falling back to the same tab when blocked - not as a fetch(). The
   cart is session-scoped by an HttpOnly cookie on domain=www.mtw.co.nz with
   no SameSite attribute, which browsers treat as Lax. Lax withholds that
   cookie from fetch(), from cross-site POSTs and from iframes, but still
   sends it on a top-level navigation. There is no CORS header on the shop, so
   fetch() is out regardless. Verified in a browser; see cart-check.html.

   Out-of-stock and low-stock items are both refused by the cart with no
   message, so they are not sent.

   PRICES
   ------
   Price is the ex-GST selling price from the product page; rrp is the struck
   through RRP and is null unless the item is discounted. Prices render live
   from MYOB Exo per request (product pages send cache-control: no-store), so
   products.json is a snapshot and is not what a trade account is charged. The
   widget labels what it shows and leaves the real figure to the cart.
   ------------------------------------------------------------------------ */

(function mtwModelLookup() {
  'use strict';

  /* --- config ----------------------------------------------------------- */

  var DEFAULTS = {
    mount: '#mtw-model-lookup',

    css: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/model-lookup.css',

    /* --- where the CSV comes from ----------------------------------------

       'firebase' - read a Firestore document, take the CSV link out of it, and
       fetch that. The document holds only a URL, so the file itself can move
       without touching this code and only the document has to be edited.

       'url' - fetch csvUrl directly. Kept as a fallback: if the Firestore read
       fails for any reason the widget should still find trailers rather than
       show an error, and the committed CSV is always there.

       The Firestore read tries two routes, in order:

       1. window.db, if the page has initialised the SDK.
       2. Firestore's REST API directly. No SDK and no page setup, so the
          widget still works on a page that does not initialise Firebase.

       Neither route needs an API key, as long as the Firestore security rules
       allow public reads on that one document. Verified against
       projects/mtw-lookup: csv-data/chassis_master_mte_export returns 200 with
       the link, unauthenticated. If the rules ever change to require auth the
       read fails and the widget falls back to csvUrl. */
    csvSource: 'firebase',

    firebase: {
      project: 'mtw-lookup',
      collection: 'csv-data',
      document: 'chassis_master_mte_export',
      field: 'link',
      api: 'https://firestore.googleapis.com/v1/projects',
      /* Loaded on demand, and only if window.db is there to use it. Must match
         the version the page initialised the SDK with - a second copy would be
         a separate module instance with its own app registry, and doc() from
         one would not recognise a db from the other. ES modules are cached by
         URL, so importing the same version the page used returns the same
         instance. */
      module: 'https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js',
      /* The page's Firebase bootstrap is a module script, so it finishes
         asynchronously. window.db may not exist yet when this widget boots, so
         give it a moment before deciding it is never going to arrive. */
      waitMs: 3000
    },

    /* PapaParse reads the CSV. It is the more careful parser of the two and
       this file has quoted fields containing commas throughout, but the
       built-in parser stays as a fallback so a blocked CDN cannot take the
       widget down with it. If the page already loaded PapaParse, this is a
       no-op. */
    papaUrl: 'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',

    /* Used when csvSource is 'url', and as the fallback if Firestore fails. */
    csvUrl: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/data/rego_search.csv',

    shopOrigin: 'https://www.mtw.co.nz',

    /* The shop's header cart, refreshed after every add so it stops showing a
       stale count. cartParts are the nodes inside it that hold the count and
       the total - those are what get swapped for the server's versions. */
    /* Retries when a drawing fails to load. raw.githack is a third-party service in
       front of GitHub and it drops connections intermittently - reported as
       ERR_CONNECTION_RESET against raw.githubusercontent.com, which is where it
       redirects to. One retry turns a permanently blank panel into a slightly
       slower load. */
    drawingRetries: 2,

    cartSelector: '.cart-outer',
    cartParts: ['.items', '.total'],

    /* Trailer drawings. trailers.json maps the CSV's trailer_type strings onto
       the PNGs and holds the hotspot coordinates; imgBase points at the PNGs
       themselves. Set imgBase to '' to serve them from the widget's own
       directory. */
    trailerMapUrl: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/img/trailers.json',
    imgBase: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/img/',

    /* Clickable component dots on the drawing, and the card that opens over it.
       Off for now. The points in img/trailers.json are geometric estimates
       rather than measured geometry - they assume axles sit at the rear right,
       which is true of a semi transporter and not of a tipper with no
       gooseneck - and a dot pointing at empty space is worse than no dot. The
       code and the data are all still here; turning this on needs the points
       corrected in trailers.json first. */
    hotspots: false,

    /* Look each stock code up through the shop's own search as the visitor
       needs it, rather than shipping a prebuilt index.

       This works because the widget runs ON the shop: same origin, so
       fetch() to /search needs no CORS, and the CSRF token is already in the
       page. It also means nothing is fetched for codes nobody searches, which
       is the whole reason an earlier sitemap-crawl approach got the origin
       rate-limited into a 403.

       Set to null to use a prebuilt index instead (see lookupIndexUrl). */
    lookupOnDemand: true,

    /* Fallback for when the widget is hosted somewhere other than the shop,
       where the same-origin search will not be available. */
    lookupIndexUrl: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/data/products.json',

    /* Resolved products are cached in localStorage per code, so a second
       visitor on the same trailer pays nothing. */
    /* How many stock codes go out in one search request. The endpoint matches
       every term in the query, so this is a straight request-count divisor.
       20 keeps a 165-code trailer at nine requests. */
    lookupBatch: 20,

    lookupCacheDays: 7,

    /* Columns. regoField is the one the customer types into. */
    columns: { rego: 'registration' },

    /* CODE1..CODE250 */
    codePattern: /^CODE(\d+)$/i,

    /* Words removed from what the visitor sees, and only that - the CSV is never
       rewritten. These are supplier or brand names that appear inside free-text
       spec fields ("050342 ALION 17.5\" AXLE 71\" TRACK"), which are data the
       customer needs, so the word goes and the rest of the value stays.

       This is display only. Anything read back from the CSV is untouched, and
       the codes that drive the parts list are never passed through it. */
    redactWords: ['Alion'],

    cacheHours: 12,

    /* 'blank' keeps cards clickable with a same-tab link, which preserves the
       selection on the way back. 'new' is a plain target="_blank". */
    cardTarget: 'blank',

    /* The four specs shown as cards above the build sheet. Short labels from
       the CSV columns they read. Order is the display order. */
    factFields: [
      { label: 'Axles', key: 'axle' },
      { label: 'Suspension', key: 'suspension_type_and_component_part_no' },
      { label: 'Brakes', key: 'brake_valves_type' },
      { label: 'GVM', key: 'gvw_atm' },
      { label: 'Tare', key: 'tare' },
      { label: 'Coupling', key: 'king_pin_type_and_serial_no' },
      { label: 'Tyres', key: 'tyre_type_and_size' },
      { label: 'Built for', key: 'built_for' }
    ],

    /* Build-sheet fields, in display order. Two source column names repeat in
       this list (rear_brake_booster..., s_cam_bush_kit appears twice) and are
       de-duplicated on the column key, keeping the first label. */
    specFields: [
      ['Trailer Type', 'trailer_type'],
      ['Year', 'year'],
      ['Built For', 'built_for'],
      ['Model No', 'model_no'],
      ['Chassis Number', 'chassis_number'],
      ['WIP', 'wip'],
      ['MTM GCM', 'mtm_gcm'],
      ['GVW ATM', 'gvw_atm'],
      ['Tare', 'tare'],
      ['Brake Valves Type', 'brake_valves_type'],
      ['Suspension Type', 'suspension_type_and_component_part_no'],
      ['Axle', 'axle'],
      ['Rear Suspension', 'rare_suspension'],
      ['Rear Axle', 'rare_axle'],
      ['Hub', 'hub'],
      ['Bearing Inner', 'bearing_inner'],
      ['Bearing Outer', 'bearing_outer'],
      ['Seal', 'seal'],
      ['Drum', 'drum'],
      ['Shoe Kit', 'shoe_kit'],
      ['Brake Size', 'brake_size'],
      ['Brake Lining', 'brake_linning'],
      ['Brake Shoe Type', 'brake_shoe_type'],
      ['S-Cam Bush Kit', 's_cam_bush_kit'],
      ['S-Cam Size & Part No', 's_cam_size_and_part_no'],
      ['Slack Adjuster', 'slack_adjuster'],
      ['Rear Slack Adjuster', 'rear_slack_adjuster'],
      ['Brake Booster', 'brake_booster_type_and_size'],
      ['Rear Brake Booster', 'rear_brake_booster_type_and_size'],
      ['Tyre Type & Size', 'tyre_type_and_size'],
      ['Wheel Type & Size', 'wheel_type_and_size'],
      ['Landing Legs', 'landing_legs_type_and_component_part_no'],
      ['King Pin', 'king_pin_type_and_serial_no'],
      ['Unit', 'no'],
      ['Invoice No.', 'invoice_no'],
      ['Last Known Owner', 'last_known_owner'],
      ['Target Hours', 'target_hours'],
      ['Actual Hours', 'actual_hours'],
      ['Start Date', 'start_date'],
      ['Finished Date', 'finished_date'],
      ['Date Shipped', 'date_shipped'],
      ['Shipping Info', 'shipping_info'],
      ['Rear Axle S-Cam Bush Kit', 'rear_axle_s_cam_bush_kit'],
      ['Rear Axle S-Cam Size', 'rear_axle_s_cam_size_part_no'],
      ['Rub Plate', 'rubplate_type_and_component_no'],
      ['Rub Plate Serial No.', 'rubplate_serial_no'],
      ['Tow Eye', 'tow_eye_type_and_component_no'],
      ['Drawbar', 'draw_bar_type_and_component_no'],
      ['Air Tank Size & Type', 'air_tanks_size_and_type_and_part_no'],
      ['Hoist', 'hoist_type_and_part_no'],
      ['Suspension Cylinders', 'suspension_cylinders_component_no'],
      ['Ballrace', 'ballrace_type_and_part_no'],
      ['5th Wheel', 'fith_wheel_type_and_part_no'],
      ['Ramp Size', 'ramps_size_and_component_no'],
      ['Ramp Cylinder', 'ramps_cylinders'],
      ['Widening Box', 'widening_box_component_no'],
      ['Widening Box Cylinder', 'widening_box_cylinder'],
      ['Widening Wing', 'widening_wings_component_no'],
      ['Widening Wing Cylinder', 'widening_wings_cylinder'],
      ['Gooseneck', 'gooseneck_component_no'],
      ['Gooseneck Cylinder', 'gooseneck_cylinder'],
      ['Powerpack', 'powerpack'],
      ['Suspension Serial No.', 'suspension_serial_no'],
      ['Widening Box Serial No.', 'widening_box_serial_no'],
      ['Additional Comments', 'add_comments'],
      ['Gooseneck Serial No.', 'gooseneck_serial_no'],
      ['Drawbar Bushes', 'draw_bar_bushes'],
      ['Wing Serial No.', 'wing_serial_no'],
      ['Big Tube Wing Type', 'bigtube_type_wing']
    ]
  };

  var cfg = merge(DEFAULTS, (window.MTWModelLookup || {}));

  var MARK = 'data-mtw-ml';
  var state = null;

  /* --- helpers ---------------------------------------------------------- */

  function merge(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (over) {
      for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
      if (over.columns) out.columns = merge(base.columns, over.columns);
      if (over.specFields) out.specFields = over.specFields;
    }
    return out;
  }

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
      console.warn.apply(console, ['[model-lookup]'].concat([].slice.call(arguments)));
    }
  }

  /* Normalise a rego for comparison: uppercase, alphanumerics only. */
  function regoKey(v) {
    return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function loadCss() {
    if (!cfg.css) return;
    if (document.querySelector('link[data-mtw-ml-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cfg.css;
    link.setAttribute('data-mtw-ml-css', '');
    document.head.appendChild(link);
  }

  /* --- csv -------------------------------------------------------------- */

  /* PapaParse, loaded on demand rather than shipped.

     It is only needed if the CSV is being read from Firestore, so there is no
     point paying for it on a page that never looks up a trailer. Injected as a
     plain script tag rather than bundled, because this file is loaded from a
     CDN and bundling would mean rebuilding it on every change. */
  var papaPromise = null;
  function loadPapa() {
    if (window.Papa && window.Papa.parse) return Promise.resolve(window.Papa);
    if (papaPromise) return papaPromise;

    papaPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = cfg.papaUrl;
      s.async = true;
      s.onload = function () {
        resolve(window.Papa || null);
      };
      /* Resolving with null rather than rejecting is deliberate. PapaParse is
         an improvement, not a requirement - the built-in parser below handles
         this file correctly, so a blocked CDN should degrade rather than fail. */
      s.onerror = function () {
        warn('PapaParse did not load, using the built-in CSV parser');
        resolve(null);
      };
      document.head.appendChild(s);
    });

    return papaPromise;
  }

  /* The page's Firebase bootstrap is a module script, so window.db appears some
     time after the widget starts. Polling for it rather than reading it once,
     because reading it once would mean falling back to the committed CSV on
     every page load and the Firestore link would never be used at all. */
  function waitForDb(ms) {
    return new Promise(function (resolve) {
      if (window.db) { resolve(window.db); return; }
      var waited = 0;
      var iv = setInterval(function () {
        waited += 100;
        if (window.db) { clearInterval(iv); resolve(window.db); return; }
        if (waited >= ms) { clearInterval(iv); resolve(null); }
      }, 100);
    });
  }

  /* Route 1: the SDK, against the page's own Firestore instance.

     The SDK enforces the same even-length document id rule the REST API does,
     so this fails fast and cleanly on a bad id rather than hanging. */
  function linkViaSdk() {
    var f = cfg.firebase;
    return waitForDb(f.waitMs).then(function (db) {
      if (!db) throw new Error('window.db never appeared');

      return import(f.module).then(function (m) {
        if (!m || !m.doc || !m.getDoc) throw new Error('Firestore module is missing doc/getDoc');
        return m.getDoc(m.doc(db, f.collection, f.document));
      }).then(function (snap) {
        if (!snap || !snap.exists || !snap.exists()) {
          throw new Error('no ' + f.collection + '/' + f.document);
        }
        var data = snap.data() || {};
        var link = data[f.field];
        if (!link) throw new Error('no "' + f.field + '" in that document');
        return String(link);
      });
    });
  }

  /* Route 2: Firestore's REST API. Needs no SDK and no page setup. */
  function linkViaRest() {
    var f = cfg.firebase;
    if (!f.project) return Promise.reject(new Error('firebase.project is not set'));

    var url = f.api + '/' + f.project + '/databases/(default)/documents/' +
              encodeURIComponent(f.collection) + '/' + encodeURIComponent(f.document);

    return getJson(url).then(function (doc) {
      var field = doc && doc.fields && doc.fields[f.field];
      var link = field && (field.stringValue != null ? field.stringValue : field.value);
      if (!link) throw new Error('no "' + f.field + '" in that document');
      return String(link);
    });
  }

  function firestoreCsvLink() {
    return linkViaSdk()
      .catch(function (e) { warn('Firestore SDK read failed:', e && e.message); return linkViaRest(); });
  }

  /* The text of the CSV, from wherever it turned out to live. */
  function loadCsvText() {
    if (cfg.csvSource !== 'firebase') return getText(cfg.csvUrl);

    /* Resolve the link, then FETCH it. The Firestore document holds a URL, not
       the data - returning the link from here and parsing that is the mistake
       that made PapaParse parse a URL as a one-column CSV and report zero
       rows. */
    return firestoreCsvLink()
      .then(function (link) { return getText(link); })
      .catch(function (e) {
        /* Falling back rather than showing an error. A committed copy exists at
           csvUrl, so the worst case is a slightly stale dataset, which is a much
           better outcome than "we can't find your trailer". */
        warn('could not load the CSV from Firestore (' + (e && e.message) + '), falling back to csvUrl');
        return getText(cfg.csvUrl);
      });
  }

  /* PapaParse when it is there, the built-in parser otherwise. Both return the
     same shape, so nothing downstream knows or cares which ran. */
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

  /* RFC4180-ish, and the fallback for when PapaParse is unavailable. Needed
     rather than split(',') because trailer_type and the
     spec columns hold quoted values containing commas, which would shift
     every column after them. */
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

  /* CODE columns grouped by number. Handles the duplicated headers: for a
     given number every position is read and the first non-empty value wins. */
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

  function codesForRow(row, byNumber) {
    var out = [];
    Object.keys(byNumber).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) {
      for (var i = 0; i < byNumber[n].length; i++) {
        var v = (row[byNumber[n][i]] || '').trim();
        if (v) { out.push(v); return; }
      }
    });
    return out;
  }

  /* Every plausible rego in a cell, most specific first.

     The file contains "31DJA  ( New 55BQZ)", "22HMZ -'5108G", "26JFY  1359H",
     "Model MTE3-24KL" and lowercase entries. All of those should be findable
     by the rego a customer would actually read off their plate. */
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

  /* --- shaping ---------------------------------------------------------- */

  /* One record per row, kept for every row that has a rego. Rows without
     codes stay in because their build sheet is still real information; the
     parts area reports the absence rather than the row vanishing. */
  function shape(parsed) {
    var byNumber = codeColumns(parsed.header);
    var regoCol = {};
    parsed.header.forEach(function (name, i) {
      if (regoCol[name] === undefined) regoCol[name] = i;
    });

    var fields = [];
    var seen = {};
    cfg.specFields.forEach(function (pair) {
      var key = pair[1];
      if (seen[key]) return;
      seen[key] = true;
      var i = regoCol[key];
      if (i !== undefined) fields.push({ label: pair[0], key: key, i: i });
    });

    var regoIndex = parsed.header.indexOf(cfg.columns.rego);
    var records = [];
    var index = {};

    parsed.rows.forEach(function (row) {
      var candidates = regoIndex === -1 ? [] : regoCandidates(row[regoIndex]);
      if (!candidates.length) return;

      var codes = codesForRow(row, byNumber);

      var specs = {};
      fields.forEach(function (f) {
        var v = (row[f.i] || '').trim();
        if (v) specs[f.key] = v;
      });

      var rec = {
        candidates: candidates,
        codes: codes,
        specs: specs,
        type: specs.trailer_type || '',
        year: specs.year || '',
        model: specs.model_no || '',
        builtFor: specs.built_for || '',
        chassis: specs.chassis_number || ''
      };

      records.push(rec);

      /* First match wins, except where a later row has parts and the earlier
         one does not - a rego listed twice with parts on only one of them
         should resolve to the useful row. */
      candidates.forEach(function (k) {
        var prev = index[k];
        if (!prev || (!prev.codes.length && codes.length)) index[k] = rec;
      });
    });

    return {
      index: index,
      fields: fields,
      totalRows: parsed.rows.length,
      withParts: records.filter(function (r) { return r.codes.length; }).length
    };
  }

  function shapeIndex(raw) {
    var list = raw && (raw.products || raw);
    var out = {};
    if (Array.isArray(list)) {
      list.forEach(function (p) { if (p && p.sku) out[String(p.sku)] = p; });
    } else if (list && typeof list === 'object') {
      for (var k in list) if (Object.prototype.hasOwnProperty.call(list, k)) {
        var p = list[k];
        if (p) out[k] = p.sku ? p : merge({ sku: k }, p);
      }
    }
    return out;
  }

  /* --- product lookup --------------------------------------------------- */

  var PRODUCT_CACHE = 'mtw-ml-products:';

  function cachedProducts() {
    try {
      var raw = window.localStorage.getItem(PRODUCT_CACHE);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveProducts(map) {
    try {
      window.localStorage.setItem(PRODUCT_CACHE, JSON.stringify(map));
    } catch (e) { /* a full quota just means no cache next time */ }
  }

  function cacheFresh(rec) {
    return rec && rec.foundAt &&
      (Date.now() - rec.foundAt < cfg.lookupCacheDays * 86400000);
  }

  /* The CSRF token is already in the host page's search form. Reading it from
     there is what makes this same-origin rather than a cross-site guess. */
  function csrfToken() {
    var input = document.querySelector('input[name="_csrf_token"]');
    return input ? input.value : '';
  }

  /* Stock codes -> products, via the shop's own search.

     A stock code is NOT a product id: /product/170255-x is a 404, the shop
     only accepts its internal id there. Search is the route that resolves it.

     Codes go out BATCHED, space separated. The search endpoint matches all the
     terms in one query rather than treating them as one string, so nine codes
     resolve in a single request. Measured on this origin: nine codes, one
     request, 645 ms - against 3.6 s for the same nine sent individually.

     Batching is also what makes it safe to stay wide. The server starts
     answering empty result pages under concurrency, and it gets worse the
     harder it is pushed: at width 4 nine codes resolved, at width 6 only two,
     at width 8 three, all with no error to detect. Fewer, larger requests sit
     well under any limit that would trip that.

     Only codes that were asked for are kept. A batched query also returns
     looser matches - asking for nine codes came back with a tenth nobody
     asked for - so the result set is filtered against the request rather than
     trusted. */
  function lookupCodes(codes) {
    var token = csrfToken();
    if (!token || !codes.length) return Promise.resolve({});

    var wanted = {};
    codes.forEach(function (c) { wanted[String(c).toUpperCase()] = true; });

    return fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: '_csrf_token=' + encodeURIComponent(token) +
            '&keywords=' + encodeURIComponent(codes.join(' '))
    }).then(function (r) {
      if (!r.ok) throw new Error('search HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var out = {};

      [].slice.call(doc.querySelectorAll('.model')).forEach(function (cell) {
        var sku = cell.textContent.trim();
        if (!wanted[String(sku).toUpperCase()]) return;
        /* Duplicated CODE cells mean the same code can come back twice. First
           row wins, which is the one the shop ranks highest. */
        if (out[sku]) return;

        var row = cell.parentNode;
        var p = rowFromSearchRow(row, sku);
        if (p) out[sku] = p;
      });

      return out;
    });
  }

  /* Each search result row carries everything a card needs - name, price, RRP,
     image and stock - so the product page is never fetched.

     The name lives in .name, NOT in the first product link: the row also
     carries a .photo link wrapping the image, which has no text at all.
     Reading the first link gave blank names and fell back to the stock code.
     Real row:

       <div class="details">
         <div class="photo"><a …><img alt="AL 30208 taper roller bearing"></a></div>
         <div class="name"><a …>AL 30208 taper roller bearing</a></div>
         <div class="model">100181</div>
         <div class="stock">In Stock</div>
         <div class="price">$27.90 <span class="suffix">Excl. GST</span></div>
       </div> */
  function rowFromSearchRow(row, sku) {
    var nameEl = row.querySelector('.name');
    var link = (nameEl && nameEl.querySelector('a[href*="/product/"]')) ||
               row.querySelector('a[href*="/product/"]');
    var href = link ? link.getAttribute('href') : null;
    var idMatch = href && href.match(/\/product\/(\d+)-/);
    if (!idMatch) return null;

    var img = row.querySelector('.photo img') || row.querySelector('img');

    return {
      id: parseInt(idMatch[1], 10),
      sku: String(sku),
      name: nameEl ? nameEl.textContent.trim() : (link ? link.textContent.trim() : null),
      image: img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null,
      price: moneyFrom(row.querySelector('.price')),
      /* Two selectors in one querySelector call would return whichever comes
         first in document order - the wrapper, not the value inside it. */
      rrp: moneyFrom(row.querySelector('.rrp .retail-value') || row.querySelector('.rrp')),
      url: href,
      stock: stockFromRow(row),
      foundAt: Date.now()
    };
  }

  function moneyFrom(node) {
    if (!node) return null;
    /* "$2,885.00 Excl. GST" -> 2885. Only the leading figure is wanted; the
       suffix carries no digits so a plain strip is safe here. */
    var m = node.textContent.replace(/[^0-9.,]/g, '');
    if (!m) return null;
    var n = parseFloat(m.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  /* Out of stock and low stock are both refused by the cart without a
     message, so they are kept apart. Read from .stock where possible, since
     the name column can contain the words "out of stock" by coincidence. */
  function stockFromRow(row) {
    var el = row.querySelector('.stock');
    var text = (el ? el.textContent : (row.textContent || '')).toLowerCase();
    if (/out of stock/.test(text)) return 'out';
    if (/low stock/.test(text)) return 'low';
    return 'in';
  }

  /* Resolve a trailer's codes.

     Codes are sent in batches of cfg.lookupBatch rather than one at a time.
     A trailer can carry 165 codes, which as individual searches is far past
     what the origin will answer - it starts replying with empty result pages
     and never says so. Nine codes in one request took 645 ms; the same nine
     individually took 3.6 s and needed a concurrency the shop tolerated no
     better than one-at-a-time.

     Cached codes go out through onEach before any request is made, so a warm
     visit paints without touching the network at all.

     Codes that come back missing are cached as missing. A code that resolves
     today should still resolve tomorrow, and re-asking for 30 dead codes on
     every visit is the difference between one request and five. */
  function resolveCodes(codes, onEach) {
    var cache = cachedProducts();
    var todo = [];

    codes.forEach(function (code) {
      var hit = cache[code];
      if (!cacheFresh(hit)) { todo.push(code); return; }
      if (hit.missing) return;
      if (onEach) onEach(hit);
    });

    if (!todo.length) return Promise.resolve();

    var size = Math.max(1, cfg.lookupBatch);
    var batches = [];
    for (var i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));

    return batches.reduce(function (chain, batch) {
      return chain.then(function () {
        return lookupCodes(batch).then(function (found) {
          batch.forEach(function (code) {
            var rec = found[code];
            if (rec) {
              cache[code] = rec;
              if (onEach) onEach(rec);
            } else {
              /* Not cached. A code that fails to resolve here may be a
                 throttled empty response rather than a real miss, and caching
                 that would hide the part forever. */
              warn('no product for code', code);
            }
          });
        }).catch(function (e) {
          /* Nothing in this batch is cached, so the next visit retries it. */
          warn('lookup failed for batch of', batch.length, 'starting', batch[0], e && e.message);
        });
      });
    }, Promise.resolve()).then(function () {
      saveProducts(cache);
    });
  }

  /* --- fetching --------------------------------------------------------- */

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
    } catch (e) { /* cache is an optimisation, never a requirement */ }
  }

  function getText(url) {
    var hit = cacheGet('mtw-ml:' + url);
    if (hit != null) return Promise.resolve(hit);
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
        return r.text();
      })
      .then(function (body) { cacheSet('mtw-ml:' + url, body); return body; });
  }

  function getJson(url) {
    var hit = cacheGet('mtw-ml:' + url);
    if (hit != null) { try { return Promise.resolve(JSON.parse(hit)); } catch (e) {} }
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
        return r.json();
      })
      .then(function (body) { cacheSet('mtw-ml:' + url, JSON.stringify(body)); return body; });
  }

  /* The design uses Manrope for UI and JetBrains Mono for stock codes. Neither
     is assumed to be on the host page, so both are pulled in. */
  function loadFonts() {
    if (document.querySelector('link[data-mtw-ml-fonts]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500&display=swap';
    link.setAttribute('data-mtw-ml-fonts', '');
    document.head.appendChild(link);
  }

  /* --- drawings ---------------------------------------------------------- */

  /* Hotspots. Each carries the build-sheet fields for that component. These
     are spec columns only - nothing here is ever treated as a part number,
     because CODE1..CODE250 is the sole source of product information. */
  var HOTSPOTS = [
    { id: 'body', label: 'Body & deck', keys: ['trailer_type', 'year', 'model_no', 'chassis_number', 'built_for', 'wip', 'add_comments'] },
    { id: 'kingpin', label: 'King pin & coupling', keys: ['king_pin_type_and_serial_no', 'ballrace_type_and_part_no', 'rubplate_type_and_component_no', 'rubplate_serial_no', 'fith_wheel_type_and_part_no', 'tow_eye_type_and_component_no', 'draw_bar_type_and_component_no', 'draw_bar_bushes'] },
    { id: 'front', label: 'Front & guards', keys: ['landing_legs_type_and_component_part_no', 'shipping_info'] },
    { id: 'mid', label: 'Equipment & tanks', keys: ['air_tanks_size_and_type_and_part_no', 'hoist_type_and_part_no', 'powerpack', 'ramps_size_and_component_no', 'ramps_cylinders'] },
    { id: 'widening', label: 'Widening & gooseneck', keys: ['widening_box_component_no', 'widening_box_cylinder', 'widening_wings_component_no', 'widening_wings_cylinder', 'widening_box_serial_no', 'gooseneck_component_no', 'gooseneck_cylinder', 'gooseneck_serial_no', 'wing_serial_no', 'bigtube_type_wing'] },
    { id: 'suspension', label: 'Suspension', keys: ['suspension_type_and_component_part_no', 'suspension_cylinders_component_no', 'suspension_serial_no', 'rare_suspension', 'rare_axle'] },
    { id: 'brakes', label: 'Brakes', keys: ['brake_valves_type', 'brake_size', 'brake_linning', 'brake_shoe_type', 'shoe_kit', 's_cam_bush_kit', 's_cam_size_and_part_no', 'rear_axle_s_cam_bush_kit', 'rear_axle_s_cam_size_part_no', 'slack_adjuster', 'rear_slack_adjuster', 'brake_booster_type_and_size', 'rear_brake_booster_type_and_size'] },
    { id: 'wheels', label: 'Axles & wheels', keys: ['axle', 'rare_axle', 'tyre_type_and_size', 'wheel_type_and_size', 'hub', 'bearing_inner', 'bearing_outer', 'seal', 'drum'] }
  ];

  /* Picks the drawing for a trailer type from img/trailers.json.
     Returns null when nothing matches, which is a normal case: three of the
     searchable types (two clip-ons and a 3FTLL) have no artwork, and the
     caller falls back to the build sheet on its own. */
  function drawingFor(type) {
    var map = state.trailers;
    if (!map || !map.match) return null;

    /* Compared the way the customer types it: letters and digits only, so
       "6A B-Train (3A Front Unit) - NZ" and "6A B-Train" both reach the same
       rule. */
    var n = String(type || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!n) return null;

    for (var i = 0; i < map.match.length; i++) {
      var rule = map.match[i];
      if (!rule.re) continue;
      var re;
      try { re = new RegExp(rule.re, 'i'); } catch (e) { continue; }
      if (!re.test(n)) continue;
      var img = map.images[rule.image];
      if (!img) { warn('matched rule points at a missing drawing:', rule.image); continue; }
      return { slug: rule.image, confidence: rule.confidence || 'exact', spec: img };
    }
    return null;
  }

  /* The drawing, with the hotspots drawn on top of it.

     The artwork stays a PNG and is placed inside the SVG with <image>, rather
     than being rebuilt as vector shapes. That keeps every existing behaviour -
     the dots, the active state, the leader tick, the floating card - working
     untouched, and the viewBox is the PNG's own 1800x600 so hotspot
     coordinates are straight from trailers.json with no scaling. */
  function buildSvg(rec) {
    var d = drawingFor(rec.type);
    var p = [];

    p.push('<svg class="mtw-ml__svg" viewBox="0 0 1800 600" role="img" aria-label="' +
      (rec.type || 'Trailer') + ' side view">');

    if (d) {
      p.push('<image class="mtw-ml__drawing" x="0" y="0" width="1800" height="600"' +
        ' preserveAspectRatio="xMidYMid meet"' +
        ' href="' + cfg.imgBase + d.slug + '.png"/>');
    }

    /* Dots are skipped when there is no drawing to point at, and entirely while
       cfg.hotspots is off. A dot floating on empty canvas reads as a mistake. */
    p.push(d && cfg.hotspots ? HOTSPOTS.map(function (h) {
      return hotspot(h, d.spec);
    }).join('') : '');

    /* Short tick from the active dot down toward the card. Redrawn on every
       click rather than shipped empty, so there is nothing to show before a
       component is chosen. */
    p.push('<path class="mtw-ml__leader" id="mtw-ml-leader" d=""/>');

    p.push('</svg>');
    return p.join('');
  }

  /* Watches the drawing for a dropped connection and retries it.

     The <image> is left in the SVG rather than preloaded with new Image(),
     because the SVG is built as a string and innerHTML cannot carry a
     listener. SVGImageElement does fire `error` on a failed load, so it is
     attached afterwards, by which point the element exists.

     Retrying just rewrites href with a cache-buster - the failure was a reset
     mid-transfer, so the request has to actually be made again rather than
     served from whatever the browser decided to cache about the failure. */
  function watchDrawing(art) {
    var tries = 0;
    art.addEventListener('error', function () {
      if (tries++ >= cfg.drawingRetries) {
        art.classList.add('is-missing');
        warn('drawing failed to load after', tries, 'attempts');
        return;
      }
      var href = art.getAttribute('href') || '';
      art.setAttribute('href', href + (href.indexOf('?') > -1 ? '&' : '?') + 'r=' + Date.now());
    });
  }

  /* Where each dot sits comes from trailers.json, measured against that
     drawing's own bounding box - the drawings are not drawn to a common frame,
     so fixed canvas coordinates would miss on most of them. */
  function hotspot(h, spec) {
    var spots = spec.hotspots || [];
    var s = spots.filter(function (v) { return v.id === h.id; })[0];
    if (!s) return '';

    var present = hasAny(rec2specsCache, h.keys);

    /* Dots are sized in canvas units and the viewBox scales, so a radius is
       chosen to land near 9px on screen at the usual column width. */
    var r = 26;
    return '<g class="mtw-ml__hot-group' + (present ? ' is-recorded' : ' is-empty') + '"' +
      ' data-mtw-ml-group="' + h.id + '"' +
      ' data-anchor-x="' + s.x + '" data-anchor-y="' + (s.y + r + 6) + '">' +
      '<circle class="mtw-ml__hot" cx="' + s.x + '" cy="' + s.y + '" r="' + r +
      '" data-mtw-ml-hot="' + h.id + '"/>' +
      '</g>';
  }

  /* Set by the caller before buildSvg runs, so hotspot() can tell whether a
     component has any data on this trailer. */
  var rec2specsCache = null;

  function hasAny(specs, keys) {
    if (!specs) return true;
    for (var i = 0; i < keys.length; i++) if (specs[keys[i]]) return true;
    return false;
  }

  /* --- money ------------------------------------------------------------ */

  function money(n) {
    if (n == null || isNaN(n)) return '';
    return '$' + Number(n).toLocaleString('en-NZ', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function canAdd(p) {
    return p.stock !== 'out' && p.stock !== 'low';
  }

  /* --- url state -------------------------------------------------------- */

  /* The rego and the quantities live in the query string, so a card link out
     and back returns to the same selection, and so does a new tab. */
  function readUrl() {
    var out = { rego: '', qty: {} };
    try {
      var qs = window.location.search || '';
      var m;
      if ((m = qs.match(/[?&]rego=([^&]*)/))) out.rego = regoKey(decodeURIComponent(m[1]));
      if ((m = qs.match(/[?&]q=([^&]*)/))) {
        decodeURIComponent(m[1]).split(',').forEach(function (pair) {
          var kv = pair.split(':');
          if (kv.length === 2) {
            var n = parseInt(kv[1], 10);
            if (n > 0) out.qty[kv[0]] = n;
          }
        });
      }
    } catch (e) {}
    return out;
  }

  function writeUrl(rego, qty) {
    try {
      var params = [];
      if (rego) params.push('rego=' + encodeURIComponent(rego));
      var pairs = [];
      for (var k in qty) if (Object.prototype.hasOwnProperty.call(qty, k) && qty[k] > 0) {
        pairs.push(k + ':' + qty[k]);
      }
      if (pairs.length) params.push('q=' + encodeURIComponent(pairs.join(',')));
      var qs = params.length ? '?' + params.join('&') : '';
      window.history.replaceState(null, '', window.location.pathname + qs);
    } catch (e) { /* history may be blocked; selection still works in-page */ }
  }

  /* --- cart ------------------------------------------------------------- */

  /* Adds in the background. The widget runs on the shop's own origin, so
     /cart/add is a same-origin request and the session cookie rides along -
     no popup, no navigation, and the page stays exactly where it was.

     This is the reason the popup machinery is gone. It existed because the
     cart cookie is HttpOnly with no SameSite attribute, which browsers treat
     as Lax, and Lax withholds the cookie from cross-origin requests. Same
     origin sidesteps that entirely. Verified: POST /cart/add from this page
     returns 200 with the item added and the tab never moves. */
  function addToCart(lines) {
    if (!lines.length) return Promise.resolve(false);

    var qs = lines.map(function (l) {
      return 'quantity%5B' + encodeURIComponent(l.product.id) + '%5D=' + encodeURIComponent(l.qty);
    }).join('&');

    return fetch('/cart/add?' + qs, {
      credentials: 'same-origin'
    }).then(function (r) {
      if (!r.ok) throw new Error('cart HTTP ' + r.status);
      /* The response is the cart page itself - the add redirects to /cart -
         so it already carries an up-to-date header cart. Handing it back costs
         nothing extra. */
      return r.text().then(function (html) {
        syncHeaderCart(html);
        return true;
      });
    });
  }

  /* Refresh the shop's header cart after an add.

     Without this the header is stale the moment the widget stops navigating:
     it still shows whatever was there at page load, so adding from the lookup
     appears to do nothing until you reload.

     The server's own markup is the source of truth. The count, the total, the
     Excl. GST suffix and the is-filled / is-empty class are all computed by
     the shop, and rebuilding them here would mean reimplementing its rounding
     and its empty state - the two things most likely to drift out of step.
     So the block is lifted out of the response and swapped in.

     Only the two inner nodes are replaced, not the whole .cart-outer. The
     outer element belongs to the host theme and may be the thing its own
     script holds a reference to; replacing it could break the page's cart
     behaviour. */
  function syncHeaderCart(html) {
    var live = document.querySelector(cfg.cartSelector);
    if (!live) return;

    var fresh;
    try {
      fresh = new DOMParser().parseFromString(html, 'text/html')
        .querySelector(cfg.cartSelector);
    } catch (e) { return; }
    if (!fresh) return;

    /* Query the theme's own parts rather than hardcoding them, but fall back
       to the known selectors if either is absent. */
    var parts = cfg.cartParts;
    parts.forEach(function (sel) {
      var mine = live.querySelector(sel);
      var theirs = fresh.querySelector(sel);
      if (!mine || !theirs || !mine.parentNode) return;
      mine.parentNode.replaceChild(document.importNode(theirs, true), mine);
    });
  }

  /* --- render ----------------------------------------------------------- */

  /* The design's own image placeholder, for products with no picture. */
  var PLACEHOLDER_SVG =
    '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#aab4c2" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"></rect>' +
    '<circle cx="9" cy="10" r="1.8"></circle>' +
    '<path d="M21 16l-5-5-8 9"></path></svg>';

  function renderSearch(host, onSearch) {
    var form = el('form', 'mtw-ml__search');
    form.setAttribute('role', 'search');

    var field = el('div', 'mtw-ml__search-field');
    field.innerHTML =
      '<svg class="mtw-ml__search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#5b6678" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>';

    var input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search by stock code, part name or trailer model';
    input.setAttribute('aria-label', 'Search trailers and parts');
    input.autocomplete = 'off';
    input.spellcheck = false;

    field.appendChild(input);

    var btn = el('button', null, 'Search');
    btn.type = 'submit';

    form.appendChild(field);
    form.appendChild(btn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      onSearch(input.value);
    });

    host.appendChild(form);

    return { input: input };
  }

  /* Scrubs a value on its way to the page. See cfg.redactWords.

     Only ever called where a spec value is written out, which is the build
     sheet, the summary tiles and the hotspot card. The CSV, and the stock
     codes that drive the parts list, are untouched.

     Removing a word from the middle of free text leaves tidying behind, so the
     result is cleaned up: doubled spaces, a " / " that used to have a word on
     one side of it, and separators stranded at either end. Interior separators
     are kept, because "738020 - AL13AS-405mm Air Suspension" still reads
     correctly with the dash in place. */
  function display(value) {
    var s = String(value == null ? '' : value);

    cfg.redactWords.forEach(function (w) {
      var safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      /* Boundary at the end only, never the start. Real values run the word
         straight into a chassis number - "D22NB000NWN5LHDALION LINKWING
         SPECIAL" - and requiring a boundary on both sides leaves that one
         untouched. A trailing boundary still stops it eating the start of a
         longer word such as "Alional". */
      s = s.replace(new RegExp(safe + '\\b', 'gi'), ' ');
    });

    s = s.replace(/\s*\/\s*/g, '/')                  // "MTW/ AL13" -> "MTW/AL13"
         .replace(/\s{2,}/g, ' ')
         .trim();

    /* Trimming separators off both ends tidies the gap a removed word leaves,
       but a value that is only punctuation is itself the data - "-" in the
       registration column, and similar in wheel_type_and_size and wip. So the
       trim only applies when something survives it, otherwise the value is
       left as it was minus the redacted word. */
    var trimmed = s.replace(/^[\s,;:.\-\/]+/, '').replace(/[\s,;:.\-\/]+$/, '').trim();
    if (trimmed) s = trimmed;

    /* A value that was only the redacted word is now nothing. Leaving a blank
       would read as missing data rather than removed data. */
    return s || '—';
  }

  function specList(rec, keys) {
    var dl = el('dl');
    var any = false;
    keys.forEach(function (k) {
      var v = rec.specs[k];
      if (!v) return;
      any = true;
      var wrap = el('div', 'mtw-ml__spec');
      var label = '';
      state.fields.forEach(function (f) { if (f.key === k) label = f.label; });
      wrap.appendChild(el('dt', null, label || k));
      wrap.appendChild(el('dd', null, display(v)));
      dl.appendChild(wrap);
    });
    return any ? dl : null;
  }

  function renderStage(host, rec) {
    var panel = el('div', 'mtw-ml__panel');
    panel.id = 'mtw-ml-panel';

    var head = el('div', 'mtw-ml__head');
    var titles = el('div');
    titles.appendChild(el('p', 'mtw-ml__eyebrow', 'Trailer'));
    titles.appendChild(el('h2', 'mtw-ml__head-title', rec.model || rec.type || 'Trailer'));
    head.appendChild(titles);
    head.appendChild(el('span', 'mtw-ml__code-chip',
      '[' + (rec.candidates[0] || rec.model || '') + ']'));
    panel.appendChild(head);

    /* Diagram beside the build sheet, rather than stacked. */
    var split = el('div', 'mtw-ml__split');

    var viewer = el('div', 'mtw-ml__viewer');
    viewer.id = 'mtw-ml-stage';

    rec2specsCache = rec.specs;
    viewer.innerHTML = buildSvg(rec);

    /* Attached after the SVG is in the DOM, because innerHTML cannot carry a
       listener across. */
    var art = viewer.querySelector('.mtw-ml__drawing');
    if (art) watchDrawing(art);

    /* The component card floats over the drawing. Selecting a part then
       explains itself in place instead of shoving the page around.

       Skipped entirely while cfg.hotspots is off - there is nothing to open
       it from, so it would only add an empty panel and a height mismatch
       against the build sheet beside it. */
    if (cfg.hotspots) {
      var float = el('div', 'mtw-ml__float');
      float.id = 'mtw-ml-float';
      float.hidden = true;
      viewer.appendChild(float);
    }

    Array.prototype.forEach.call(viewer.querySelectorAll('[data-mtw-ml-hot]'), function (shape) {
      shape.addEventListener('click', function () {
        selectHotspot(viewer, rec, shape.getAttribute('data-mtw-ml-hot'));
      });
    });

    split.appendChild(viewer);

    var side = el('div', 'mtw-ml__side');
    renderBuildSheet(side, rec);
    split.appendChild(side);

    /* Cap the information column to the drawing's height so the sheet scrolls
       inside its own panel rather than stretching the whole panel down.
       Measured after layout, because the drawing scales with the column width.
       Re-run on resize. */
    function matchHeights() {
      var h = Math.round(viewer.getBoundingClientRect().height);
      var body = side.querySelector('.mtw-ml__more-body');
      if (!body || !h) return;
      /* header + body + borders */
      var head = side.querySelector('.mtw-ml__side-title');
      var chrome = (head ? head.offsetHeight : 0) + 2;
      body.style.maxHeight = Math.max(120, h - chrome) + 'px';
    }
    matchHeights();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(matchHeights);
      ro.observe(viewer);
    } else {
      window.addEventListener('resize', matchHeights);
    }

    panel.appendChild(split);
    host.appendChild(panel);
    return viewer;
  }

  /* Explains a component in a card floating over the drawing. The card sits on
     the thing it describes, so a short tick pointing at it is enough - a
     labelled arrow across the drawing was decoration. */
  function selectHotspot(viewer, rec, id) {
    var hot = HOTSPOTS.filter(function (h) { return h.id === id; })[0];
    if (!hot) return;

    Array.prototype.forEach.call(viewer.querySelectorAll('.mtw-ml__hot'), function (s) {
      s.classList.remove('is-active');
    });
    Array.prototype.forEach.call(viewer.querySelectorAll('.mtw-ml__hot-group'), function (g) {
      g.classList.remove('is-active');
    });

    var shape = viewer.querySelector('[data-mtw-ml-hot="' + id + '"]');
    if (shape) shape.classList.add('is-active');
    var group = viewer.querySelector('[data-mtw-ml-group="' + id + '"]');
    if (group) group.classList.add('is-active');

    /* Tick from the dot down to the card. Kept short and inside the drawing
       so it points at the card rather than travelling across the trailer.
       Length is in the 1800x600 viewBox's units, not pixels - the old
       16 px tick was tuned for a 520-wide viewBox and would be invisible
       here. */
    var leader = viewer.querySelector('#mtw-ml-leader');
    if (leader && group) {
      var ax = parseFloat(group.getAttribute('data-anchor-x'));
      var ay = parseFloat(group.getAttribute('data-anchor-y'));
      leader.setAttribute('d', 'M' + ax + ' ' + ay + ' L' + ax + ' ' + (ay + 52));
      leader.classList.remove('is-drawn');
      void leader.getBoundingClientRect();
      leader.classList.add('is-drawn');
    }

    var float = clear(document.getElementById('mtw-ml-float'));
    float.hidden = false;

    var close = el('button', 'mtw-ml__float-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () {
      float.hidden = true;
      if (shape) shape.classList.remove('is-active');
      if (group) group.classList.remove('is-active');
    });
    float.appendChild(close);

    var list = specList(rec, hot.keys);
    float.appendChild(el('p', 'mtw-ml__float-title', hot.label));

    if (!list) {
      float.appendChild(el('p', 'mtw-ml__float-sub', 'Nothing recorded for this component.'));
      return;
    }

    float.appendChild(list);
  }

  /* The four-up spec cards above the full build sheet. Only fields with a value
     are shown, so an empty one does not sit there reading "undefined". */
  function renderFacts(rec) {
    var wrap = el('div', 'mtw-ml__facts');
    var shown = 0;

    cfg.factFields.forEach(function (f) {
      var v = rec.specs[f.key];
      if (!v) return;
      var box = el('div', 'mtw-ml__fact');
      box.appendChild(el('dt', null, f.label));
      box.appendChild(el('dd', null, display(v)));
      wrap.appendChild(box);
      shown++;
    });

    if (!shown) {
      wrap.appendChild(el('div', 'mtw-ml__fact mtw-ml__fact--empty',
        'No summary recorded for this trailer.'));
    }
    return wrap;
  }

  /* The information column. Always open - it is build-sheet data the visitor
   came for, so there is nothing to disclose. */
  function renderBuildSheet(host, rec) {
    host.appendChild(el('p', 'mtw-ml__side-title', 'Trailer information'));

    var body = el('div', 'mtw-ml__more-body');

    body.appendChild(renderFacts(rec));

    /* Build sheet only. The parts list lives in the cards below, so repeating
       the codes here just made the panel taller. */
    var list = specList(rec, state.fields.map(function (f) { return f.key; }));
    if (list) body.appendChild(list);
    else body.appendChild(el('p', 'mtw-ml__empty', 'Nothing recorded for this trailer.'));

    host.appendChild(body);
  }

  /* --- selection bar ----------------------------------------------------- */

  /* The design shows a plain bar, not a sticky one, and an "Added to cart"
     confirmation that turns the button green.

     This only flips the flag. Label and enabled state belong to updateBar(),
     which is the single place that reads the selection - setting them here as
     well left the button stuck disabled after the first successful add, and
     every later add silently did nothing. */
  function setAdded(on) {
    var btn = document.getElementById('mtw-ml-add');
    if (!btn) return;
    btn.className = on ? 'mtw-ml__add is-done' : 'mtw-ml__add';
    updateBar();
  }

  /* Parts render in two halves so cards can arrive one at a time. The shell
     (heading, count, grid) is built once, then each resolved product is
     appended. Previously the whole grid waited on the slowest code in the
     batch, which on a 27-code trailer meant staring at a blank area for over a
     second after the first cards were already in hand. */
  function partsShell(host) {
    var head = el('div', 'mtw-ml__cards-head');
    head.appendChild(el('h3', 'mtw-ml__cards-title', 'Parts'));
    var count = el('span', 'mtw-ml__cards-count', '');
    head.appendChild(count);
    host.appendChild(head);

    var grid = el('div', 'mtw-ml__cards');
    host.appendChild(grid);

    return {
      grid: grid,
      count: count,
      shown: 0,
      add: function (p, qty) {
        grid.appendChild(partCard(p, qty));
        this.shown++;
        count.textContent = this.shown + (this.shown === 1 ? ' result' : ' results');
      }
    };
  }

  function renderParts(host, rec, qty) {
    var index = state.index;
    var products = [];
    var missing = [];

    rec.codes.forEach(function (code) {
      var p = index[code];
      if (p) products.push(p);
      else missing.push(code);
    });

    /* De-duplicate. The same code can appear in two CODE cells, and sending it
       twice would double the quantity for no reason. */
    var seen = {};
    products = products.filter(function (p) {
      if (seen[p.sku]) return false;
      seen[p.sku] = true;
      return true;
    });

    if (!products.length) {
      var bare = el('div', 'mtw-ml__cards-head');
      bare.appendChild(el('h3', 'mtw-ml__cards-title', 'Parts'));
      host.appendChild(bare);
      host.appendChild(el('div', 'mtw-ml__empty',
        "We don't have a parts list for this trailer yet. Please contact us and we'll get it sorted."));
      return;
    }

    if (missing.length) {
      /* Kept quiet and out of the way. It matters to us, not to the person
         looking up their trailer. */
      var uniq = missing.filter(function (v, i, a) { return a.indexOf(v) === i; });
      warn('codes with no product:', uniq);
    }

    var shell = partsShell(host);
    products.forEach(function (p) { shell.add(p, qty); });
  }

  function partCard(p, qty) {
      var card = el('div', 'mtw-ml__card');
      if (p.stock === 'out') card.className += ' mtw-ml__card--out';
      card.style.position = 'relative';

      var media = el('div', 'mtw-ml__card-media');
      if (p.image) {
        var img = el('img');
        img.src = p.image;
        img.alt = '';
        img.loading = 'lazy';
        media.appendChild(img);
      } else {
        media.className += ' mtw-ml__card-media--none';
        media.innerHTML = PLACEHOLDER_SVG;
      }
      card.appendChild(media);

      var link = el('a', 'mtw-ml__card-link');
      link.href = p.url || (cfg.shopOrigin.replace(/\/+$/, '') + '/product/' + p.id);
      if (cfg.cardTarget === 'new') link.target = '_blank';
      link.setAttribute('aria-label', (p.name || p.sku) + ' - open product page');
      card.appendChild(link);

      var body = el('div', 'mtw-ml__card-body');

      var top = el('div', 'mtw-ml__card-top');
      top.appendChild(el('span', 'mtw-ml__card-code', p.sku));
      if (p.rrp != null && p.price != null && p.rrp > p.price) {
        top.appendChild(el('span', 'mtw-ml__card-rrp', 'RRP ' + money(p.rrp)));
      }
      body.appendChild(top);

      body.appendChild(el('h4', 'mtw-ml__card-name', p.name || p.sku));

      /* Absorbs the slack so price, stock and quantity sit on the bottom edge
         of every card and line up across the row. */
      body.appendChild(el('div', 'mtw-ml__card-fill'));

      var price = el('div', 'mtw-ml__card-price');
      var now = el('span', null, money(p.price));
      now.appendChild(el('small', null, ' Excl. GST'));
      price.appendChild(now);
      body.appendChild(price);

      var foot = el('div', 'mtw-ml__card-foot');

      /* Availability sits beside the stepper, not at the top of the card, so
         the code gets the top row and stock reads as part of the same
         "how many can I have" decision as the quantity control. */
      var stock = el('span', 'mtw-ml__stock mtw-ml__stock--' +
        (p.stock === 'out' ? 'out' : (p.stock === 'low' ? 'low' : 'in')),
        p.stock === 'out' ? 'Out of stock' : (p.stock === 'low' ? 'Low stock' : 'In stock'));
      stock.className += ' mtw-ml__card-stock';
      foot.appendChild(stock);

      foot.appendChild(stepper(p, qty));
      body.appendChild(foot);
      card.appendChild(body);
      return card;
  }

  /* Minus / value / plus. Defaults to 0, and 0 means "not adding", so the
     minus button is disabled at zero rather than wrapping to something odd. */
  function stepper(p, qty) {
    var box = el('div', 'mtw-ml__step');
    var buyable = canAdd(p);

    var minus = el('button', 'mtw-ml__step-btn', '\u2212');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Decrease quantity');

    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'mtw-ml__step-input';
    input.min = '0';
    input.step = '1';
    input.value = String(qty[p.sku] || 0);
    input.setAttribute('aria-label', 'Quantity for ' + (p.name || p.sku));
    input.disabled = !buyable;

    var plus = el('button', 'mtw-ml__step-btn', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Increase quantity');

    function set(n) {
      n = parseInt(n, 10);
      if (!(n > 0)) n = 0;
      if (!buyable) n = 0;
      input.value = String(n);
      if (n > 0) qty[p.sku] = n;
      else delete qty[p.sku];
      minus.disabled = n <= 0 || !buyable;
      writeUrl(state.rego, qty);
      /* Any quantity change makes an "Added to cart" confirmation stale.
         Done here rather than on a click listener so that typing a quantity
         into the field clears it too. */
      setAdded(false);
    }

    minus.addEventListener('click', function (e) {
      e.stopPropagation();
      set((parseInt(input.value, 10) || 0) - 1);
    });
    plus.addEventListener('click', function (e) {
      e.stopPropagation();
      set((parseInt(input.value, 10) || 0) + 1);
    });
    input.addEventListener('change', function () { set(input.value); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });

    minus.disabled = !(parseInt(input.value, 10) > 0) || !buyable;
    plus.disabled = !buyable;

    box.appendChild(minus);
    box.appendChild(input);
    box.appendChild(plus);
    return box;
  }

  /* Zero every stepper after a successful add. Without this the buttons keep
     showing the quantities that are now in the cart, and pressing "Add to
     cart" a second time silently doubles the order. */
  function resetQtys() {
    /* Cleared in place, not replaced. Every stepper closed over the object
       that was passed to it at render time, so swapping state.qty for a fresh
       {} would leave them writing to a detached object - the URL and the
       totals would silently stop following the steppers. */
    for (var sku in state.qty) {
      if (Object.prototype.hasOwnProperty.call(state.qty, sku)) delete state.qty[sku];
    }
    [].slice.call(document.querySelectorAll('.mtw-ml__step-input')).forEach(function (i) {
      i.value = '0';
    });
    /* The minus button is the first of each pair and is the one that is
       enabled above zero. */
    [].slice.call(document.querySelectorAll('.mtw-ml__step-btn')).forEach(function (b) {
      if (b.textContent.trim() === '\u2212') b.disabled = true;
    });
    writeUrl(state.rego, state.qty);
  }

  function selectedLines() {
    var lines = [];
    var units = 0;
    var value = 0;

    for (var sku in state.qty) {
      if (!Object.prototype.hasOwnProperty.call(state.qty, sku)) continue;
      var n = state.qty[sku];
      var p = state.index[sku];
      if (!n || !p || !canAdd(p)) continue;
      lines.push({ product: p, qty: n });
      units += n;
      if (typeof p.price === 'number') value += p.price * n;
    }
    return { lines: lines, units: units, value: value };
  }

  function updateBar() {
    var sel = selectedLines();
    var bar = document.getElementById('mtw-ml-bar');
    if (!bar) return;

    var btn = document.getElementById('mtw-ml-add');
    if (!btn) return;

    /* Mid-request only. The "Added to cart" label is fine to keep until the
       selection changes - setAdded(false) clears it - but the enabled state
       always tracks the selection, otherwise a confirmation would leave the
       button dead. */
    if (btn.dataset.working !== '1') {
      btn.disabled = !sel.lines.length;
      btn.textContent = btn.className.indexOf('is-done') > -1 ? 'Added to cart' : 'Add to cart';
    }

    /* These are two separate elements. Writing textContent to the parent
       would wipe the count span out of the DOM on the first update. */
    var count = document.getElementById('mtw-ml-bar-count');
    var value = document.getElementById('mtw-ml-bar-value');
    if (count) count.textContent = sel.units + (sel.units === 1 ? ' item' : ' items');
    if (value) value.textContent = ' \u00b7 ' + money(sel.value) + ' Excl. GST';
  }

  function renderBar(host) {
    var bar = el('div', 'mtw-ml__bar');
    bar.id = 'mtw-ml-bar';

    var info = el('div', 'mtw-ml__bar-info');
    info.appendChild(el('span', 'mtw-ml__bar-label', 'Selected'));
    var line = el('span', 'mtw-ml__bar-total');
    var count = el('span', 'mtw-ml__bar-count', '0 items');
    count.id = 'mtw-ml-bar-count';
    var value = el('span', 'mtw-ml__bar-value', ' \u00b7 $0.00 Excl. GST');
    value.id = 'mtw-ml-bar-value';
    line.appendChild(count);
    line.appendChild(value);
    info.appendChild(line);
    bar.appendChild(info);

    var btn = el('button', 'mtw-ml__add', 'Add to cart');
    btn.id = 'mtw-ml-add';
    btn.type = 'button';
    btn.disabled = true;
    btn.addEventListener('click', function () {
      var sel = selectedLines();
      if (!sel.lines.length) { warn('nothing to add'); return; }

      /* Only claim success once the shop has confirmed it. The old version
         flipped the button green the instant it was clicked, which was a lie
         whenever the request failed. */
      btn.dataset.working = '1';
      btn.disabled = true;
      btn.textContent = 'Adding…';

      addToCart(sel.lines).then(function () {
        btn.dataset.working = '0';
        setAdded(true);
        resetQtys();
        updateBar();
      }, function (err) {
        btn.dataset.working = '0';
        warn('add to cart failed', err);
        btn.disabled = false;
        btn.textContent = 'Add to cart — try again';
      });
    });
    bar.appendChild(btn);

    host.appendChild(bar);
    updateBar();
  }

  function renderResult(host, rec, qty, note) {
    clear(host);

    if (!rec) {
      host.appendChild(el('div', 'mtw-ml__empty',
        "We don't have a record of that registration. Check the number and try again."));
      return;
    }

    renderStageOnly(host, rec);

    if (rec.codes.length) {
      renderParts(host, rec, qty);
      renderBar(host);
    } else {
      finishEmpty(host, rec);
    }

    if (note) host.appendChild(el('p', 'mtw-ml__lookup-note', note));
  }

  function renderStageOnly(host, rec) {
    clear(host);
    renderStage(host, rec);
  }

  function finishEmpty(host, rec) {
    host.appendChild(el('div', 'mtw-ml__empty',
      "Unfortunately we don't have a parts list for this trailer yet. " +
      'The build sheet above is everything we hold on it - please contact us for parts.'));
  }

  function renderPartsAndBar(host, rec) {
    var status = document.getElementById('mtw-ml-lookup');
    if (status && status.parentNode) status.parentNode.removeChild(status);

    /* Rebuild only the parts area. The diagram and the accordion stay put so
       a parts re-render does not collapse the trailer back to a bare search. */
    var stale = [].slice.call(host.querySelectorAll(
      '.mtw-ml__cards-head, .mtw-ml__cards, .mtw-ml__bar, .mtw-ml__empty'));
    stale.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });

    var partsHost = el('div');
    partsHost.style.marginTop = '16px';
    host.appendChild(partsHost);

    renderParts(partsHost, rec, state.qty);
    if (Object.keys(state.index).length) renderBar(partsHost);
  }

  function lookup(raw) {
    var key = regoKey(raw);
    if (!key) return { rec: null };
    /* state.records is already the rego -> record map built by shape(); there
       is no .index on it. */
    var exact = state.records[key];
    if (exact) return { rec: exact };

    /* Fall back to a substring match so a partly-remembered rego still
       finds something, but only when it is unambiguous. */
    var hits = [];
    for (var k in state.records) {
      if (Object.prototype.hasOwnProperty.call(state.records, k) && k.indexOf(key) > -1) hits.push(k);
    }
    if (hits.length === 1) return { rec: state.records[hits[0]] };
    return { rec: null, ambiguous: hits.length > 1 };
  }

  /* --- boot ------------------------------------------------------------- */

  function mount() {
    var host = document.querySelector(cfg.mount);
    if (!host) { warn('no mount point for', cfg.mount); return; }
    if (host.getAttribute(MARK) === 'done') return;
    host.setAttribute(MARK, 'done');

    loadCss();
    loadFonts();

    var box = el('div', 'mtw-ml' + (cfg.hotspots ? '' : ' mtw-ml--no-hotspots'));
    host.appendChild(box);

    /* Search first, then results. renderSearch appends to box, so it has to
       be called before the results container or the bar ends up underneath. */
    var search = renderSearch(box, function (value) {
      var found = lookup(value);
      state.rego = found.rec ? found.rec.candidates[0] : regoKey(value);
      writeUrl(state.rego, state.qty);
      runLookup(found.rec, search.input);
    });

    var results = el('div');
    box.appendChild(results);
    results.appendChild(el('div', 'mtw-ml__loading', 'Loading the parts database...'));

    /* Bumped on every search. A slow lookup from a previous rego checks this
       before it touches the DOM, otherwise a late response paints cards for
       the wrong trailer on top of the right one. */
    var generation = 0;

    function runLookup(rec, input) {
      var mine = ++generation;

      if (!rec) {
        state.index = {};
        renderResult(results, null, state.qty, null);
        if (input) input.blur();
        return;
      }

      /* The build sheet and diagram are available immediately - they come
         straight from the CSV. Only the parts need the network. */
      renderStageOnly(results, rec);

      if (!rec.codes.length) {
        finishEmpty(results, rec);
        if (input) input.blur();
        return;
      }

      var status = el('p', 'mtw-ml__lookup-note',
        'Looking up ' + rec.codes.length + ' parts\u2026');
      status.id = 'mtw-ml-lookup';
      results.appendChild(status);

      /* Built up front and left disabled until something is selected, so the
         totals are visible while the rest of the codes are still coming in
         rather than popping into existence at the end. */
      var shell = partsShell(results);
      renderBar(results);

      /* Cards land per batch rather than all at once, so a trailer with 165
         codes shows its first parts while the rest are still being asked for.

         Painted on a short timer rather than requestAnimationFrame: rAF is
         suspended in a background tab, which meant a visitor who searched,
         switched away and came back found an empty grid waiting on a frame
         that would not arrive until they focused the page again. */
      var queue = [];
      var timer = 0;

      function flush() {
        timer = 0;
        if (mine !== generation) return;
        while (queue.length) {
          var p = queue.shift();
          /* One code can sit in two CODE cells; adding it twice would double
             the quantity for nothing. */
          if (state.index[p.sku]) continue;
          state.index[p.sku] = p;
          shell.add(p, state.qty);
        }
        updateBar();
      }

      function schedule(p) {
        queue.push(p);
        if (!timer) timer = window.setTimeout(flush, 16);
      }

      resolveCodes(rec.codes, schedule).then(function () {
        if (mine !== generation) return;
        if (timer) { window.clearTimeout(timer); timer = 0; }
        flush();

        /* Nothing came back, so the empty shell is worse than nothing. Swap it
           for the plain message. renderPartsAndBar clears these same nodes. */
        if (!shell.shown) {
          if (status && status.parentNode) status.parentNode.removeChild(status);
          renderPartsAndBar(results, rec);
        } else if (status && status.parentNode) {
          status.parentNode.removeChild(status);
        }
        if (input) input.blur();
      }).catch(function (e) {
        if (mine !== generation) return;
        warn('lookup failed:', e);
        if (status && status.parentNode) status.parentNode.removeChild(status);
        renderPartsAndBar(results, rec);
      });
    }

    /* The CSV and the drawing map load together. Neither is needed for a trailer
       to be found, so a failure in the map must not take the whole widget down
       with it - the build sheet is still worth showing without a drawing.

       The CSV goes through loadCsvText, which is what resolves where it lives:
       from Firestore by default, or straight from csvUrl. */
    var boot = [
      loadCsvText().then(parseCsvAsync),
      getJson(cfg.trailerMapUrl).catch(function (e) {
        warn('no trailer drawings:', e && e.message);
        return null;
      })
    ];
    if (!cfg.lookupOnDemand && cfg.lookupIndexUrl) boot.push(getJson(cfg.lookupIndexUrl));

    Promise.all(boot).then(function (both) {
      var parsed = both[0];
      if (!parsed.rows.length) throw new Error('CSV had no data rows');

      var shaped = shape(parsed);

      state = {
        records: shaped.index,
        fields: shaped.fields,
        trailers: both[1],
        index: cfg.lookupOnDemand ? {} : shapeIndex(both[2]),
        qty: {},
        rego: ''
      };

      clear(results);

      /* Restore from the URL, so a card link out and back lands on the same
         trailer with the same quantities. */
      var url = readUrl();
      if (url.rego) {
        state.qty = url.qty;
        var found = lookup(url.rego);
        state.rego = found.rec ? found.rec.candidates[0] : url.rego;
        search.input.value = found.rec ? found.rec.candidates[0] : url.rego;
        runLookup(found.rec, null);
      } else {
        results.appendChild(el('div', 'mtw-ml__empty', 'Enter your registration number to begin.'));
      }
    }).catch(function (e) {
      var box2 = el('div', 'mtw-ml__error');
      box2.appendChild(el('strong', null, 'Could not load the parts database. '));
      box2.appendChild(document.createTextNode(e && e.message ? e.message : String(e)));
      clear(results).appendChild(box2);
      warn('load failed:', e);
    });
  }

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else mount();
  }

  start();
})();