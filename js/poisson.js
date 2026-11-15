/**
 * poisson.js — Poisson pmf and scoreline-matrix utilities.
 * matrix[h][a] = P(home scores h, away scores a), 0 <= h,a <= maxGoals.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});

  const lf = [0, 0];
  function logFactorial(n) {
    for (let i = lf.length; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
    return lf[n];
  }

  function pmf(k, lambda) {
    if (!isFinite(lambda) || lambda < 0) throw new Error('Poisson lambda must be finite and >= 0');
    if (k < 0 || !Number.isInteger(k)) return 0;
    if (lambda === 0) return k === 0 ? 1 : 0;
    return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
  }

  function normalizeMatrix(m) {
    let s = 0;
    for (const row of m) for (const v of row) s += v;
    if (!(s > 0)) throw new Error('Scoreline matrix has zero mass');
    return m.map((row) => row.map((v) => v / s));
  }

  /** Independent-Poisson scoreline matrix, renormalised to absorb the truncated tail (< 1e-6 for lambda <= 4). */
  function scoreMatrix(lh, la, maxGoals = 10) {
    const ph = [], pa = [];
    for (let i = 0; i <= maxGoals; i++) { ph.push(pmf(i, lh)); pa.push(pmf(i, la)); }
    return normalizeMatrix(ph.map((x) => pa.map((y) => x * y)));
  }

  /** Aggregate a (normalised) matrix into {H,D,A}. */
  function outcomeProbs(matrix) {
    let H = 0, D = 0, A = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h].length; a++) {
        const v = matrix[h][a];
        if (h > a) H += v; else if (h === a) D += v; else A += v;
      }
    }
    const s = H + D + A;
    return { H: H / s, D: D / s, A: A / s };
  }

  function expectedGoals(matrix) {
    let eh = 0, ea = 0;
    for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) { eh += h * matrix[h][a]; ea += a * matrix[h][a]; }
    return { home: eh, away: ea };
  }

  function topScorelines(matrix, n = 8) {
    const cells = [];
    for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) cells.push({ home: h, away: a, p: matrix[h][a] });
    return cells.sort((x, y) => y.p - x.p || x.home + x.away - (y.home + y.away)).slice(0, n);
  }

  /**
   * Rescale the cells of each outcome region so the matrix reproduces `target` 1X2 probabilities exactly,
   * preserving the relative scoreline shape inside each region. Keeps the scoreline view consistent with
   * the final (blended / calibrated) 1X2 probabilities.
   */
  function rescaleToOutcomes(matrix, target) {
    const cur = outcomeProbs(matrix);
    return matrix.map((row, h) => row.map((v, a) => {
      const o = h > a ? 'H' : h === a ? 'D' : 'A';
      return cur[o] > 0 ? (v * target[o]) / cur[o] : 0;
    }));
  }

  const api = { logFactorial, pmf, scoreMatrix, normalizeMatrix, outcomeProbs, expectedGoals, topScorelines, rescaleToOutcomes };
  NS.poisson = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
