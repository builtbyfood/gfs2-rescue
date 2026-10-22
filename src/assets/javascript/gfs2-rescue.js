/* GFS2 Rescue - GFS2 Storage cluster tab.
 * All calls are POSTs to /plugin/gfs2Rescue/* with core's CSRF token and the X-GR-Request header
 * (the vm-folders approach: core rejects plugin POSTs without its Spring Security token).
 * Every value from the server is HTML-escaped before it is placed in the page. */
(function () {
  'use strict';
  var API = '/plugin/gfs2Rescue';
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
    var r = await send(await getCsrf(false));
    if (r.redirected && /invalid-csrf/.test(r.url)) r = await send(await getCsrf(true));
    if (r.redirected && /invalid-csrf/.test(r.url)) return { success: false, error: 'rejected by the CSRF check (reload the page)' };
    try { return await r.json(); } catch (e) { return { success: false, error: 'HTTP ' + r.status }; }
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
    var S = { clusterId: root.dataset.clusterId, scan: null, wwid: null, hostId: null, status: null, timer: null, open: {}, form: {} };
    var body = root.querySelector('#gr-body');
    if (isDark()) root.classList.add('gr-dark'); else root.classList.remove('gr-dark');
    if (window.grTimer) { clearTimeout(window.grTimer); window.grTimer = null; }   // SPA tab switches keep globals

    root.querySelector('#gr-refresh').onclick = function () { load(); };
    var rs = root.querySelector('#gr-rescan-storage');
    if (rs) rs.onclick = function () {
      if (!window.confirm('Ask every host in ' + root.dataset.clusterName + ' to rescan its SCSI and iSCSI buses for new LUNs, then scan again?\n\n' +
        'Use this after exporting a LUN that does not show up yet. Mounted volumes and multipath maps are not reloaded.')) return;
      load('/rescan');
    };
    load();

    async function load(path) {
      body.innerHTML = '<span class="gr-spin"></span> <span class="gr-muted">' + (path === '/rescan'
        ? 'Asking each host in ' + esc(root.dataset.clusterName) + ' to look for new LUNs, then what it sees...'
        : 'Asking each host in ' + esc(root.dataset.clusterName) + ' what it sees...') + '</span>';
      var r = await post(path || '/scan', { clusterId: S.clusterId });
      if (!r.success) { body.innerHTML = '<div class="gr-msg gr-err">' + esc(r.error || 'scan failed') + '</div>'; return; }
      S.scan = r;
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
      var r = await post('/scan', { clusterId: S.clusterId });
      if (r.success) {
        S.scan = r;
        var v = volume(S.wwid);
        if (v && v.datastore && (v.mountedOn || []).length) { renderScan(); selectVolume(S.wwid, S.hostId); return; }
      }
      if (n >= 35) { load(); return; }
      window.grTimer = setTimeout(function () { waitForDatastore(n + 1); }, 10000);
    }
  };

  // Loaded on every page by the plugin's global component (tab HTML loses its <script> tags).
  // Bind each GFS2 Storage tab once, whenever it appears; tab switches re-render it.
  function bindAll() {
    document.querySelectorAll('#gr-root').forEach(function (r) {
      if (r.dataset.grBound) return;
      r.dataset.grBound = '1';
      window.grInit(r);
    });
  }
  function watch() {
    if (window.grObserver) return;
    window.grObserver = new MutationObserver(bindAll);
    window.grObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    bindAll();
  }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
