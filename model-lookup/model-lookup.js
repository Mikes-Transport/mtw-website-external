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

    /* The one CSV. Must be committed to the repo for raw.githack to serve it. */
    csvUrl: 'https://raw.githack.com/Mikes-Transport/mtw-website-external/main/model-lookup/data/rego_search.csv',

    shopOrigin: 'https://www.mtw.co.nz',

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
    lookupCacheDays: 7,

    /* Columns. regoField is the one the customer types into. */
    columns: { rego: 'registration' },

    /* CODE1..CODE250 */
    codePattern: /^CODE(\d+)$/i,

    cacheHours: 12,
    addMode: 'popup',
    popupCloseMs: 4000,

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

  /* RFC4180-ish. Needed rather than split(',') because trailer_type and the
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

  /* One stock code -> one product, via the shop's own search.

     A stock code is NOT a product id: /product/170255-x is a 404, the shop
     only accepts its internal id there. Search is the route that resolves it.

     The search result page carries the same markup the model table uses - a
     .model element per row holding the stock code, and a product link beside
     it - so the code is matched back to its own link rather than trusting
     position. A search that ignored the query returns nothing usable here. */
  function lookupProduct(code) {
    var token = csrfToken();
    if (!token) return Promise.resolve(null);

    return fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: '_csrf_token=' + encodeURIComponent(token) + '&keywords=' + encodeURIComponent(code)
    }).then(function (r) {
      if (!r.ok) throw new Error('search HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var cells = [].slice.call(doc.querySelectorAll('.model'));
      var links = [].slice.call(doc.querySelectorAll('a[href*="/product/"]'));

      for (var i = 0; i < cells.length; i++) {
        if (String(cells[i].textContent).trim().toUpperCase() !== String(code).toUpperCase()) continue;

        /* find the product link on the same row as this code */
        var row = cells[i].closest('tr') || cells[i].parentNode;
        var href = null;
        var scope = row && row.querySelector ? row : doc;
        var candidates = [].slice.call(scope.querySelectorAll('a[href*="/product/"]'));
        href = candidates.length ? candidates[0].getAttribute('href') : null;
        if (!href) {
          for (var j = 0; j < links.length; j++) {
            var inRow = row && row.contains ? row.contains(links[j]) : false;
            if (inRow) { href = links[j].getAttribute('href'); break; }
          }
        }
        if (href) return fetchProductPage(href);
      }
      return null;
    });
  }

  /* The search page gives sku and product id but not the price, the image or
     the stock state, so the product page is read too. Both are same-origin. */
  function fetchProductPage(href) {
    var url = href.indexOf('http') === 0 ? href : location.origin + href;
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('product HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) { return parseProductPage(html); });
  }

  function parseProductPage(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var ld = doc.querySelector('script[type="application/ld+json"]');
    var data = null;
    if (ld) { try { data = JSON.parse(ld.textContent); } catch (e) { data = null; } }
    if (!data || !data.sku) return null;

    /* Price from the visible block, NOT ld+json offers.price - that is the
       same price with GST added, which would overstate everything by 15%. */
    var priceEl = doc.querySelector('div.price div.value');
    var price = null;
    if (priceEl) {
      var m = priceEl.textContent.replace(/[^0-9.,]/g, '');
      if (m) price = parseFloat(m.replace(/,/g, ''));
    }

    var rrpEl = doc.querySelector('div.rrp .retail-value');
    var rrp = null;
    if (rrpEl) {
      var rm = rrpEl.textContent.replace(/[^0-9.,]/g, '');
      if (rm) rrp = parseFloat(rm.replace(/,/g, ''));
    }

    /* Worst state across branches. The cart silently refuses both
       out-of-stock and low-stock, so they are kept apart. */
    var stock = 'in';
    var states = [].slice.call(doc.querySelectorAll('div.stock-label')).map(function (l) {
      var v = l.nextElementSibling;
      return v ? v.textContent.trim().toLowerCase() : '';
    });
    if (states.some(function (s) { return /out of stock/.test(s); })) stock = 'out';
    else if (states.some(function (s) { return /low stock/.test(s); })) stock = 'low';

    var link = doc.querySelector('link[rel="canonical"]');
    var url = link ? link.getAttribute('href') : null;
    if (!url) {
      var a = doc.querySelector('a[href*="/product/"]');
      url = a ? a.getAttribute('href') : null;
    }

    return {
      id: (url && url.match(/\/product\/(\d+)-/)) ? parseInt(url.match(/\/product\/(\d+)-/)[1], 10) : null,
      sku: String(data.sku),
      name: data.name || null,
      image: (data.image && data.image[0]) || null,
      price: price,
      rrp: (rrp != null && price != null && rrp > price) ? rrp : null,
      url: url,
      stock: stock,
      foundAt: Date.now()
    };
  }

  /* Resolve a trailer's codes, four at a time.

     Sequential would be safer but a trailer can carry 165 codes, and four
     concurrent same-origin requests is a fraction of what any page makes
     during normal browsing. Cached codes never hit the network at all. */
  function resolveCodes(codes, onEach) {
    var cache = cachedProducts();
    var out = [];
    var todo = [];

    codes.forEach(function (code) {
      var hit = cache[code];
      if (cacheFresh(hit)) out.push(hit);
      else todo.push(code);
    });

    if (!todo.length) return Promise.resolve(out);

    var queue = todo.slice();
    var workers = [];
    var width = Math.min(4, queue.length);

    function worker() {
      var code = queue.shift();
      if (!code) return Promise.resolve();

      return lookupProduct(code).then(function (rec) {
        if (rec) {
          cache[code] = rec;
          out.push(rec);
        } else {
          cache[code] = { sku: code, foundAt: Date.now(), missing: true };
        }
        if (onEach) onEach(out.length, todo.length);
      }).catch(function (e) {
        /* Leave it uncached so the next visit can try again - a transient
           failure should not be remembered as "no such product". */
        warn('lookup failed for', code, e && e.message);
      }).then(worker);
    }

    for (var i = 0; i < width; i++) workers.push(worker());

    return Promise.all(workers).then(function () {
      saveProducts(cache);
      return out;
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

  /* --- trailer diagram --------------------------------------------------- */

  /* Diagram shape from the type string. The file has 1,064 distinct
     trailer_type values; among rows that have parts there are 26, falling into
     these. Anything unrecognised draws as a plain deck rather than something
     misleading. */
  function archetype(type) {
    var t = String(type || '');
    var a = { body: 'deck', wings: false, neck: false, hopper: false, cabin: false, kingpin: true };
    if (/\bdolly\b/i.test(t)) { a.body = 'dolly'; a.kingpin = false; }
    else if (/clip[\s-]?on/i.test(t)) { a.body = 'clipon'; a.kingpin = false; }
    else if (/b[\s-]?train/i.test(t)) { a.neck = true; }
    else if (/widen|FTLL|flat top low loader/i.test(t)) { a.wings = true; }
    else if (/link\s?wing|\bLW1\b|\bXHN\b/i.test(t)) { a.wings = true; }
    else if (/tipper|dumper|bin|tanker|tank\b/i.test(t)) { a.hopper = true; }
    else if (/house trailer|jack(ing)? plant/i.test(t)) { a.cabin = true; }
    return a;
  }

  /* Leading number of a type string: "3A Semi Transporter" -> 3,
     "2R8 Dolly" -> 2, "5 Axle B-Train" -> 5. */
  function axleCount(type, fallback) {
    var t = String(type || '').trim();
    var m = t.match(/^(\d)\s*(?:[AR]\s*(\d))?[A-Za-z]/) || t.match(/(\d)\s*axle/i);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= 9) return n;
    }
    return fallback || 3;
  }

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

  /* Geometry follows the reference drawing: a 520x230 side view with the blue
     drawbar and rail, a panelled body with ribs, a red rear marker, and
     wheels drawn as a light disc with a dark rim and a blue hub. Axle count
     and body shape come from the trailer type. */
  function buildSvg(rec) {
    var a = archetype(rec.type);
    var n = Math.max(2, Math.min(6, axleCount(rec.type, 3)));
    var p = [];

    /* Proportioned to the reference drawing: a shallow box sitting just above a
       tight wheel pair, not a tall slab with a lot of empty panel in it.
       viewBox is 520x230 and the whole trailer sits inside y 50-215. */
    var bodyX = 96, bodyY = 70, bodyW = 330, bodyH = 74, railY = 158;
    var wheelY = 182, wheelR = 18;

    if (a.body === 'dolly') { bodyX = 250; bodyW = 210; }
    if (a.body === 'clipon') { bodyX = 180; bodyW = 270; }

    /* Wheels under the rear of the body, clear of each other and of the rail.
       Spacing must clear the diameter plus a gap, or they fuse into a blob. */
    var wheels = [];
    var gap = wheelR * 2 + 12;
    for (var i = 0; i < n; i++) wheels.push(bodyX + bodyW - 58 - i * gap);

    p.push('<svg class="mtw-ml__svg" viewBox="0 0 520 230" role="img" aria-label="' +
      (rec.type || 'Trailer') + ' side view">');

    p.push('<path d="M20 206H500" class="mtw-ml__line mtw-ml__line--ground"/>');

    /* body panel, divider and ribs */
    p.push('<rect x="' + bodyX + '" y="' + bodyY + '" width="' + bodyW + '" height="' + bodyH +
      '" rx="8" class="mtw-ml__body"/>');
    p.push('<path d="M' + bodyX + ' ' + (bodyY + 26) + 'H' + (bodyX + bodyW) +
      '" class="mtw-ml__line mtw-ml__line--divider"/>');

    /* Two ribs only. The reference drawing has four, but on a body this shallow
       more than two turns the panel into graph paper. */
    var ribs = [];
    for (var r = bodyX + 82; r < bodyX + bodyW - 50; r += 110) {
      ribs.push('M' + r + ' ' + bodyY + 'V' + (bodyY + bodyH));
    }
    if (ribs.length) p.push('<path d="' + ribs.join(' ') + '" class="mtw-ml__line mtw-ml__line--rib"/>');

    if (a.hopper) {
      p.push('<path d="M' + (bodyX + 4) + ' ' + bodyY + 'V52H' + (bodyX + bodyW - 4) +
        'V' + bodyY + '" class="mtw-ml__line"/>');
    }
    if (a.cabin) {
      p.push('<rect x="' + (bodyX + 10) + '" y="38" width="100" height="32" rx="7" class="mtw-ml__body"/>');
    }
    if (a.wings) {
      p.push('<path d="M' + (bodyX + 20) + ' ' + bodyY + 'V54H' + (bodyX + bodyW - 20) +
        'V' + bodyY + '" class="mtw-ml__line mtw-ml__line--rib"/>');
    }

    /* rear marker, as the reference draws it */
    p.push('<rect x="' + (bodyX + bodyW - 5) + '" y="' + (bodyY + 34) +
      '" width="11" height="20" rx="3" class="mtw-ml__flag"/>');

    if (a.kingpin) {
      p.push('<path d="M' + bodyX + ' ' + railY + 'L' + (bodyX - 44) +
        ' 180" class="mtw-ml__line mtw-ml__line--drawbar"/>');
      p.push('<path d="M' + (bodyX - 36) + ' 173V188" class="mtw-ml__line mtw-ml__line--leg"/>');
      p.push('<circle cx="' + (bodyX - 36) + '" cy="190" r="5" class="mtw-ml__hitch"/>');
    }
    p.push('<path d="M' + bodyX + ' ' + railY + 'H' + (bodyX + bodyW + 12) +
      '" class="mtw-ml__line mtw-ml__line--rail"/>');

    /* highlighted span, sitting on the rail */
    p.push('<path d="M' + (bodyX + bodyW - 130) + ' ' + (railY - 3) + 'H' +
      (bodyX + bodyW - 80) + '" class="mtw-ml__highlight"/>');

    /* landing legs */
    p.push('<path d="M' + (bodyX + 34) + ' ' + railY + 'V' + (railY + 18) + 'M' +
      (bodyX + 45) + ' ' + railY + 'V' + (railY + 18) + '" class="mtw-ml__line mtw-ml__line--leg"/>');

    wheels.forEach(function (cx) {
      p.push('<circle cx="' + cx + '" cy="' + wheelY + '" r="' + wheelR + '" class="mtw-ml__wheel"/>');
      p.push('<circle cx="' + cx + '" cy="' + wheelY + '" r="6" class="mtw-ml__hub"/>');
    });

    var geo = {
      bodyX: bodyX, bodyY: bodyY, bodyW: bodyW, bodyH: bodyH,
      railY: railY, wheelY: wheelY, wheelR: wheelR
    };

    p.push(HOTSPOTS.map(function (h) {
      return hotspot(h, a, wheels, geo);
    }).join(''));

    /* Short tick from the active dot down toward the card. Redrawn on every
       click rather than shipped empty, so there is nothing to show before a
       component is chosen. */
    p.push('<path class="mtw-ml__leader" id="mtw-ml-leader" d=""/>');

    p.push('</svg>');
    return p.join('');
  }

  /* Small dots in the drawing's own accent, so they read as part of the
     artwork rather than a layer sitting on top of it.

     Each is nudged onto the thing it names, and the leader anchor sits above
     the dot so the arrow never crosses the drawing to get to the panel. */
  /* g carries the shared drawing geometry. Passing one object rather than nine
     positional arguments, because dropping one of them silently breaks every
     marker instead of failing loudly. */
  function hotspot(h, a, wheels, g) {
    var rear = wheels[0], front = wheels[wheels.length - 1];
    var bodyX = g.bodyX, bodyW = g.bodyW, bodyY = g.bodyY, bodyH = g.bodyH;
    var railY = g.railY, wheelY = g.wheelY, wheelR = g.wheelR;

    /* Each dot sits on the thing it names, spread along the trailer so they
       do not pile up at the rear axle. Brakes sit low on the suspension,
       wheels on the hub, and both anchor below so their leader arrow leaves
       downward rather than through the tyre. */
    var spots = {
      body: { x: bodyX + bodyW * 0.26, y: bodyY + 16 },
      kingpin: a.kingpin ? { x: bodyX - 36, y: 190 } : { x: bodyX + 30, y: bodyY + bodyH - 10 },
      front: { x: bodyX + 34, y: 182 },
      mid: { x: bodyX + bodyW * 0.58, y: bodyY + bodyH - 9 },
      widening: a.wings ? { x: bodyX + bodyW * 0.78, y: 54 } : null,
      suspension: { x: bodyX + bodyW * 0.80, y: railY + 3 },
      /* On the hub of the leading and trailing wheels respectively, nudged
         apart so two dots never land on one tyre. */
      brakes: { x: front, y: wheelY },
      wheels: { x: rear, y: wheelY }
    };

    var s = spots[h.id];
    if (!s) return '';

    var present = hasAny(rec2specsCache, h.keys);
    var r = 8;

    /* No text label. The card that appears on click says what the component is,
       and repeating it on the drawing as well was noise. */
    return '<g class="mtw-ml__hot-group' + (present ? ' is-recorded' : ' is-empty') + '"' +
      ' data-mtw-ml-group="' + h.id + '"' +
      ' data-anchor-x="' + s.x + '" data-anchor-y="' + (s.y + r + 2) + '">' +
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

  function addToCart(lines) {
    if (!lines.length) return;
    var qs = lines.map(function (l) {
      return 'quantity%5B' + encodeURIComponent(l.product.id) + '%5D=' + encodeURIComponent(l.qty);
    }).join('&');
    var url = cfg.shopOrigin.replace(/\/+$/, '') + '/cart/add?' + qs;

    if (cfg.addMode === 'same') { window.location.href = url; return; }

    var w = null;
    try {
      w = window.open(url, '_blank', 'width=180,height=80,left=-200,top=-200');
    } catch (e) { w = null; }

    if (!w) {
      warn('popup blocked, falling back to same-tab navigation');
      window.location.href = url;
      return;
    }

    if (cfg.addMode === 'popup') {
      window.setTimeout(function () { try { w.close(); } catch (e) {} }, cfg.popupCloseMs);
    }
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
      wrap.appendChild(el('dd', null, v));
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

    /* The component card floats over the drawing. Selecting a part then
       explains itself in place instead of shoving the page around. */
    var float = el('div', 'mtw-ml__float');
    float.id = 'mtw-ml-float';
    float.hidden = true;
    viewer.appendChild(float);

    Array.prototype.forEach.call(viewer.querySelectorAll('[data-mtw-ml-hot]'), function (shape) {
      shape.addEventListener('click', function () {
        selectHotspot(viewer, rec, shape.getAttribute('data-mtw-ml-hot'));
      });
    });

    split.appendChild(viewer);

    var side = el('div', 'mtw-ml__side');
    renderBuildSheet(side, rec);
    split.appendChild(side);

    /* Match the information column to the drawing's height, whatever the
       trailer type. Measured after layout, because the drawing scales with
       the column width. Re-run on resize. */
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
       so it points at the card rather than travelling across the trailer. */
    var leader = viewer.querySelector('#mtw-ml-leader');
    if (leader && group) {
      var ax = parseFloat(group.getAttribute('data-anchor-x'));
      var ay = parseFloat(group.getAttribute('data-anchor-y'));
      leader.setAttribute('d', 'M' + ax + ' ' + ay + ' L' + ax + ' ' + (ay + 16));
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
      box.appendChild(el('dd', null, v));
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
     confirmation that turns the button green. */
  function setAdded(on) {
    var btn = document.getElementById('mtw-ml-add');
    if (!btn) return;
    btn.className = on ? 'mtw-ml__add is-done' : 'mtw-ml__add';
    btn.textContent = on ? 'Added to cart' : 'Add to cart';
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

    var head = el('div', 'mtw-ml__cards-head');
    head.appendChild(el('h3', 'mtw-ml__cards-title', 'Parts'));
    head.appendChild(el('span', 'mtw-ml__cards-count',
      products.length + (products.length === 1 ? ' result' : ' results')));
    host.appendChild(head);

    if (!products.length) {
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

    var grid = el('div', 'mtw-ml__cards');

    products.forEach(function (p) {
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
      grid.appendChild(card);
    });

    host.appendChild(grid);
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
      updateBar();
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
    /* Any quantity change means the confirmation is stale. */
    box.addEventListener('click', function () { setAdded(false); });

    minus.disabled = !(parseInt(input.value, 10) > 0) || !buyable;
    plus.disabled = !buyable;

    box.appendChild(minus);
    box.appendChild(input);
    box.appendChild(plus);
    return box;
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
    btn.disabled = !sel.lines.length;
    btn.textContent = sel.lines.length ? 'Add to cart' : 'Add to cart';

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
      addToCart(sel.lines);
      setAdded(true);
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

    var box = el('div', 'mtw-ml');
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

    function runLookup(rec, input) {
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

      var status = document.getElementById('mtw-ml-lookup');
      if (!status) {
        status = el('p', 'mtw-ml__lookup-note');
        status.id = 'mtw-ml-lookup';
        results.appendChild(status);
      }
      status.textContent = 'Looking up ' + rec.codes.length + ' parts\u2026';

      resolveCodes(rec.codes).then(function (found) {
        var index = {};
        found.forEach(function (p) { if (!p.missing) index[p.sku] = p; });
        state.index = index;

        if (status && status.parentNode) status.parentNode.removeChild(status);
        renderPartsAndBar(results, rec);
        if (input) input.blur();

        var stage = document.getElementById('mtw-ml-stage');
        if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }).catch(function (e) {
        warn('lookup failed:', e);
        if (status) status.textContent = 'Could not load part details. Please try again.';
      });
    }

    /* Only the CSV is fetched up front. The product index, if one is being
       used, loads alongside it. */
    var boot = [getText(cfg.csvUrl)];
    if (!cfg.lookupOnDemand && cfg.lookupIndexUrl) boot.push(getJson(cfg.lookupIndexUrl));

    Promise.all(boot).then(function (both) {
      var parsed = parseCsv(both[0]);
      if (!parsed.rows.length) throw new Error('CSV had no data rows');

      var shaped = shape(parsed);

      state = {
        records: shaped.index,
        fields: shaped.fields,
        index: cfg.lookupOnDemand ? {} : shapeIndex(both[1]),
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