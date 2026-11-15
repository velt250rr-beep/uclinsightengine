/** charts.js — dependency-free SVG chart helpers. Return HTML strings. All text is escaped by callers via esc(). */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%');

  /** Stacked 1X2 probability bar with labels. */
  function probBar(probs, names, highlight) {
    const segs = [['H', names.home, 'var(--c-home)'], ['D', 'Draw', 'var(--c-draw)'], ['A', names.away, 'var(--c-away)']];
    const percents = NS.statistics.roundPercentagesToSum([probs.H, probs.D, probs.A], 1);
    return `<div class="probbar" role="img" aria-label="Home ${percents[0]}%, draw ${percents[1]}%, away ${percents[2]}%">` +
      `<div class="probbar-track">${segs.map((s, i) => `<div class="probbar-seg${highlight === s[0] ? ' is-pick' : ''}" style="flex:${Math.max(probs[s[0]], 0.0001)};background:${s[2]}"><span>${percents[i].toFixed(1)}%</span></div>`).join('')}</div>` +
      `<div class="probbar-legend">${segs.map((s, i) => `<span class="${highlight === s[0] ? 'is-pick' : ''}"><i style="background:${s[2]}"></i>${esc(s[1])} <b>${percents[i].toFixed(1)}%</b></span>`).join('')}</div></div>`;
  }

  /** Horizontal comparison bars for two values. */
  function duel(label, a, b, fmt, lowerBetter) {
    const f = fmt || ((v) => (v === null || v === undefined ? '—' : (+v).toFixed(2)));
    const ok = a !== null && a !== undefined && b !== null && b !== undefined;
    const tot = ok ? Math.abs(a) + Math.abs(b) || 1 : 1;
    const aw = ok ? (Math.abs(a) / tot) * 100 : 0, bw = ok ? (Math.abs(b) / tot) * 100 : 0;
    const aBetter = ok && (lowerBetter ? a < b : a > b), bBetter = ok && (lowerBetter ? b < a : b > a);
    return `<div class="duel"><span class="duel-v${aBetter ? ' best' : ''}">${f(a)}</span><div class="duel-mid"><div class="duel-label">${esc(label)}</div>` +
      `<div class="duel-bars"><div class="duel-l"><i style="width:${aw}%"></i></div><div class="duel-r"><i style="width:${bw}%"></i></div></div></div><span class="duel-v${bBetter ? ' best' : ''}">${f(b)}</span></div>`;
  }

  /** Vertical bar chart. items: [{label, value(0..1 or any), sub, color}] */
  function bars(items, opts = {}) {
    const W = opts.width || 520, H = opts.height || 190, pad = { l: 36, r: 8, t: 14, b: 38 };
    const max = opts.max ?? Math.max(1, ...items.map((i) => i.value || 0));
    const bw = Math.min(54, (W - pad.l - pad.r) / Math.max(items.length, 1) - 10);
    const step = (W - pad.l - pad.r) / Math.max(items.length, 1);
    const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    let g = '';
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => { const v = t * max; g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${opts.pct ? Math.round(v * 100) + '%' : v.toFixed(2)}</text>`; });
    if (opts.refLine !== undefined) g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(opts.refLine)}" y2="${y(opts.refLine)}" class="refline"/><text x="${W - pad.r}" y="${y(opts.refLine) - 4}" class="axis" text-anchor="end">${esc(opts.refLabel || '')}</text>`;
    items.forEach((it, i) => {
      const x = pad.l + i * step + (step - bw) / 2;
      if (it.value === null || it.value === undefined || isNaN(it.value)) { g += `<text x="${x + bw / 2}" y="${H - pad.b - 6}" class="axis" text-anchor="middle">n/a</text>`; }
      else g += `<rect x="${x}" y="${y(it.value)}" width="${bw}" height="${Math.max(0, H - pad.b - y(it.value))}" rx="3" fill="${it.color || 'var(--c-accent)'}"><title>${esc(it.label)}: ${opts.pct ? pct(it.value) : it.value.toFixed(3)}</title></rect><text x="${x + bw / 2}" y="${y(it.value) - 4}" class="val" text-anchor="middle">${opts.pct ? Math.round(it.value * 100) + '%' : it.value.toFixed(2)}</text>`;
      g += `<text x="${x + bw / 2}" y="${H - pad.b + 13}" class="axis" text-anchor="middle">${esc(it.label)}</text>`;
      if (it.sub) g += `<text x="${x + bw / 2}" y="${H - pad.b + 25}" class="axis dim" text-anchor="middle">${esc(it.sub)}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'bar chart')}">${g}</svg>`;
  }

  /** Line chart. series: [{name, color, points:[{x,y}]}] x index based. */
  function lines(series, opts = {}) {
    const W = opts.width || 560, H = opts.height || 200, pad = { l: 40, r: 10, t: 12, b: 26 };
    const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => isFinite(v));
    if (!all.length) return '<div class="empty-chart">No data yet</div>';
    let lo = opts.min ?? Math.min(...all), hi = opts.max ?? Math.max(...all);
    if (hi - lo < 1e-9) { hi += 0.05; lo -= 0.05; }
    const n = Math.max(...series.map((s) => s.points.length));
    const x = (i) => pad.l + (n <= 1 ? 0.5 : i / (n - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    let g = '';
    for (let t = 0; t <= 4; t++) { const v = lo + ((hi - lo) * t) / 4; g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${opts.pct ? Math.round(v * 100) + '%' : v.toFixed(2)}</text>`; }
    if (opts.refLine !== undefined && opts.refLine >= lo && opts.refLine <= hi) g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(opts.refLine)}" y2="${y(opts.refLine)}" class="refline"/><text x="${W - pad.r}" y="${y(opts.refLine) - 4}" class="axis" text-anchor="end">${esc(opts.refLabel || '')}</text>`;
    series.forEach((s) => {
      const pts = s.points.map((p, i) => [x(i), y(p.y)]);
      if (pts.length > 1) g += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
      if (pts.length <= 60) pts.forEach((p, i) => { g += `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="${s.color}"><title>${esc(s.name)} #${i + 1}: ${opts.pct ? pct(s.points[i].y) : s.points[i].y.toFixed(3)}</title></circle>`; });
    });
    g += `<text x="${pad.l}" y="${H - 6}" class="axis">${esc(opts.xLabel || 'matches →')}</text>`;
    const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'line chart')}">${g}</svg>${legend}`;
  }

  /** Reliability diagram: predicted prob (x) vs observed frequency (y). bins from statistics.calibrationBins */
  function reliability(bins) {
    const W = 300, H = 270, p = 36, s = W - p - 12;
    const X = (v) => p + v * s, Y = (v) => 12 + (1 - v) * (H - 12 - p);
    let g = `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" class="refline"/>`;
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => { g += `<line x1="${X(t)}" x2="${X(t)}" y1="${Y(0)}" y2="${Y(1)}" class="grid"/><line x1="${X(0)}" x2="${X(1)}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${X(t)}" y="${Y(0) + 14}" class="axis" text-anchor="middle">${t * 100}%</text><text x="${X(0) - 5}" y="${Y(t) + 3}" class="axis" text-anchor="end">${t * 100}%</text>`; });
    const pts = bins.filter((b) => b.n > 0);
    const maxN = Math.max(1, ...pts.map((b) => b.n));
    if (pts.length > 1) g += `<polyline fill="none" stroke="var(--c-accent)" stroke-width="1.5" points="${pts.map((b) => X(b.meanPred) + ',' + Y(b.obsFreq)).join(' ')}"/>`;
    pts.forEach((b) => { g += `<circle cx="${X(b.meanPred)}" cy="${Y(b.obsFreq)}" r="${3 + 5 * Math.sqrt(b.n / maxN)}" fill="var(--c-accent)" fill-opacity=".75"><title>predicted ${pct(b.meanPred)} → observed ${pct(b.obsFreq)} (n=${b.n})</title></circle>`; });
    g += `<text x="${X(0.5)}" y="${H - 4}" class="axis" text-anchor="middle">predicted probability</text><text transform="rotate(-90 10 ${Y(0.5)})" x="10" y="${Y(0.5)}" class="axis" text-anchor="middle">observed frequency</text>`;
    return `<svg class="chart sq" viewBox="0 0 ${W} ${H}" role="img" aria-label="calibration reliability diagram">${g}</svg>`;
  }

  /** Scoreline heat grid (0..max goals). */
  function scoreGrid(matrix, max = 5, names = {}) {
    let mx = 0;
    for (let h = 0; h <= max; h++) for (let a = 0; a <= max; a++) mx = Math.max(mx, matrix[h][a]);
    let rows = `<tr><th class="corner">${esc(names.home || 'H')} ↓ / ${esc(names.away || 'A')} →</th>${Array.from({ length: max + 1 }, (_, a) => `<th>${a}</th>`).join('')}</tr>`;
    for (let h = 0; h <= max; h++) {
      rows += `<tr><th>${h}</th>${Array.from({ length: max + 1 }, (_, a) => { const v = matrix[h][a], t = v / mx; const cls = h > a ? 'h' : h === a ? 'd' : 'a'; return `<td class="sg ${cls}" style="--t:${t.toFixed(3)}" title="${h}-${a}: ${(v * 100).toFixed(2)}%">${(v * 100).toFixed(1)}</td>`; }).join('')}</tr>`;
    }
    return `<div class="scroll-x"><table class="scoregrid">${rows}</table></div>`;
  }

  /** Confusion matrix table. confusion[actual][predicted] */
  function confusion(c, perClass) {
    const lab = { H: '1 (Home)', D: 'X (Draw)', A: '2 (Away)' };
    const max = Math.max(1, ...['H', 'D', 'A'].flatMap((a) => ['H', 'D', 'A'].map((p) => c[a][p])));
    return `<div class="scroll-x"><table class="confmat"><tr><th>actual ↓ / predicted →</th>${['H', 'D', 'A'].map((p) => `<th>${lab[p]}</th>`).join('')}<th>Class accuracy</th></tr>` +
      ['H', 'D', 'A'].map((a) => `<tr><th>${lab[a]}</th>${['H', 'D', 'A'].map((p) => `<td class="${a === p ? 'diag' : ''}" style="--t:${(c[a][p] / max).toFixed(2)}">${c[a][p]}</td>`).join('')}<td>${perClass[a] && perClass[a].n ? pct(perClass[a].accuracy) + ' <span class="dim">(' + perClass[a].correct + '/' + perClass[a].n + ')</span>' : '—'}</td></tr>`).join('') + '</table></div>';
  }

  NS.charts = { esc, pct, probBar, duel, bars, lines, reliability, scoreGrid, confusion };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.charts;
})(typeof window !== 'undefined' ? window : globalThis);
