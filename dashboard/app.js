// Token Radar — the dashboard. Renders window.RADAR (written by main.ts from
// the sealed snapshot): the ranked board, the live-token reference, and one
// detail view per protocol. No network, no fetch: the data is already here.

(function () {
  'use strict';
  var D = window.RADAR;
  if (!D || !Array.isArray(D.rows)) {
    document.getElementById('board').innerHTML = '<p class="empty">No radar data. Run main.ts first.</p>';
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var rowsEl = $('rows'), liveRowsEl = $('live-rows'), countEl = $('count');

  function isWatch(r) { return r.on_watchlist === true; }

  /* ---------------------------------------------------------- formatting */

  function money(n) {
    if (n === null || n === undefined) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------- header stats */

  function stat(label, value) {
    return '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';
  }
  $('stats').innerHTML =
    stat('Watchlist', D.watchlist_size) +
    stat('Board rows', D.board_size) +
    stat('Early finds', D.early_size) +
    stat('Live tokens', D.live_size);
  $('model-ver').textContent = D.model_version;
  $('asof').textContent = D.as_of;
  $('src').textContent = 'Source: ' + D.source + ' · floor $' + (D.floor_usd / 1e6).toLocaleString('en-US') + 'M TVL.';
  $('board-note').textContent =
    'Rank 1 is the most valuable launch on the board. Implied value = TVL × peer multiple × growth × maturity. ' +
    'A protocol is pre-token because its record shows no token, never because it has none.';

  /* ---------------------------------------------------------- filter options */

  function unique(values) {
    var seen = {}, out = [];
    values.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }
  var categories = unique(D.rows.map(function (r) { return r.category; }));
  var chains = unique(D.rows.reduce(function (acc, r) { return acc.concat(r.chains); }, []));
  $('cat').innerHTML = '<option value="">All categories</option>' +
    categories.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  $('chain').innerHTML = '<option value="">All chains</option>' +
    chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  /* ---------------------------------------------------------- board state */

  var state = { q: '', cat: '', chain: '', status: '', sort: 'value' };
  var maxValue = Math.max.apply(null, D.rows.map(function (r) { return r.implied_value_usd; }));

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = D.rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.status === 'watchlist' && !isWatch(r)) return false;
      if (state.status === 'early' && isWatch(r)) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var by = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
      name: function (a, b) { return a.name.localeCompare(b.name); }
    }[state.sort];
    list.sort(function (a, b) { return by(a, b) || (a.slug < b.slug ? -1 : 1); });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    countEl.textContent = list.length + ' of ' + D.rows.length + ' protocols' +
      (state.status === 'watchlist' ? ' · watchlist only' : state.status === 'early' ? ' · early finds only' : '');
    if (list.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="8" class="empty">Nothing matches these filters.</td></tr>';
      return;
    }
    rowsEl.innerHTML = list.map(function (r) {
      var chg = r.change_7d;
      var chgCls = chg === null ? '' : chg >= 0 ? 'up' : 'down';
      var bar = Math.max(2, Math.round((r.implied_value_usd / maxValue) * 100));
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '<small>' + esc(r.slug) + '</small></span></td>' +
        '<td><span class="tag' + (isWatch(r) ? ' watch' : '') + '">' + esc(r.category || '—') + '</span></td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + chgCls + '">' + pct(chg) + '</td>' +
        '<td class="num"><span class="val">' + money(r.implied_value_usd) + '</span><span class="bar"><i style="width:' + bar + '%"></i></span></td>' +
        '<td class="num">' + (isWatch(r) ? '<span class="tag watch">Watchlist</span>' : '') + '</td>' +
        '</tr>';
    }).join('');
  }

  rowsEl.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });

  /* ---------------------------------------------------------- detail drawer */

  var drawer = $('drawer'), detailEl = $('detail'), selected = null;

  function stepParts(step) {
    var at = step.lastIndexOf(' Cost: ');
    if (at < 0) return { text: step, meta: '' };
    return { text: step.slice(0, at), meta: step.slice(at + 1) };
  }

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    if (!r) return;
    selected = slug;
    var chg = r.change_7d;
    var base = r.tvl_usd * r.peer_multiple;
    var steps = (r.farm_steps || []).map(function (s) {
      var p = stepParts(s);
      return '<li>' + esc(p.text) + (p.meta ? '<span class="meta">' + esc(p.meta) + '</span>' : '') + '</li>';
    }).join('');
    detailEl.innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="slug">Rank #' + r.rank + ' · ' + esc(r.slug) + ' · ' + esc(r.category || 'no category') + '</p>' +
      '<div class="badges">' +
        '<span class="tag watch">' + (isWatch(r) ? 'On the watchlist' : 'Early find') + '</span>' +
        '<span class="tag">Pre-token</span>' +
        '<span class="tag">' + esc(r.chains[0] || 'multi-chain') + '</span>' +
      '</div>' +
      '<dl class="metrics">' +
        '<div class="metric"><dt>Implied value</dt><dd>' + money(r.implied_value_usd) + '<small>if it launched at peer prices</small></dd></div>' +
        '<div class="metric"><dt>TVL</dt><dd>' + money(r.tvl_usd) + '<small>' + moneyFull(r.tvl_usd) + '</small></dd></div>' +
        '<div class="metric"><dt>7-day change</dt><dd class="' + (chg === null ? '' : chg >= 0 ? 'up' : 'down') + '">' + pct(chg) + '<small>TVL, last 7 days</small></dd></div>' +
        '<div class="metric"><dt>Running, no token</dt><dd>' + ageText(r.age_days) + '<small>listed ' + esc(r.listed_at || 'unknown') + '</small></dd></div>' +
      '</dl>' +
      '<h3>How the value is built</h3>' +
      '<ul class="breakdown">' +
        '<li><span class="k">TVL &times; peer multiple ' + r.peer_multiple.toFixed(3) + '×</span><span class="v">' + money(base) + '</span></li>' +
        '<li><span class="k">Growth multiplier (' + pct(chg) + ')</span><span class="v">' + r.growth_multiplier.toFixed(3) + '×</span></li>' +
        '<li><span class="k">Maturity multiplier (' + ageText(r.age_days) + ')</span><span class="v">' + r.maturity_multiplier.toFixed(3) + '×</span></li>' +
        '<li class="total"><span class="k">Implied value</span><span class="v">' + money(r.implied_value_usd) + '</span></li>' +
      '</ul>' +
      '<p class="caveat">Peer multiple: the median market-cap / TVL of ' +
        (r.peer_count >= 3 ? r.peer_count + ' live ' + esc(r.category || '') + ' protocols' : 'the whole live market') +
        '. Same formula scores every row; no name is special-cased.</p>' +
      '<h3>Farm plan — 6 steps</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="caveat">A plan is a starting point, not advice. Confirm every step on the protocol\u2019s own pages before you move funds.</p>';
    drawer.hidden = false;
    document.querySelectorAll('#rows tr').forEach(function (tr) {
      tr.classList.toggle('sel', tr.getAttribute('data-slug') === slug);
    });
    location.hash = 'detail=' + slug;
  }

  function closeDetail() {
    drawer.hidden = true;
    selected = null;
    document.querySelectorAll('#rows tr').forEach(function (tr) { tr.classList.remove('sel'); });
    if (location.hash.indexOf('detail=') === 1) history.replaceState(null, '', location.pathname + location.search);
  }
  $('drawer-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  /* ---------------------------------------------------------- live view */

  liveRowsEl.innerHTML = D.live.map(function (p) {
    var chg = p.change_7d;
    return '<tr>' +
      '<td><span class="name">' + esc(p.name) + '<small>' + esc(p.slug) + '</small></span></td>' +
      '<td><span class="tag">' + esc(p.category || '—') + '</span></td>' +
      '<td class="chains">' + esc(p.chains.slice(0, 3).join(', ')) + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td>' +
      '<td class="num">' + money(p.mcap_usd) + '</td>' +
      '<td class="num"><b>' + (p.mcap_per_tvl === null ? '—' : p.mcap_per_tvl.toFixed(3) + '×') + '</b></td>' +
      '<td class="num ' + (chg === null ? '' : chg >= 0 ? 'up' : 'down') + '">' + pct(chg) + '</td>' +
      '</tr>';
  }).join('');

  /* ---------------------------------------------------------- tabs + controls */

  function show(view) {
    $('board').hidden = view !== 'board';
    $('controls').style.display = view === 'board' ? '' : 'none';
    $('live').hidden = view !== 'live';
    $('how').hidden = view !== 'how';
    [['tab-board', 'board'], ['tab-live', 'live'], ['tab-how', 'how']].forEach(function (pair) {
      var active = pair[1] === view;
      $(pair[0]).classList.toggle('active', active);
      $(pair[0]).setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  $('tab-board').addEventListener('click', function () { show('board'); });
  $('tab-live').addEventListener('click', function () { show('live'); });
  $('tab-how').addEventListener('click', function () { show('how'); });

  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  $('status').addEventListener('change', function (e) { state.status = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });

  /* ---------------------------------------------------------- deep links */

  var hash = location.hash.slice(1);
  var params = {};
  hash.split('&').forEach(function (part) {
    var kv = part.split('=');
    if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1] || '');
  });
  if (params.cat) { state.cat = params.cat; $('cat').value = params.cat; }
  if (params.status) { state.status = params.status; $('status').value = params.status; }
  if (params.q) { state.q = params.q; $('q').value = params.q; }
  if (params.sort) { state.sort = params.sort; $('sort').value = params.sort; }
  if (params.view === 'live') show('live');
  if (params.view === 'how') show('how');
  renderBoard();
  if (params.detail) openDetail(params.detail);
})();
