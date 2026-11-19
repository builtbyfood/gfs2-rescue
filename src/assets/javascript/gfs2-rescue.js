/* GFS2 Rescue 0.1.25 - GFS2 Storage cluster tab.
 * Loaded by the page watcher (hbs/gfs2RescueLoader) the first time the tab is visible, never on
 * page load. Nothing is requested from the plugin until then, and a scan of the hosts runs only
 * on Scan now (or on opening the tab, if the plugin is set to scan when the tab is opened).
 * All calls are POSTs to /plugin/gfs2Rescue/* with core's CSRF token and the X-GR-Request header
 * (the vm-folders approach: core rejects plugin POSTs without its Spring Security token).
 * Every value from the server is HTML-escaped before it is placed in the page. */
(function () {
  'use strict';
  var API = '/plugin/gfs2Rescue';
  // Per-user: 'off' = do not scan when the tab is opened, even if the plugin setting allows it.
  var AUTO_KEY = 'gfs2Rescue.tab.autoload';
  function autoOff() { try { return window.localStorage.getItem(AUTO_KEY) === 'off'; } catch (e) { return false; } }
  function setAutoOff(off) {
    try { if (off) window.localStorage.setItem(AUTO_KEY, 'off'); else window.localStorage.removeItem(AUTO_KEY); }
    catch (e) { /* storage not available: the choice lasts for this page only */ }
  }
  var STEP_LABEL = { reuuid: 'Re-UUID', collect: 'Collect', check: 'Check', repair: 'Repair', adopt: 'Adopt', attach: 'Attach', verify: 'Verify' };
  var STEP_HELP = {
    reuuid: 'Gives this copy a new filesystem UUID (tunegfs2 -U) after backing up its superblock. Data and lock table are unchanged.',
    collect: 'Read-only. Saves the superblock, a manifest of every file, hashes of small files and a qcow2 backing-chain report.',
    check: 'Read-only fsck.gfs2 -n, graded clean / tier1 / tier2 / tier3.',
    repair: 'fsck.gfs2 -y for tier1/tier2 findings, re-check, then a walk against the manifest before any cluster mounts it.',
    adopt: 'Rewrites the lock table to this cluster. Data and UUID are unchanged.',
    attach: 'Adds it as an HPE Clustered Datastore through the Morpheus API, with reformatting always off. Morpheus then mounts it on every host.',
    verify: 'After Morpheus mounts it: compares every entry and hash with the manifest.'
  };
  var TIER_TEXT = {
    clean: 'No findings.',
    tier1: 'Accounting leftovers only (unowned data blocks, free counts, statfs). Safe to repair.',
    tier2: 'Inode accounting findings. Repair can orphan a directory entry, so it walks the result against the manifest and lists anything unreadable.',
    tier3: 'Structural findings. Stop: repair only on a clone of the array snapshot, with a person reviewing it.'
  };

  // ---------------------------------------------------------------- styles
  // Injected the first time the tab is opened (they used to ride along in the tab HTML of every
  // cluster page). Light and dark; every rule is scoped to #gr-root.
  var CSS = [
    "/* Light theme */",
    "#gr-root { --gr-bg:#f4f6f8; --gr-card:#ffffff; --gr-card2:#f8f9fb; --gr-border:#d0d7de; --gr-text:#1f2328; --gr-muted:#57606a;",
    "--gr-accent:#01A982; --gr-accent-dark:#00775c; --gr-sel:#e3f4ee; --gr-hover:#f0f3f6; --gr-code:#eef1f4; --gr-code-text:#1f2328;",
    "--gr-warn:#7a4a00; --gr-warn-bg:#fff4e0; --gr-bad:#b3261e; --gr-bad-bg:#fdecea; --gr-ok:#00664f; --gr-ok-bg:#e3f4ee;",
    "font-family:-apple-system,\"Segoe UI\",sans-serif; font-size:12px; color:var(--gr-text) !important; background:var(--gr-bg) !important; padding:12px; min-height:420px; border-radius:4px; }",
    "/* Dark theme: darker than the Morpheus surface so the tab reads as one panel */",
    "#gr-root.gr-dark { --gr-bg:#0b0e13; --gr-card:#12161d; --gr-card2:#161b24; --gr-border:#262e3b; --gr-text:#e8edf4; --gr-muted:#9aa6b6;",
    "--gr-accent:#01A982; --gr-accent-dark:#3fd3ac; --gr-sel:#0f2a23; --gr-hover:#18202b; --gr-code:#070a0e; --gr-code-text:#dfe6ef;",
    "--gr-warn:#f0c674; --gr-warn-bg:#2d2311; --gr-bad:#ff8c8c; --gr-bad-bg:#2e1416; --gr-ok:#5be0bd; --gr-ok-bg:#0f2a23; }",
    "#gr-root * { box-sizing:border-box; }",
    "#gr-root, #gr-root td, #gr-root th, #gr-root label, #gr-root summary, #gr-root div, #gr-root span, #gr-root b, #gr-root h3 { color:inherit; }",
    "#gr-root .gr-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }",
    "#gr-root .gr-head h3 { margin:0; font-size:15px; font-weight:700; color:var(--gr-text) !important; }",
    "#gr-root .gr-clusterbox { display:flex; gap:14px; flex-wrap:wrap; align-items:center; padding:8px 10px; margin-bottom:10px;",
    "background:var(--gr-card) !important; border:1px solid var(--gr-border); border-left:4px solid var(--gr-accent); border-radius:4px; }",
    "#gr-root .gr-clusterbox .gr-k { color:var(--gr-muted) !important; font-size:10px; text-transform:uppercase; letter-spacing:.05em; display:block; }",
    "#gr-root .gr-clusterbox .gr-v { color:var(--gr-text) !important; font-size:13px; font-weight:600; }",
    "#gr-root .gr-muted, #gr-root .gr-why { color:var(--gr-muted) !important; }",
    "#gr-root .gr-why { font-size:11px; margin:2px 0 0 0; overflow-wrap:anywhere; word-break:break-word; }",
    "#gr-root code { background:var(--gr-code) !important; color:var(--gr-code-text) !important; padding:1px 5px; border-radius:3px; font-size:11px; word-break:break-all; border:0; }",
    "#gr-root table { width:100%; border-collapse:collapse; background:transparent !important; }",
    "#gr-root th { text-align:left; font-size:10px; text-transform:uppercase; color:var(--gr-muted) !important; padding:5px 8px; border-bottom:2px solid var(--gr-border); white-space:nowrap; background:transparent !important; }",
    "#gr-root td { padding:6px 8px; border-bottom:1px solid var(--gr-border); vertical-align:top; color:var(--gr-text) !important; background:transparent !important; }",
    "/* tree */",
    "#gr-root details.gr-node { background:var(--gr-card) !important; border:1px solid var(--gr-border); border-radius:4px; margin-bottom:10px; }",
    "#gr-root details.gr-node > summary { padding:8px 10px; font-weight:600; cursor:pointer; list-style:none; display:flex; gap:8px; align-items:center; color:var(--gr-text) !important; }",
    "#gr-root details > summary::-webkit-details-marker { display:none; }",
    "#gr-root details > summary::before { content:'\\25B8'; display:inline-block; width:12px; color:var(--gr-muted); transition:transform .12s; }",
    "#gr-root details[open] > summary::before { transform:rotate(90deg); }",
    "#gr-root details.gr-node[open] > summary { border-bottom:1px solid var(--gr-border); }",
    "#gr-root .gr-node-b { padding:8px 10px; }",
    "#gr-root details.gr-vol { border:1px solid var(--gr-border); border-radius:4px; margin:6px 0; background:var(--gr-card2) !important; }",
    "#gr-root details.gr-vol > summary { padding:7px 10px; cursor:pointer; list-style:none; display:flex; gap:10px; align-items:center; flex-wrap:wrap; color:var(--gr-text) !important; }",
    "#gr-root details.gr-vol > summary:hover { background:var(--gr-hover) !important; }",
    "#gr-root details.gr-vol.gr-sel { border-color:var(--gr-accent); box-shadow:0 0 0 1px var(--gr-accent) inset; }",
    "#gr-root details.gr-vol.gr-sel > summary { background:var(--gr-sel) !important; }",
    "#gr-root .gr-vol-b { padding:8px 10px 10px 32px; border-top:1px solid var(--gr-border); }",
    "#gr-root .gr-kv { display:grid; grid-template-columns:150px 1fr; gap:4px 12px; margin-bottom:8px; }",
    "#gr-root .gr-kv > div:nth-child(odd) { color:var(--gr-muted) !important; }",
    "#gr-root .gr-badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:10px; font-weight:700; white-space:nowrap; }",
    "#gr-root .gr-b-match { background:var(--gr-ok-bg) !important; color:var(--gr-ok) !important; }",
    "#gr-root .gr-b-foreign { background:var(--gr-warn-bg) !important; color:var(--gr-warn) !important; }",
    "#gr-root .gr-b-in-use, #gr-root .gr-b-running, #gr-root .gr-b-duplicate { background:var(--gr-bad-bg) !important; color:var(--gr-bad) !important; }",
    "#gr-root .gr-card { background:var(--gr-card) !important; border:1px solid var(--gr-border); border-radius:4px; margin-bottom:10px; }",
    "#gr-root .gr-card-h { padding:8px 10px; border-bottom:1px solid var(--gr-border); font-weight:600; display:flex; gap:8px; align-items:center; flex-wrap:wrap; color:var(--gr-text) !important; }",
    "#gr-root .gr-card-b { padding:10px; }",
    "#gr-root .gr-btn { padding:5px 12px !important; border:1px solid var(--gr-border) !important; background:var(--gr-card2) !important; color:var(--gr-text) !important; border-radius:3px !important; cursor:pointer; font-size:12px !important; line-height:1.4 !important; height:auto !important; min-height:0 !important; }",
    "#gr-root .gr-btn:hover:not([disabled]) { border-color:var(--gr-accent) !important; color:var(--gr-accent-dark) !important; }",
    "#gr-root .gr-btn[disabled] { opacity:.4; cursor:not-allowed; }",
    "#gr-root .gr-btn.gr-primary { background:var(--gr-accent) !important; border-color:var(--gr-accent) !important; color:#fff !important; }",
    "#gr-root .gr-btn.gr-danger { background:#c62828 !important; border-color:#c62828 !important; color:#fff !important; }",
    "#gr-root .gr-steps { display:flex; flex-wrap:wrap; gap:10px; margin:10px 0; }",
    "#gr-root .gr-steps > div { width:220px; }",
    "#gr-root .gr-msg { padding:7px 10px; border-radius:3px; margin:6px 0; }",
    "#gr-root .gr-msg.gr-err { background:var(--gr-bad-bg) !important; color:var(--gr-bad) !important; }",
    "#gr-root .gr-msg.gr-warn { background:var(--gr-warn-bg) !important; color:var(--gr-warn) !important; }",
    "#gr-root .gr-msg.gr-ok { background:var(--gr-ok-bg) !important; color:var(--gr-ok) !important; }",
    "#gr-root pre.gr-log { background:var(--gr-code) !important; color:var(--gr-code-text) !important; border:1px solid var(--gr-border); padding:8px; max-height:360px; overflow:auto; font-size:11px; line-height:1.45; white-space:pre-wrap; margin:6px 0 0 0; }",
    "#gr-root label { display:block; margin:6px 0 2px; font-weight:600; font-size:11px; color:var(--gr-text) !important; }",
    "#gr-root input[type=text], #gr-root select { width:100%; max-width:420px; padding:5px 7px; border:1px solid var(--gr-border) !important; border-radius:3px; background:var(--gr-card2) !important; color:var(--gr-text) !important; font-size:12px; height:auto; }",
    "#gr-root select option { background:var(--gr-card); color:var(--gr-text); }",
    "#gr-root .gr-check { display:flex; gap:8px; align-items:center; font-weight:400; cursor:pointer; }",
    "/* Morpheus restyles/hides native checkboxes: force a real, clickable one */",
    "#gr-root input[type=checkbox] { -webkit-appearance:checkbox !important; appearance:auto !important; opacity:1 !important; position:static !important;",
    "visibility:visible !important; display:inline-block !important; width:16px !important; height:16px !important; margin:0 !important;",
    "pointer-events:auto !important; accent-color:var(--gr-accent); cursor:pointer; flex:0 0 auto; }",
    "#gr-root .gr-confirmbox { margin-top:10px; padding:8px 10px; border:1px dashed var(--gr-border); border-radius:4px; max-width:640px; }",
    "#gr-root .gr-big { font-size:12px; font-weight:600; }",
    "#gr-root .gr-ok-text { color:var(--gr-ok) !important; font-weight:600; }",
    "#gr-root input::placeholder { color:var(--gr-muted) !important; opacity:.6; font-style:italic; }",
    "#gr-root .gr-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:4px 16px; }",
    "#gr-root .gr-bad-text { color:var(--gr-bad) !important; }",
    "#gr-root .gr-warn-text { color:var(--gr-warn) !important; }",
    "#gr-root .gr-spin { display:inline-block; width:12px; height:12px; border:2px solid var(--gr-border); border-top-color:var(--gr-accent); border-radius:50%; animation:grSpin .7s linear infinite; vertical-align:middle; }",
    "@keyframes grSpin { to { transform:rotate(360deg); } }",
    "#gr-root [hidden] { display:none !important; }",
    "#gr-root .gr-auto { display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400; }"
  ].join('\n');
  function injectStyle() {
    if (document.getElementById('gr-style')) return;
    var st = document.createElement('style');
    st.id = 'gr-style';
    if (window.grNonce) st.nonce = window.grNonce;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function names(list) { return (list || []).map(function (h) { return h.name; }).join(', '); }

  var csrfCache = null;
  function csrfFromMeta(doc) {
    var m = (doc || document).querySelector('meta[name="_csrf"]');
    if (!m || !m.content) return null;
    var h = (doc || document).querySelector('meta[name="_csrf_header"]');
    return { header: (h && h.content) || 'X-XSRF-TOKEN', token: m.content };
  }
  async function csrfFromCorePage() {
    var pages = ['/operations/dashboard', '/'];
    for (var i = 0; i < pages.length; i++) {
      try {
        var r = await fetch(pages[i], { credentials: 'same-origin', redirect: 'follow', headers: { Accept: 'text/html' } });
        if (!r.ok) continue;
        var t = csrfFromMeta(new DOMParser().parseFromString(await r.text(), 'text/html'));
        if (t) return t;
      } catch (e) { /* next */ }
    }
    return null;
  }
  async function getCsrf(force) {
    if (csrfCache && !force) return csrfCache;
    csrfCache = csrfFromMeta() || await csrfFromCorePage();
    return csrfCache;
  }
  async function post(path, params) {
    var body = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) body.append(k, String(params[k]));
    });
    async function send(csrf) {
      var headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-GR-Request': '1' };
      if (csrf) headers[csrf.header] = csrf.token;
      return fetch(API + path, { method: 'POST', credentials: 'same-origin', headers: headers, body: body.toString() });
    }
    var r;
    try {
      r = await send(await getCsrf(false));
      if (r.redirected && /invalid-csrf/.test(r.url)) r = await send(await getCsrf(true));
    } catch (e) {
      return { success: false, error: 'the appliance did not answer (' + (e && e.message ? e.message : 'network error') + ')' };
    }
    if (r.redirected && /invalid-csrf/.test(r.url)) return { success: false, error: 'rejected by the CSRF check (reload the page)' };
    try { return await r.json(); } catch (e) { return { success: false, error: 'HTTP ' + r.status }; }
  }
  function ago(ms) {
    var s = Math.round(ms / 1000);
    if (s < 90) return s + ' s ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }

  function isDark() {
    var sels = ['.main-header', 'header.navbar', 'nav.navbar', 'body'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (!el) continue;
      var rgb = (window.getComputedStyle(el).backgroundColor.match(/\d+/g) || []).map(Number);
      if (rgb.length >= 3 && !(rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0)) return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 < 80;
    }
    return false;
  }

  // ---------------------------------------------------------------- page
  window.grInit = function (root) {
    injectStyle();
    var S = { clusterId: root.dataset.clusterId, scan: null, wwid: null, hostId: null, status: null, timer: null, open: {}, form: {}, loading: false, stale: null };
    var body = root.querySelector('#gr-body');
    var statusEl = root.querySelector('#gr-status');
    // 'manual' (default): show the last scan and wait for Scan now. 'onOpen': scan when opened.
    var MODE = root.dataset.loadMode === 'onOpen' ? 'onOpen' : 'manual';
    if (isDark()) root.classList.add('gr-dark'); else root.classList.remove('gr-dark');
    if (window.grTimer) { clearTimeout(window.grTimer); window.grTimer = null; }   // SPA tab switches keep globals

    var scanBtn = root.querySelector('#gr-refresh');
    if (scanBtn) { scanBtn.hidden = false; scanBtn.onclick = function () { load('/scan'); }; }
    var rs = root.querySelector('#gr-rescan-storage');
    if (rs) {
      rs.hidden = false;
      rs.onclick = function () {
        if (!window.confirm('Ask every host in ' + root.dataset.clusterName + ' to rescan its SCSI and iSCSI buses for new LUNs, then scan again?\n\n' +
          'Use this after exporting a LUN that does not show up yet. Mounted volumes and multipath maps are not reloaded.')) return;
        load('/rescan');
      };
    }
    var autoWrap = root.querySelector('#gr-auto-wrap'), autoBox = root.querySelector('#gr-auto');
    if (autoWrap && autoBox && MODE === 'onOpen') {   // only meaningful when the plugin scans on open
      autoWrap.hidden = false;
      autoBox.checked = autoOff();
      autoBox.onchange = function () { setAutoOff(autoBox.checked); };
    }

    // The tab has just become visible for the first time on this page.
    if (MODE === 'onOpen' && !autoOff()) load('/scan', true);   // a scan under 30 s old will do
    else load('/last');                                         // memory only: nothing runs on a host

    function setStatus(text) { if (statusEl) statusEl.textContent = text; }
    function busy(on) { [scanBtn, rs].forEach(function (b) { if (b) b.disabled = on; }); }

    // path: '/last' (kept result, no host commands), '/scan' (cacheOk: accept one under 30 s old;
    // otherwise always fresh) or '/rescan' (storage rescan on every host, then a fresh scan).
    async function load(path, cacheOk) {
      path = path || '/scan';
      if (S.loading) return;
      S.loading = true; busy(true);
      var t0 = Date.now(), cn = esc(root.dataset.clusterName);
      var what = path === '/last' ? 'Reading the last scan of ' + cn + ' kept by the appliance...'
        : path === '/rescan' ? 'Asking each host in ' + cn + ' to look for new LUNs, then what it sees...'
        : 'Asking each host in ' + cn + ' what it sees...';
      body.innerHTML = '<span class="gr-spin"></span> <span class="gr-muted">' + what + ' <span id="gr-elapsed">0</span> s</span>';
      setStatus('Loading...');
      var tick = setInterval(function () {
        var e = body.querySelector('#gr-elapsed');
        if (e) e.textContent = String(Math.round((Date.now() - t0) / 1000)); else clearInterval(tick);
      }, 1000);
      var r = await post(path, { clusterId: S.clusterId, fresh: path === '/scan' ? (cacheOk ? '0' : '1') : undefined });
      clearInterval(tick); S.loading = false; busy(false);
      var secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!r.success) {
        setStatus('Not loaded');
        body.innerHTML = '<div class="gr-msg gr-err">' + esc(r.error || 'scan failed') + '</div>' +
          '<button type="button" class="gr-btn" id="gr-retry">Retry</button>';
        body.querySelector('#gr-retry').onclick = function () { load(path, cacheOk); };
        return;
      }
      if (r.none) {
        setStatus('Not loaded');
        body.innerHTML = '<div class="gr-muted">No scan of ' + cn + ' is kept yet. <b>Scan now</b> asks every host of the cluster what it sees ' +
          '(read-only commands through the Morpheus agent).</div>';
        return;
      }
      S.scan = r;
      var at = r.scannedAt ? new Date(r.scannedAt).toLocaleTimeString() : '';
      var took = r.scanMs != null ? (r.scanMs / 1000).toFixed(1) + ' s' : '';
      if (r.cached) {
        setStatus('Last scan ' + at + ' (' + ago(r.ageMs || 0) + (took ? ', took ' + took : '') + ')');
        // from /last the list can be any age: say so above it
        S.stale = path === '/last' ? at + ' (' + ago(r.ageMs || 0) + ')' : null;
      } else {
        setStatus('Loaded in ' + secs + ' s' + (at ? ' at ' + at : ''));
        S.stale = null;
      }
      var dlm = root.querySelector('#gr-dlm'), hc = root.querySelector('#gr-hostcount'), cr = root.querySelector('#gr-cred');
      if (dlm) dlm.innerHTML = r.cluster.dlmName ? '<code>' + esc(r.cluster.dlmName) + '</code>' : '<span class="gr-bad-text">not agreed</span>';
      if (hc) hc.textContent = String(r.cluster.hostCount);
      if (cr) {
        var c = r.apiCredential || {};
        cr.innerHTML = c.name ? esc(c.name) + ' <span class="gr-muted">(ID ' + esc(c.id) + (c.type ? ', ' + esc(c.type) : '') + ')</span>'
                              : '<span class="gr-bad-text">' + esc(c.error || 'not set') + '</span>';
      }
      renderScan();
      if (S.wwid && volume(S.wwid)) selectVolume(S.wwid, S.hostId);
    }

    function volume(wwid) { return (S.scan.volumes || []).find(function (v) { return v.wwid === wwid; }); }
    function usableHosts(v) {
      var ok = {};
      (S.scan.hosts || []).forEach(function (h) { if (!h.error && !h.excluded) ok[h.id] = true; });
      return (v.seenOn || []).filter(function (h) { return ok[h.id]; });
    }
    function isOpen(key, dflt) { return S.open.hasOwnProperty(key) ? S.open[key] : dflt; }

    // Tree: Hosts and GFS2 volumes are collapsible nodes; each volume is a collapsible node
    // whose body shows its details and a "Work on this volume" button.
    function renderScan() {
      var s = S.scan, h = '', hostsCount = (s.hosts || []).length;
      if (S.stale) h += '<div class="gr-msg gr-warn">This is the scan from ' + esc(S.stale) + ', not the current state. ' +
        'Every step checks the whole cluster again before it runs. <b>Scan now</b> refreshes this list.</div>';
      (s.warnings || []).forEach(function (w) { h += '<div class="gr-msg gr-warn">' + esc(w) + '</div>'; });

      var bad = (s.hosts || []).filter(function (x) { return x.error; }).length;
      h += '<details class="gr-node" data-key="hosts"' + (isOpen('hosts', bad > 0) ? ' open' : '') + '><summary>Hosts <span class="gr-muted">(' +
        hostsCount + (bad ? ', ' + bad + ' with problems' : ', all usable') + ')</span></summary><div class="gr-node-b"><table><thead><tr>' +
        '<th>Host</th><th>Agent</th><th>Script</th><th>DLM cluster</th><th>Problem</th></tr></thead><tbody>';
      (s.hosts || []).forEach(function (x) {
        h += '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.mode || '-') + '</td><td>' + esc(x.script || '-') + '</td><td><code>' + esc(x.hostCluster || '-') + '</code></td><td>' +
          (x.error ? '<span class="gr-bad-text">' + esc(x.error) + '</span>' : '<span class="gr-muted">none</span>') + '</td></tr>';
      });
      h += '</tbody></table></div></details>';

      var vols = s.volumes || [];
      h += '<details class="gr-node" data-key="volumes"' + (isOpen('volumes', true) ? ' open' : '') + '><summary>GFS2 volumes <span class="gr-muted">(' +
        vols.length + ' seen by this cluster\'s hosts)</span></summary><div class="gr-node-b">';
      if (!vols.length) h += '<span class="gr-muted">No GFS2 volume on a multipath device is visible to these hosts.</span>';
      vols.forEach(function (v) {
        var badge = { match: 'This cluster', foreign: 'From another cluster', 'in-use': 'In use', running: 'Step running', duplicate: 'Duplicate UUID' }[v.status] || v.status;
        var jWarn = v.journals < hostsCount ? ' <span class="gr-bad-text">(fewer than hosts)</span>' : '';
        var key = 'vol:' + v.wwid;
        h += '<details class="gr-vol' + (v.wwid === S.wwid ? ' gr-sel' : '') + '" data-key="' + esc(key) + '" data-wwid="' + esc(v.wwid) + '"' +
          (isOpen(key, v.wwid === S.wwid) ? ' open' : '') + '><summary>' +
          '<code>' + esc(v.device.replace('/dev/mapper/', '')) + '</code>' +
          '<span>' + esc(v.size) + '</span>' +
          '<span class="gr-badge gr-b-' + esc(v.status) + '">' + esc(badge) + '</span>' +
          '<code>' + esc(v.lockTable) + '</code>' +
          (v.datastore ? '<span class="gr-muted">datastore ' + esc(v.datastore.name) + '</span>' : '') +
          '</summary><div class="gr-vol-b"><div class="gr-kv">' +
          '<div>Device</div><div><code>' + esc(v.device) + '</code></div>' +
          '<div>Filesystem UUID</div><div>' + esc(v.uuid) +
            (v.dupUuid ? ' <span class="gr-bad-text">(also on ' + esc((v.dupUuidWith || []).join(', ')) + ')</span>' : '') + '</div>' +
          '<div>Lock table</div><div><code>' + esc(v.lockTable) + '</code>' +
            (v.lockTableClash ? ' <span class="gr-bad-text">(also on ' + esc((v.lockTableClashWith || []).join(', ')) + ')</span>' : '') + '</div>' +
          '<div>Owner cluster</div><div><code>' + esc(v.ownerCluster || '-') + '</code>' + (v.status === 'match' ? ' (this cluster)' : '') + '</div>' +
          '<div>Journals / hosts</div><div>' + esc(v.journals) + ' / ' + esc(hostsCount) + jWarn + '</div>' +
          '<div>Seen by</div><div>' + esc(names(v.seenOn)) + '</div>' +
          '<div>Mounted on</div><div>' + (v.mountedOn && v.mountedOn.length ? esc(names(v.mountedOn)) : '<span class="gr-muted">nowhere</span>') + '</div>' +
          '<div>Lockspace live on</div><div>' + (v.lockspaceOn && v.lockspaceOn.length ? esc(names(v.lockspaceOn)) : '<span class="gr-muted">nowhere</span>') + '</div>' +
          '<div>Morpheus datastore</div><div>' + (v.datastore ? esc(v.datastore.name) : '<span class="gr-muted">none</span>') + '</div>' +
          '</div><button type="button" class="gr-btn gr-primary" data-work="' + esc(v.wwid) + '">' +
          (v.wwid === S.wwid ? 'Selected' : 'Work on this volume') + '</button></div></details>';
      });
      h += '</div></details><div id="gr-panel"></div>';
      body.innerHTML = h;

      body.querySelectorAll('details[data-key]').forEach(function (d) {
        d.addEventListener('toggle', function () { S.open[d.dataset.key] = d.open; });
      });
      body.querySelectorAll('button[data-work]').forEach(function (b) {
        b.onclick = function (e) { e.preventDefault(); selectVolume(b.dataset.work, null); };
      });
    }

    function selectVolume(wwid, hostId) {
      var changed = S.wwid !== wwid;
      S.wwid = wwid;
      if (changed) S.form = {};
      S.open['vol:' + wwid] = true;
      if (changed) renderScan();
      var v = volume(wwid), hosts = usableHosts(v);
      if (!hosts.length) { panel('<div class="gr-msg gr-err">No usable host of this cluster can see this volume.</div>'); return; }
      var mountedIds = (v.mountedOn || []).map(function (m) { return String(m.id); });
      var pick = hostId && hosts.find(function (h) { return String(h.id) === String(hostId); });
      if (!pick) pick = hosts.find(function (h) { return mountedIds.indexOf(String(h.id)) < 0; }) || hosts[0];
      S.hostId = pick.id;
      loadStatus(false);
    }

    // ---------------------------------------------------------------- Recover VMs (0.1.24)
    // User-driven: scan the attached datastore once, assign each VM to a host (placement suggested
    // by free memory, never blocked: VMs are imported powered off), then define and import a batch
    // (1-3, plugin setting). Keeps each VM's UUID, MAC addresses and disk serials.
    S.rec = S.rec || {};
    function gib(mib) { return mib == null ? '?' : (Math.round(mib / 1024 * 10) / 10) + ' GiB'; }
    function capOf(R, id) { return (R.scan.hostCaps || []).find(function (h) { return String(h.id) === String(id); }); }
    function vmBy(R, n) { return (R.scan.vms || []).find(function (m) { return m.name === n; }); }
    function planned(R) {   // host id -> {memMiB, vcpus, n} for the selected VMs
      var out = {};
      Object.keys(R.sel).forEach(function (n) {
        if (!R.sel[n]) return; var m = vmBy(R, n), h = R.host[n]; if (!m || !h) return;
        var o = out[h] || (out[h] = { memMiB: 0, vcpus: 0, n: 0 }); o.memMiB += m.memoryMiB || 0; o.vcpus += m.vcpu || 0; o.n++;
      });
      return out;
    }
    function freeMiB(R, cap, plan) {   // stopped VMs count as reserved: they may be started
      if (!cap || !cap.ok) return -Infinity;
      return cap.memMiB - (cap.running ? cap.running.memMiB : 0) - (cap.stopped ? cap.stopped.memMiB : 0) - ((plan[cap.id] || {}).memMiB || 0);
    }
    function suggest(R, onlyUnassigned) {
      var names = Object.keys(R.sel).filter(function (n) { return R.sel[n] && (!onlyUnassigned || !R.host[n]); });
      if (!onlyUnassigned) names.forEach(function (n) { delete R.host[n]; });
      names.sort(function (x, y) { return ((vmBy(R, y) || {}).memoryMiB || 0) - ((vmBy(R, x) || {}).memoryMiB || 0); });
      names.forEach(function (n) {
        var plan = planned(R), best = null, bestFree = -Infinity;
        (R.scan.hostCaps || []).forEach(function (c) { var f = freeMiB(R, c, plan); if (f > bestFree) { bestFree = f; best = c; } });
        if (best) R.host[n] = best.id;
      });
    }
    function netIssues(R, m, hostId) {
      var cap = capOf(R, hostId); if (!cap || !cap.ok) return [];
      var nets = cap.networks || {}, out = [];
      (m.interfaces || []).forEach(function (i) {
        if (i.type !== 'network' || !i.network) return;
        if (!nets.hasOwnProperty(i.network)) out.push("network '" + i.network + "' missing on " + cap.name);
        else if (i.portgroup && nets[i.network].indexOf(i.portgroup) < 0) out.push("portgroup '" + i.portgroup + "' missing on " + cap.name);
      });
      return out;
    }

    function renderRecover(el, v) {
      var R = S.rec[v.wwid] || (S.rec[v.wwid] = { scan: null, sel: {}, host: {}, log: [], busy: false });
      var h = '<div class="gr-card"><div class="gr-card-h">Recover VMs <span class="gr-muted">on datastore ' + esc(v.datastore.name) + '</span></div><div class="gr-card-b">' +
        '<div class="gr-why">Finds VM definitions left on this datastore by the old cluster, rewrites their disk paths to this mount, ' +
        'and defines and imports them into this cluster, powered off. Nothing is changed until you choose VMs and click Define &amp; import.</div>' +
        '<button type="button" class="gr-btn gr-primary" id="gr-rec-scan"' + (R.busy ? ' disabled' : '') + '>' + (R.scan ? 'Scan again' : 'Scan for VMs') + '</button>';
      if (R.scan) {
        var vms = R.scan.vms || [], caps = R.scan.hostCaps || [], plan = planned(R);
        h += '<div class="gr-why">' + vms.length + ' definition(s) found at <code>' + esc(R.scan.mountpoint) + '</code>' +
          (R.scan.skipped ? '; ' + R.scan.skipped + ' unreadable file(s) skipped' : '') + '. Every host that mounts the datastore sees the same files.</div>';
        h += '<table><thead><tr><th></th><th>VM</th><th>UUID</th><th>CPU / RAM</th><th>Disks</th><th>Networks</th><th>Host</th><th>Status</th></tr></thead><tbody>';
        vms.forEach(function (m) {
          var st = m.known ? 'In Morpheus as ' + esc(m.known.name) : (m.definedHere ? 'Already defined' : (m.elsewhere && m.elsewhere.length ? 'Defined on ' + esc(m.elsewhere.join(', ')) : (m.problems.length ? 'Needs attention' : 'Orphaned, ready')));
          var disks = (m.disks || []).map(function (d) {
            var lab = d.status === 'ok' ? 'ok' : (d.status === 'old-path' ? 'repoint' : d.status);
            return esc(d.target || '?') + ': ' + (d.layers || []).length + ' layer(s), ' + esc(lab) + (d.outside ? ' (outside datastore)' : '');
          }).join('<br>');
          var nets = (m.interfaces || []).map(function (i) { return esc(i.network || i.bridge || i.type) + (i.portgroup ? '/' + esc(i.portgroup) : '') + ' <span class="gr-muted">' + esc(i.mac || '') + '</span>'; }).join('<br>');
          var hostCell = '';
          if (m.importable) {
            hostCell = '<select data-host="' + esc(m.name) + '"' + (R.sel[m.name] ? '' : ' disabled') + '><option value="">-</option>' +
              caps.map(function (c) { return '<option value="' + esc(c.id) + '"' + (String(c.id) === String(R.host[m.name]) ? ' selected' : '') + (c.ok ? '' : ' disabled') + '>' + esc(c.name) + '</option>'; }).join('') + '</select>';
            var ni = R.sel[m.name] && R.host[m.name] ? netIssues(R, m, R.host[m.name]) : [];
            if (ni.length) hostCell += '<div class="gr-warn-text" style="font-size:11px">' + ni.map(esc).join('<br>') + '</div>';
          }
          h += '<tr><td><input type="checkbox" data-rec="' + esc(m.name) + '"' + (m.importable ? '' : ' disabled') + (R.sel[m.name] ? ' checked' : '') + '></td>' +
            '<td>' + esc(m.name) + '<div class="gr-muted" style="font-size:10px">' + esc(m.xml) + '</div></td><td><code>' + esc(m.uuid) + '</code></td>' +
            '<td>' + esc(m.vcpu || '?') + ' / ' + gib(m.memoryMiB) + '</td><td>' + disks + '</td><td>' + nets + '</td><td>' + hostCell + '</td>' +
            '<td>' + st + (m.problems.length ? '<div class="gr-bad-text">' + m.problems.map(esc).join('<br>') + '</div>' : '') + '</td></tr>';
        });
        h += '</tbody></table>';
        // capacity summary after the planned placements
        h += '<div style="margin-top:10px;font-weight:600">Host capacity after this batch</div>' +
          '<table><thead><tr><th>Host</th><th>Memory</th><th>Running</th><th>Stopped</th><th>This batch</th><th>If all started</th><th>vCPU (threads)</th></tr></thead><tbody>';
        var anyOver = false;
        caps.forEach(function (c) {
          if (!c.ok) { h += '<tr><td>' + esc(c.name) + '</td><td colspan="6" class="gr-bad-text">capacity unavailable: ' + esc(c.error || '?') + '</td></tr>'; return; }
          var p = plan[c.id] || { memMiB: 0, vcpus: 0, n: 0 };
          var all = c.running.memMiB + c.stopped.memMiB + p.memMiB, pct = c.memMiB ? Math.round(all / c.memMiB * 100) : 0;
          var cls = pct > 100 ? 'gr-bad-text' : (pct > 90 ? 'gr-warn-text' : '');
          if (pct > 100 && p.n) anyOver = true;
          var vc = c.running.vcpus + c.stopped.vcpus + p.vcpus;
          h += '<tr><td>' + esc(c.name) + '</td><td>' + gib(c.memMiB) + '</td><td>' + gib(c.running.memMiB) + ' (' + c.running.count + ')</td><td>' + gib(c.stopped.memMiB) + ' (' + c.stopped.count + ')</td>' +
            '<td>' + (p.n ? gib(p.memMiB) + ' (' + p.n + ')' : '-') + '</td><td class="' + cls + '">' + gib(all) + ' = ' + pct + '%</td><td>' + vc + ' / ' + esc(c.cpus) + '</td></tr>';
        });
        h += '</tbody></table>';
        if (anyOver) h += '<div class="gr-msg gr-warn">A host would be over its memory if every VM on it were running. The VMs are imported powered off, so this is allowed: move or resize them before starting.</div>';
        h += '<div class="gr-grid" style="margin-top:8px"><div><label for="gr-rec-group">Morpheus group</label><select id="gr-rec-group">' +
          (R.scan.groups || []).map(function (g) { return '<option value="' + esc(g.id) + '"' + (String(g.id) === String(R.groupId) ? ' selected' : '') + '>' + esc(g.name) + '</option>'; }).join('') +
          '</select></div><div><label for="gr-rec-env">Environment code (optional)</label><input type="text" id="gr-rec-env" value="' + esc(R.env || '') + '" placeholder="e.g. production"></div></div>';
        var sel = Object.keys(R.sel).filter(function (k) { return R.sel[k]; }), unassigned = sel.filter(function (n) { return !R.host[n]; });
        h += '<div style="margin-top:8px"><button type="button" class="gr-btn" id="gr-rec-suggest"' + (R.busy || !sel.length ? ' disabled' : '') + '>Suggest placement</button> ' +
          '<button type="button" class="gr-btn gr-danger" id="gr-rec-go"' + (R.busy || !sel.length || unassigned.length ? ' disabled' : '') + '>Define &amp; import ' + sel.length + ' selected</button> ' +
          '<span class="gr-why">At most ' + esc(R.scan.batchSize) + ' per batch (plugin setting).' + (unassigned.length ? ' Pick a host for every selected VM.' : '') +
          (R.scan.apiConfigured ? '' : ' <span class="gr-bad-text">Set the API token credential in the plugin settings first.</span>') + '</span></div>';
      }
      if (R.log.length) h += '<pre class="gr-log">' + R.log.map(esc).join('\n') + '</pre>';
      h += '</div></div>';
      el.innerHTML = h;
      el.querySelector('#gr-rec-scan').onclick = async function () {
        R.busy = true; R.log = ['scanning the datastore and every host\'s capacity ...']; renderRecover(el, v);
        var res = await post('/vmScan', { clusterId: S.clusterId, wwid: v.wwid });
        R.busy = false;
        if (!res.success) { R.log = ['scan failed: ' + (res.error || '?')]; R.scan = null; }
        else { R.scan = res; R.sel = {}; R.host = {}; R.log = []; if (!R.groupId && res.groups && res.groups[0]) R.groupId = res.groups[0].id; }
        renderRecover(el, v);
      };
      el.querySelectorAll('input[data-rec]').forEach(function (cb) {
        cb.onchange = function () {
          var n = Object.keys(R.sel).filter(function (k) { return R.sel[k]; }).length;
          if (cb.checked && n >= R.scan.batchSize) { cb.checked = false; alert('At most ' + R.scan.batchSize + ' VM(s) per batch.'); return; }
          R.sel[cb.dataset.rec] = cb.checked;
          if (cb.checked) suggest(R, true); else delete R.host[cb.dataset.rec];
          renderRecover(el, v);
        };
      });
      el.querySelectorAll('select[data-host]').forEach(function (sl) { sl.onchange = function () { R.host[sl.dataset.host] = sl.value || undefined; renderRecover(el, v); }; });
      var sg = el.querySelector('#gr-rec-suggest'); if (sg) sg.onclick = function () { suggest(R, false); renderRecover(el, v); };
      var g = el.querySelector('#gr-rec-group'); if (g) g.onchange = function () { R.groupId = g.value; };
      var e = el.querySelector('#gr-rec-env'); if (e) e.oninput = function () { R.env = e.value.trim(); };
      var go = el.querySelector('#gr-rec-go');
      if (go) go.onclick = function () { recoverBatch(el, v, R); };
    }

    async function recoverBatch(el, v, R) {
      function cur() { return root.querySelector('#gr-recover') || el; }
      var picks = (R.scan.vms || []).filter(function (m) { return R.sel[m.name] && R.host[m.name]; });
      if (!picks.length) return;
      var gname = ((R.scan.groups || []).find(function (g) { return String(g.id) === String(R.groupId); }) || {}).name || R.groupId;
      if (!confirm('Define and import into Morpheus (group ' + gname + '), powered off:\n\n' +
        picks.map(function (m) { return '- ' + m.name + '  ->  ' + (capOf(R, R.host[m.name]) || {}).name + '  (UUID ' + m.uuid + ')'; }).join('\n') +
        '\n\nDisk paths are rewritten to this datastore; backing paths that still name the old mount are repointed (header only).')) return;
      R.busy = true; R.log = []; renderRecover(cur(), v);
      function say(t) { R.log.push(new Date().toLocaleTimeString() + '  ' + t); renderRecover(cur(), v); }
      var defined = [];
      for (var i = 0; i < picks.length; i++) {
        var m = picks[i], hid = R.host[m.name], hn = (capOf(R, hid) || {}).name;
        say('define ' + m.name + ' on ' + hn + ' ...');
        var d = await post('/vmDefine', { clusterId: S.clusterId, wwid: v.wwid, hostId: hid, xml: m.xml, name: m.name });
        if (d.success) { say('  defined (' + (d.state || 'shut off') + ')' + (d.rebased && d.rebased.length ? ', ' + d.rebased.length + ' backing path(s) repointed' : '')); defined.push(m.name); }
        else say('  NOT defined: ' + (d.error || '?'));
      }
      if (!defined.length) { R.busy = false; say('nothing to import'); return; }
      say('importing into Morpheus: ' + defined.join(', '));
      var pending = defined.slice(), first = true, tries = 0;
      while (pending.length && tries < 36) {
        var res = await post('/vmImport', { clusterId: S.clusterId, groupId: R.groupId, environment: R.env || '', names: pending.join(','), refresh: first ? '1' : '0' });
        first = false; tries++;
        if (!res.success) { say('import error: ' + (res.error || '?')); break; }
        Object.keys(res.vms || {}).forEach(function (n) {
          var x = res.vms[n];
          if (x.state === 'managed') { say(n + ': managed instance ' + x.instanceId + (x.warning ? ' (' + x.warning + ')' : '')); pending = pending.filter(function (q) { return q !== n; }); }
          else if (x.state === 'error') { say(n + ': ' + x.error); pending = pending.filter(function (q) { return q !== n; }); }
          else if (x.state === 'converting') say(n + ': converting to managed ...');
        });
        if (pending.length) await new Promise(function (ok) { setTimeout(ok, 10000); });
      }
      if (pending.length) say('still waiting for Morpheus to discover: ' + pending.join(', ') + ' (run a cluster refresh, then Scan and import again)');
      R.busy = false; R.sel = {}; R.host = {}; say('done; rescanning');
      var res2 = await post('/vmScan', { clusterId: S.clusterId, wwid: v.wwid });
      if (res2.success) R.scan = res2;
      renderRecover(cur(), v);
    }

    function panel(html) { var p = body.querySelector('#gr-panel'); if (p) p.innerHTML = html; }

    async function loadStatus(full) {
      if (!S.wwid || !S.hostId) return;
      var r = await post('/status', { clusterId: S.clusterId, hostId: S.hostId, wwid: S.wwid, full: full ? '1' : '0' });
      if (!r.success) { panel('<div class="gr-msg gr-err">' + esc(r.error || 'status failed') + '</div>'); return; }
      S.status = r;
      if (full) { download(r.log || '', 'gfs2-rescue-' + S.wwid + '-log.md'); }
      renderPanel();
      if (window.grTimer) clearTimeout(window.grTimer);
      if (r.active) window.grTimer = setTimeout(function () { loadStatus(false); }, 5000);
      else if (S.wasActive) { S.wasActive = false; load(); return; }   // step finished: refresh the table
      S.wasActive = !!r.active;
    }

    function download(text, name) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
    }

    function renderPanel() {
      var r = S.status, v = r.volume, st = r.state || {};
      var hosts = usableHosts(v);
      var h = '<div class="gr-card"><div class="gr-card-h">Work on <code>' + esc(v.device) + '</code> <span class="gr-muted">in cluster ' + esc(root.dataset.clusterName) + '</span>' +
        (r.active ? ' <span class="gr-spin"></span> <span class="gr-muted">step running, refreshing every 5 s</span>' : '') + '</div><div class="gr-card-b">';

      h += '<div class="gr-grid">' +
        '<div><label>Run on host</label><select id="gr-host">' + hosts.map(function (x) {
          return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(S.hostId) ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>' +
        '<div><label>Current lock table</label><code>' + esc(v.lockTable) + '</code></div>' +
        '<div><label>This cluster</label>' + esc(root.dataset.clusterName) + ' &middot; DLM <code>' + esc(r.clusterDlmName || 'unknown') + '</code></div>' +
        '<div><label>Run folder</label>' + (r.run ? '<code>' + esc(r.run) + '</code>' : '<span class="gr-muted">none yet</span>') + '</div>' +
        '</div>';

      if (r.adoptedFrom)
        h += '<div class="gr-msg gr-warn">This LUN\'s identity (WWID) changed, but the filesystem is the same one: continuing the run in <code>' +
          esc(r.adoptedFrom) + '</code>. The change is noted in its log.</div>';
      if (st.step) {
        var cls = (st.result === 'ok' || st.result === 'clean') ? 'gr-ok' : (st.result === 'error' || st.result === 'tier3' || st.result === 'blocked') ? 'gr-err' : 'gr-warn';
        h += '<div class="gr-msg ' + cls + '"><b>Last step:</b> ' + esc(STEP_LABEL[st.step] || st.step) + ' &rarr; <b>' + esc(st.result) + '</b>' +
          (st.detail ? ' &middot; ' + esc(st.detail) : '') + (st.time ? ' <span class="gr-muted">(' + esc(st.time) + ')</span>' : '') +
          (TIER_TEXT[st.result] && st.step === 'check' ? '<div>' + esc(TIER_TEXT[st.result]) + '</div>' : '') + '</div>';
        if (st.step === 'reuuid' && st.result === 'ok')
          h += '<div class="gr-msg gr-ok">Next: <b>Collect</b> and <b>Check</b> this copy, then <b>Adopt</b> it under its own datastore name.</div>';
        if (st.step === 'adopt' && st.result === 'ok' && !v.datastore)
          h += '<div class="gr-msg gr-ok">Next: <b>Attach</b> adds it as a Morpheus datastore through the API. Reformatting is never offered or sent. When it shows as mounted, run Verify.</div>';
      }

      // steps
      h += '<div class="gr-steps">';
      (v.dupUuid ? ['reuuid'] : []).concat(['collect', 'check', 'repair', 'adopt', 'attach', 'verify']).forEach(function (s) {
        var ok = (r.allowed || []).indexOf(s) >= 0;
        var cls = s === 'repair' || s === 'adopt' || s === 'reuuid' ? 'gr-btn gr-danger' : (s === 'collect' || s === 'attach' ? 'gr-btn gr-primary' : 'gr-btn');
        h += '<div><button type="button" class="' + cls + '" data-step="' + s + '"' + (ok ? '' : ' disabled') + '>' + STEP_LABEL[s] + '</button>' +
          '<div class="gr-why" style="max-width:260px">' + esc(ok ? STEP_HELP[s] : ((r.reasons || {})[s] || '')) + '</div></div>';
      });
      h += '</div>';

      // inputs for the writing steps
      var allowedW = (r.allowed || []).filter(function (x) { return x === 'repair' || x === 'adopt' || x === 'reuuid'; });
      var writing = allowedW.length > 0;
      var suggested = (v.fsName || '').replace(/_/g, '-');
      if ((r.allowed || []).indexOf('adopt') >= 0) {
        // a copy that shares its lock table with another LUN needs a different name
        var dn = S.form.dsname !== undefined ? S.form.dsname : (v.lockTableClash ? (suggested + '-copy').slice(0, 30) : suggested);
        if (v.lockTableClash)
          h += '<div class="gr-msg gr-warn">' + esc((v.lockTableClashWith || []).join(', ')) + ' already uses lock table <code>' + esc(v.lockTable) +
            '</code>. Adopt this LUN under a different datastore name.</div>';
        h += '<label for="gr-dsname">Datastore name</label><input type="text" id="gr-dsname" data-f="dsname" maxlength="30" value="' + esc(dn) + '">' +
          '<div class="gr-why">This is the name the datastore gets in Morpheus. Adopt writes the lock table from it: ' +
          '<code id="gr-lt-preview">' + esc((r.clusterDlmName || '?') + ':' + dn.replace(/-/g, '_')) + '</code> (Morpheus stores - as _). ' +
          'Attach then uses the same name.</div>';
      }
      if ((r.allowed || []).indexOf('attach') >= 0) {
        h += '<label>Datastore name</label><div><code>' + esc(suggested) + '</code></div>' +
          '<div class="gr-why">Set by the lock table <code>' + esc(v.lockTable) + '</code> (_ becomes -). To use another name, Adopt again with it first.</div>';
      }
      if (r.needsAllowUnreadable)
        h += '<label class="gr-check" for="gr-allow"><input type="checkbox" id="gr-allow" data-f="allow"' + (S.form.allow ? ' checked' : '') + '> Accept the unreadable entries the repair left (listed in the log) and adopt anyway</label>';
      if (writing) {
        var typedOk = (S.form.confirm || '').trim() === v.wwid;
        var stepNames = allowedW.map(function (x) { return STEP_LABEL[x]; }).join(' or ');
        var snapText = v.dupUuid
          ? 'This LUN is the copy, not the volume in use, and the original is still safe on the array'
          : 'An array snapshot of this LUN exists, and no host of the old cluster can reach it';
        h += '<div class="gr-confirmbox">' +
          '<label class="gr-check gr-big" for="gr-snap"><input type="checkbox" id="gr-snap" data-f="snap"' + (S.form.snap ? ' checked' : '') + '>' +
          '<span>' + esc(snapText) + '</span></label>' +
          '<label for="gr-confirm">To confirm ' + esc(stepNames) + ', type this WWID: <code>' + esc(v.wwid) + '</code></label>' +
          '<input type="text" id="gr-confirm" data-f="confirm" autocomplete="off" spellcheck="false" value="' + esc(S.form.confirm || '') + '">' +
          '<div class="gr-why" id="gr-confirm-state">' + (typedOk ? '<span class="gr-ok-text">WWID matches.</span>' : 'Not typed yet (the box starts empty).') + '</div>' +
          '</div>';
      }

      h += '<div style="margin-top:10px;display:flex;gap:8px;align-items:center"><b>Log</b>' +
        '<button type="button" class="gr-btn" id="gr-full">Download full log</button>' +
        '<button type="button" class="gr-btn" id="gr-reload">Refresh</button></div>' +
        '<pre class="gr-log">' + esc(r.log || 'No run yet.') + '</pre></div></div>';

      panel(h);
      var p = body.querySelector('#gr-panel');
      p.querySelector('#gr-host').onchange = function (e) { S.hostId = e.target.value; loadStatus(false); };
      p.querySelector('#gr-full').onclick = function () { loadStatus(true); };
      p.querySelector('#gr-reload').onclick = function () { loadStatus(false); };
      p.querySelectorAll('button[data-step]').forEach(function (b) { b.onclick = function () { start(b.dataset.step); }; });
      if (r.volume && r.volume.datastore && (r.volume.mountedOn || []).length) {
        var rc = document.createElement('div'); rc.id = 'gr-recover'; p.appendChild(rc); renderRecover(rc, r.volume);
      }
      p.querySelectorAll('[data-f]').forEach(function (el) {
        var save = function () {
          S.form[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
          if (el.dataset.f === 'dsname') {
            var pv = p.querySelector('#gr-lt-preview');
            if (pv) pv.textContent = (r.clusterDlmName || '?') + ':' + el.value.trim().replace(/-/g, '_');
          }
          if (el.dataset.f === 'confirm') {
            var st = p.querySelector('#gr-confirm-state');
            if (st) st.innerHTML = el.value.trim() === r.volume.wwid ? '<span class="gr-ok-text">WWID matches.</span>'
                                                                   : (el.value.trim() ? '<span class="gr-bad-text">Does not match yet.</span>' : 'Not typed yet (the box starts empty).');
          }
        };
        el.addEventListener('input', save); el.addEventListener('change', save);
      });
    }

    async function start(step) {
      var p = body.querySelector('#gr-panel'), v = S.status.volume;
      var params = { clusterId: S.clusterId, hostId: S.hostId, wwid: S.wwid, step: step };
      var hostName = (usableHosts(v).find(function (h) { return String(h.id) === String(S.hostId); }) || {}).name;
      if (step === 'repair' || step === 'adopt' || step === 'reuuid') {
        var snap = p.querySelector('#gr-snap'), conf = p.querySelector('#gr-confirm');
        params.snapshot = snap && snap.checked ? 'on' : 'off';
        params.confirm = conf ? conf.value.trim() : '';
        var missing = [];
        if (params.snapshot !== 'on') missing.push(v.dupUuid ? 'tick "This LUN is the copy..."' : 'tick "An array snapshot of this LUN exists..."');
        if (params.confirm !== S.wwid) missing.push(params.confirm ? 'the typed WWID does not match ' + S.wwid : 'type the WWID ' + S.wwid + ' into the confirm box');
        if (missing.length) { alert('Before ' + STEP_LABEL[step] + ':\n- ' + missing.join('\n- ')); return; }
        if (step === 'adopt') {
          params.datastoreName = ((p.querySelector('#gr-dsname') || {}).value || '').trim();
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/.test(params.datastoreName)) { alert('Datastore name: 1-30 letters, digits, - or _, starting with a letter or digit.'); return; }
          params.lockTable = (S.status.clusterDlmName || '') + ':' + params.datastoreName.replace(/-/g, '_');
          var allow = p.querySelector('#gr-allow');
          if (allow) params.allowUnreadable = allow.checked ? 'on' : 'off';
        }
      }
      if (step === 'attach') params.datastoreName = (v.fsName || '').replace(/_/g, '-');
      var msg = STEP_LABEL[step] + ' ' + v.device + (step === 'attach' ? ' to cluster ' + root.dataset.clusterName : ' on ' + hostName) + '?\n\n' + STEP_HELP[step] +
        (step === 'adopt' ? '\n\nDatastore name: ' + params.datastoreName + '\nNew lock table: ' + params.lockTable : '') +
        (step === 'attach' ? '\n\nDatastore name: ' + params.datastoreName : '');
      if (!window.confirm(msg)) return;
      var r = await post('/start', params);
      if (!r.success) { alert(r.error || 'could not start'); return; }
      if (step === 'repair' || step === 'adopt' || step === 'reuuid') { S.form.snap = false; S.form.confirm = ''; S.form.allow = false; }
      if (step === 'attach') { waitForDatastore(0); return; }
      S.wasActive = true;
      loadStatus(false);
    }

    // Attach runs inside Morpheus, not on a host: rescan until the datastore shows up and mounts.
    async function waitForDatastore(n) {
      panel('<div class="gr-msg gr-ok"><span class="gr-spin"></span> Datastore requested. Waiting for Morpheus to create and mount it (check ' + (n + 1) + ' of 36)...</div>');
      var r = await post('/scan', { clusterId: S.clusterId, fresh: '1' });
      if (r.success) {
        S.scan = r; S.stale = null;
        var v = volume(S.wwid);
        if (v && v.datastore && (v.mountedOn || []).length) { renderScan(); selectVolume(S.wwid, S.hostId); return; }
      }
      if (n >= 35) { load(); return; }
      window.grTimer = setTimeout(function () { waitForDatastore(n + 1); }, 10000);
    }
  };

  // No watcher here: the inline page watcher (hbs/gfs2RescueLoader) finds each GFS2 Storage tab,
  // waits until it is visible, loads this file and calls window.grInit(root) once per tab element.
})();
