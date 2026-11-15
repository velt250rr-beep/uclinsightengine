/**
 * statistics.js — pure scoring / evaluation helpers (no DOM, no storage).
 *
 * Outcome codes used everywhere: 'H' (=1 home win), 'D' (=X draw), 'A' (=2 away win).
 * A probability triple is a plain object {H, D, A}.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});

  const OUTCOMES = ['H', 'D', 'A'];
  const SYMBOL = { H: '1', D: 'X', A: '2' };
  const LABEL = { H: 'Home Win', D: 'Draw', A: 'Away Win' };
  const EPS = 1e-15;

  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function outcomeFromScore(hg, ag) {
    return hg > ag ? 'H' : hg < ag ? 'A' : 'D';
  }

  function isProbTriple(p) {
    return !!p && OUTCOMES.every((o) => typeof p[o] === 'number' && isFinite(p[o]) && p[o] >= 0);
  }

  function normalizeProbs(p) {
    if (!isProbTriple(p)) throw new Error('Invalid probability triple');
    const s = p.H + p.D + p.A;
    if (!(s > 0)) throw new Error('Probabilities sum to zero');
    return { H: p.H / s, D: p.D / s, A: p.A / s };
  }

  /** Outcome with the highest probability. Exact ties resolve in the fixed order H, D, A. */
  function argmaxOutcome(p) {
    let best = 'H';
    for (const o of ['D', 'A']) if (p[o] > p[best] + 1e-12) best = o;
    return best;
  }

  function sortedOutcomes(p) {
    return OUTCOMES.slice().sort((a, b) => p[b] - p[a] || OUTCOMES.indexOf(a) - OUTCOMES.indexOf(b));
  }

  /** Multiclass Brier score for one match (range 0..2; lower is better). */
  function brierScore(p, outcome) {
    return OUTCOMES.reduce((s, o) => s + Math.pow(p[o] - (o === outcome ? 1 : 0), 2), 0);
  }

  /** Negative log-likelihood of the realised outcome (natural log). */
  function logLoss(p, outcome) {
    return -Math.log(Math.max(p[outcome], EPS));
  }

  /** Wilson score interval for a binomial proportion. */
  function wilsonInterval(k, n, z = 1.96) {
    if (!n) return { lo: NaN, hi: NaN };
    const ph = k / n;
    const d = 1 + (z * z) / n;
    const c = (ph + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
    return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
  }

  /**
   * Summarise a list of {p:{H,D,A}, outcome}. Pick = argmax(p).
   */
  function summarize(records) {
    const n = records.length;
    const confusion = { H: { H: 0, D: 0, A: 0 }, D: { H: 0, D: 0, A: 0 }, A: { H: 0, D: 0, A: 0 } }; // [actual][predicted]
    if (!n) {
      return { n: 0, correct: 0, accuracy: NaN, wilson: { lo: NaN, hi: NaN }, brier: NaN, logLoss: NaN, confusion, perClass: {}, picks: { H: 0, D: 0, A: 0 } };
    }
    let correct = 0, br = 0, ll = 0;
    const picks = { H: 0, D: 0, A: 0 };
    for (const r of records) {
      const pick = argmaxOutcome(r.p);
      picks[pick]++;
      confusion[r.outcome][pick]++;
      if (pick === r.outcome) correct++;
      br += brierScore(r.p, r.outcome);
      ll += logLoss(r.p, r.outcome);
    }
    const perClass = {};
    for (const o of OUTCOMES) {
      const actual = sum(OUTCOMES.map((x) => confusion[o][x]));
      perClass[o] = { n: actual, correct: confusion[o][o], accuracy: actual ? confusion[o][o] / actual : NaN };
    }
    return { n, correct, accuracy: correct / n, wilson: wilsonInterval(correct, n), brier: br / n, logLoss: ll / n, confusion, perClass, picks };
  }

  /**
   * Reliability bins (pooled one-vs-rest: every outcome probability of every match is one point).
   * ece = expected calibration error.
   */
  function calibrationBins(records, nBins = 10) {
    const bins = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, sumP: 0, sumY: 0 }));
    let total = 0;
    for (const r of records) {
      for (const o of OUTCOMES) {
        const b = bins[Math.min(nBins - 1, Math.floor(r.p[o] * nBins))];
        b.n++; b.sumP += r.p[o]; b.sumY += o === r.outcome ? 1 : 0; total++;
      }
    }
    let ece = 0;
    const out = bins.map((b) => {
      const mp = b.n ? b.sumP / b.n : NaN, of = b.n ? b.sumY / b.n : NaN;
      if (b.n) ece += (b.n / total) * Math.abs(mp - of);
      return { lo: b.lo, hi: b.hi, n: b.n, meanPred: mp, obsFreq: of };
    });
    return { bins: out, ece: total ? ece : NaN };
  }

  /** Accuracy grouped by the probability of the picked outcome. */
  function confidenceRanges(records, edges = [0, 0.4, 0.5, 0.6, 0.7, 1.0001]) {
    const rows = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const sel = records.filter((r) => { const m = r.p[argmaxOutcome(r.p)]; return m >= lo && m < hi; });
      const correct = sel.filter((r) => argmaxOutcome(r.p) === r.outcome).length;
      rows.push({
        label: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`,
        lo, hi, n: sel.length, correct,
        accuracy: sel.length ? correct / sel.length : NaN,
        meanConfidence: sel.length ? mean(sel.map((r) => r.p[argmaxOutcome(r.p)])) : NaN,
      });
    }
    return rows;
  }

  /** Convert probabilities (summing to 1) into percentages that sum to exactly 100 at the given precision. */
  function roundPercentagesToSum(probs, decimals = 1) {
    const f = Math.pow(10, decimals);
    const scaled = probs.map((p) => p * 100 * f);
    const floors = scaled.map(Math.floor);
    let rem = Math.round(100 * f) - sum(floors);
    const order = scaled.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < rem; k++) floors[order[k % order.length][1]]++;
    return floors.map((v) => v / f);
  }

  /** FNV-1a 32-bit hash (hex) — used for dataset/config fingerprints. */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  const api = {
    OUTCOMES, SYMBOL, LABEL, sum, mean, clamp, outcomeFromScore, isProbTriple, normalizeProbs,
    argmaxOutcome, sortedOutcomes, brierScore, logLoss, wilsonInterval, summarize,
    calibrationBins, confidenceRanges, roundPercentagesToSum, hashString,
  };
  NS.statistics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
