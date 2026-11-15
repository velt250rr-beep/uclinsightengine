/**
 * calibration.js — probability calibration by vector scaling (multinomial logistic recalibration).
 *
 *   z_k = w * ln(p_k) + b_k   (b_H = 0),   q = softmax(z)
 *
 * Parameters (w, b_D, b_A) are fitted by gradient descent on log loss with a weak ridge prior pulling
 * toward the identity (w=1, b=0). The calibrator only activates once `minSamples` genuinely
 * out-of-sample predictions (with known outcomes) are available; before that it is the identity.
 * In walk-forward backtesting the calibrator for match i is fitted ONLY on predictions for matches
 * played before match i's date.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const S = typeof require === 'function' && typeof module !== 'undefined' ? require('./statistics.js') : NS.statistics;

  const EPS = 1e-12;
  const IDENTITY = { w: 1, bD: 0, bA: 0 };

  function applyParams(p, params) {
    const z = {
      H: params.w * Math.log(Math.max(p.H, EPS)),
      D: params.w * Math.log(Math.max(p.D, EPS)) + params.bD,
      A: params.w * Math.log(Math.max(p.A, EPS)) + params.bA,
    };
    const m = Math.max(z.H, z.D, z.A);
    const e = { H: Math.exp(z.H - m), D: Math.exp(z.D - m), A: Math.exp(z.A - m) };
    const s = e.H + e.D + e.A;
    return { H: e.H / s, D: e.D / s, A: e.A / s };
  }

  function fitParams(records, opts = {}) {
    const o = Object.assign({ l2: 5, iters: 600, lr: 0.5 }, opts);
    const n = records.length;
    let w = 1, bD = 0, bA = 0;
    const L = records.map((r) => ({ H: Math.log(Math.max(r.p.H, EPS)), D: Math.log(Math.max(r.p.D, EPS)), A: Math.log(Math.max(r.p.A, EPS)), y: r.outcome }));
    for (let it = 0; it < o.iters; it++) {
      let gw = 0, gD = 0, gA = 0;
      for (const r of L) {
        const zH = w * r.H, zD = w * r.D + bD, zA = w * r.A + bA;
        const m = Math.max(zH, zD, zA);
        const eH = Math.exp(zH - m), eD = Math.exp(zD - m), eA = Math.exp(zA - m), s = eH + eD + eA;
        const qH = eH / s, qD = eD / s, qA = eA / s;
        gw += (qH - (r.y === 'H' ? 1 : 0)) * r.H + (qD - (r.y === 'D' ? 1 : 0)) * r.D + (qA - (r.y === 'A' ? 1 : 0)) * r.A;
        gD += qD - (r.y === 'D' ? 1 : 0);
        gA += qA - (r.y === 'A' ? 1 : 0);
      }
      gw = gw / n + (2 * o.l2 * (w - 1)) / n;
      gD = gD / n + (2 * o.l2 * bD) / n;
      gA = gA / n + (2 * o.l2 * bA) / n;
      w -= o.lr * gw; bD -= o.lr * gD; bA -= o.lr * gA;
    }
    return { w, bD, bA };
  }

  class Calibrator {
    constructor(opts = {}) {
      this.minSamples = opts.minSamples ?? 200;
      this.l2 = opts.l2 ?? 5;
      this.enabled = opts.enabled !== false;
      this.params = Object.assign({}, IDENTITY);
      this.active = false;
      this.n = 0;
    }
    /** @param records [{p:{H,D,A}, outcome}] out-of-sample predictions with known outcomes */
    fit(records) {
      this.n = records.length;
      if (!this.enabled || records.length < this.minSamples) { this.params = Object.assign({}, IDENTITY); this.active = false; return this; }
      this.params = fitParams(records, { l2: this.l2 });
      this.active = true;
      return this;
    }
    apply(p) { return this.active ? applyParams(p, this.params) : { H: p.H, D: p.D, A: p.A }; }
    toJSON() { return { params: this.params, active: this.active, n: this.n, minSamples: this.minSamples, l2: this.l2, enabled: this.enabled }; }
    static fromJSON(j) { const c = new Calibrator(j || {}); if (j) { c.params = j.params || c.params; c.active = !!j.active; c.n = j.n || 0; } return c; }
  }

  const api = { IDENTITY, applyParams, fitParams, Calibrator };
  NS.calibration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
