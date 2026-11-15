/** Core tests for statistics, probability models, and calibration. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/statistics.js');
const P = require('../js/poisson.js');
const DC = require('../js/dixoncoles.js');
const Elo = require('../js/elo.js');
const Cal = require('../js/calibration.js');
const { ProbabilityEngine } = require('../js/probabilityengine.js');
const { syntheticLeague } = require('./helpers.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('poisson pmf matches known values and sums to ~1', () => {
  close(P.pmf(0, 1), Math.exp(-1));
  close(P.pmf(2, 1.5), Math.exp(-1.5) * 1.5 * 1.5 / 2);
  assert.equal(P.pmf(0, 0), 1);
  assert.equal(P.pmf(3, 0), 0);
  let s = 0; for (let k = 0; k < 40; k++) s += P.pmf(k, 3.2);
  close(s, 1, 1e-9);
  assert.throws(() => P.pmf(1, -1));
  assert.throws(() => P.pmf(1, NaN));
});

test('score matrix is normalised, symmetric for equal lambdas, and H/A mirror', () => {
  const m = P.scoreMatrix(1.4, 1.4);
  let s = 0; m.forEach((r) => r.forEach((v) => (s += v)));
  close(s, 1);
  const o = P.outcomeProbs(m);
  close(o.H, o.A, 1e-12);
  close(o.H + o.D + o.A, 1);
  const o2 = P.outcomeProbs(P.scoreMatrix(2.1, 0.8));
  assert.ok(o2.H > o2.D && o2.D > o2.A);
});

test('Dixon–Coles tau values and mass preservation', () => {
  const lh = 1.5, la = 1.1, rho = -0.1;
  close(DC.tau(0, 0, lh, la, rho), 1 - lh * la * rho);
  close(DC.tau(0, 1, lh, la, rho), 1 + lh * rho);
  close(DC.tau(1, 0, lh, la, rho), 1 + la * rho);
  close(DC.tau(1, 1, lh, la, rho), 1 - rho);
  assert.equal(DC.tau(2, 1, lh, la, rho), 1);
  const raw = P.scoreMatrix(lh, la, 12), adj = DC.applyAdjustment(raw, lh, la, rho);
  let s = 0; adj.forEach((r) => r.forEach((v) => (s += v)));
  close(s, 1);
  // negative rho raises 0-0 and 1-1, lowers 1-0 and 0-1
  assert.ok(adj[0][0] > raw[0][0] && adj[1][1] > raw[1][1]);
  assert.ok(adj[1][0] < raw[1][0] && adj[0][1] < raw[0][1]);
  // rho = 0 is the identity
  const id = DC.applyAdjustment(raw, lh, la, 0);
  close(id[2][1], raw[2][1], 1e-12);
});

test('extreme rho is clamped to a valid (positive tau) range', () => {
  const m = DC.dcMatrix(2, 2, 5);
  m.forEach((r) => r.forEach((v) => assert.ok(v >= 0 && isFinite(v))));
});

test('Elo: expected score, symmetry, update conservation, goal multiplier', () => {
  close(Elo.expectedScore(0), 0.5);
  close(Elo.expectedScore(400), 10 / 11);
  close(Elo.expectedScore(120) + Elo.expectedScore(-120), 1);
  assert.equal(Elo.goalMultiplier(1), 1);
  assert.equal(Elo.goalMultiplier(2), 1.5);
  assert.equal(Elo.goalMultiplier(-3), 14 / 8);
  const m = Elo.fit([{ homeId: 'a', awayId: 'b', hg: 3, ag: 0 }, { homeId: 'b', awayId: 'a', hg: 1, ag: 1 }]);
  close(m.ratings.a + m.ratings.b, 3000, 1e-9); // zero-sum
  assert.ok(m.ratings.a > m.ratings.b);
  const d = Elo.davidson(0.6, 0.7);
  close(d.H + d.D + d.A, 1);
  assert.ok(d.H > d.A);
});

test('Elo seeds apply only to teams first seen and never silently when absent', () => {
  const m = Elo.fit([{ homeId: 'a', awayId: 'b', hg: 1, ag: 0 }], { seeds: { a: 1800 } });
  assert.ok(m.ratings.a > 1800 && m.ratings.b < 1500);
  const p = Elo.predict(m, 'zzz', 'yyy');
  assert.ok(p.unknownHome && p.unknownAway);
});

test('statistics: brier, log loss, summarize, wilson, rounding', () => {
  close(S.brierScore({ H: 1, D: 0, A: 0 }, 'H'), 0);
  close(S.brierScore({ H: 0, D: 0, A: 1 }, 'H'), 2);
  close(S.brierScore({ H: 1 / 3, D: 1 / 3, A: 1 / 3 }, 'D'), 2 / 3);
  close(S.logLoss({ H: 0.5, D: 0.3, A: 0.2 }, 'D'), -Math.log(0.3));
  assert.ok(isFinite(S.logLoss({ H: 1, D: 0, A: 0 }, 'D')));
  const recs = [
    { p: { H: 0.6, D: 0.2, A: 0.2 }, outcome: 'H' },
    { p: { H: 0.2, D: 0.2, A: 0.6 }, outcome: 'H' },
    { p: { H: 0.5, D: 0.3, A: 0.2 }, outcome: 'D' },
    { p: { H: 0.1, D: 0.2, A: 0.7 }, outcome: 'A' },
  ];
  const sm = S.summarize(recs);
  assert.equal(sm.n, 4); assert.equal(sm.correct, 2); close(sm.accuracy, 0.5);
  assert.equal(sm.confusion.H.H, 1); assert.equal(sm.confusion.H.A, 1); assert.equal(sm.confusion.D.H, 1);
  close(sm.perClass.D.accuracy, 0);
  const w = S.wilsonInterval(50, 100);
  assert.ok(w.lo < 0.5 && w.hi > 0.5 && w.lo > 0.39 && w.hi < 0.61);
  const rounded = S.roundPercentagesToSum([1 / 3, 1 / 3, 1 / 3], 1);
  close(rounded.reduce((a, b) => a + b, 0), 100, 1e-9);
  const r2 = S.roundPercentagesToSum([0.4567, 0.2711, 0.2722], 1);
  close(r2.reduce((a, b) => a + b, 0), 100, 1e-9);
  assert.equal(S.summarize([]).n, 0);
});

test('statistics: argmax tie-breaking is deterministic and a single outcome', () => {
  assert.equal(S.argmaxOutcome({ H: 1 / 3, D: 1 / 3, A: 1 / 3 }), 'H');
  assert.equal(S.argmaxOutcome({ H: 0.2, D: 0.4, A: 0.4 }), 'D');
  assert.equal(S.argmaxOutcome({ H: 0.2, D: 0.3, A: 0.5 }), 'A');
});

test('calibration bins & confidence ranges are consistent', () => {
  const recs = Array.from({ length: 200 }, (_, i) => ({ p: { H: 0.5, D: 0.3, A: 0.2 }, outcome: i % 2 ? 'H' : 'D' }));
  const cb = S.calibrationBins(recs, 10);
  assert.equal(cb.bins.reduce((s, b) => s + b.n, 0), 600);
  assert.ok(cb.ece >= 0);
  const cr = S.confidenceRanges(recs);
  assert.equal(cr.reduce((s, r) => s + r.n, 0), 200);
});

test('Dixon–Coles fit recovers synthetic team ordering (SYNTHETIC test data)', () => {
  const { matches, truth } = syntheticLeague({ seed: 7, seasons: 8, matchesPerSeason: 200 });
  const ms = matches.map((m) => ({ ts: Date.parse(m.date), homeId: m.homeId, awayId: m.awayId, hg: m.homeGoals, ag: m.awayGoals, neutral: false }));
  const fit = DC.fit(ms, { xi: 0, priorMatches: 3 });
  assert.ok(fit.converged);
  assert.ok(fit.gamma > 1.1 && fit.gamma < 1.5, 'home advantage recovered ~1.3, got ' + fit.gamma);
  const ids = Object.keys(fit.attack);
  const ta = ids.map((i) => Math.log(truth.att[i])), fa = ids.map((i) => Math.log(fit.attack[i]));
  const corr = (x, y) => { const mx = S.mean(x), my = S.mean(y); let n = 0, dx = 0, dy = 0; x.forEach((v, i) => { n += (v - mx) * (y[i] - my); dx += (v - mx) ** 2; dy += (y[i] - my) ** 2; }); return n / Math.sqrt(dx * dy); };
  assert.ok(corr(ta, fa) > 0.8, 'attack correlation ' + corr(ta, fa));
  close(S.mean(Object.values(fit.attack)), 1, 1e-6);
});

test('DC fit handles tiny / empty / single-match input', () => {
  assert.equal(DC.fit([]).empty, true);
  const f = DC.fit([{ ts: 1e12, homeId: 'a', awayId: 'b', hg: 0, ag: 0, neutral: false }]);
  assert.ok(isFinite(f.mu) && isFinite(f.gamma));
  const l = DC.lambdas(f, 'a', 'nobody');
  assert.ok(l.unknownAway && !l.unknownHome);
});

test('engine: 1X2 always sums to 1, exactly one pick, matrix consistent with final probabilities', () => {
  const { matches } = syntheticLeague({ seed: 3 });
  const eng = new ProbabilityEngine();
  const fitted = eng.fit(matches);
  for (const [h, a] of [['T01', 'T02'], ['T05', 'T09'], ['NEW1', 'NEW2'], ['T01', 'NEW2']]) {
    for (const neutral of [false, true]) {
      const pr = eng.predict(fitted, { homeId: h, awayId: a, neutral });
      close(pr.calibrated.H + pr.calibrated.D + pr.calibrated.A, 1, 1e-12);
      assert.ok(['H', 'D', 'A'].includes(pr.pick));
      assert.equal(pr.pick, S.argmaxOutcome(pr.calibrated));
      const mo = P.outcomeProbs(pr.matrix);
      close(mo.H, pr.calibrated.H, 1e-9); close(mo.D, pr.calibrated.D, 1e-9); close(mo.A, pr.calibrated.A, 1e-9);
      const pct = S.roundPercentagesToSum([pr.calibrated.H, pr.calibrated.D, pr.calibrated.A], 1);
      close(pct[0] + pct[1] + pct[2], 100, 1e-9);
    }
  }
});

test('engine: no history -> still valid, flagged unknown teams', () => {
  const eng = new ProbabilityEngine();
  const fitted = eng.fit([]);
  const pr = eng.predict(fitted, { homeId: 'a', awayId: 'b' });
  assert.ok(pr.flags.unknownHome && pr.flags.unknownAway);
  close(pr.calibrated.H + pr.calibrated.D + pr.calibrated.A, 1);
});

test('xG blend is used only with enough xG history; otherwise reported as not applied', () => {
  const without = syntheticLeague({ seed: 4 }), withX = syntheticLeague({ seed: 4, withXg: true });
  const eng = new ProbabilityEngine();
  const p1 = eng.predict(eng.fit(without.matches), { homeId: 'T01', awayId: 'T02' });
  const p2 = eng.predict(eng.fit(withX.matches), { homeId: 'T01', awayId: 'T02' });
  assert.equal(p1.adjustments.find((a) => a.name === 'xG blend').applied, false);
  const x2 = p2.adjustments.find((a) => a.name === 'xG blend');
  assert.equal(typeof x2.applied, 'boolean');
  if (x2.applied) assert.ok(x2.weight > 0 && x2.weight <= 0.5);
});

test('squad adjustment is off by default and reduces the affected side when enabled', () => {
  const { matches } = syntheticLeague({ seed: 5 });
  const ctx = { squad: { home: { missing: [{ attackShare: 0.3, defenceShare: 0 }] }, away: { missing: [] } } };
  const off = new ProbabilityEngine(), on = new ProbabilityEngine({ squad: { enabled: true } });
  const a = off.predict(off.fit(matches), { homeId: 'T01', awayId: 'T02' }, ctx);
  const b = on.predict(on.fit(matches), { homeId: 'T01', awayId: 'T02' }, ctx);
  assert.equal(a.adjustments.find((x) => x.name === 'Squad availability').applied, false);
  assert.ok(b.lambdas.final.home < a.lambdas.final.home);
});

test('calibrator is identity until enough samples, then fits and still returns valid probabilities', () => {
  const c = new Cal.Calibrator({ minSamples: 50 });
  const recs = [];
  for (let i = 0; i < 40; i++) recs.push({ p: { H: 0.7, D: 0.2, A: 0.1 }, outcome: i % 2 ? 'H' : 'D' });
  c.fit(recs);
  assert.equal(c.active, false);
  assert.deepEqual(c.apply({ H: 0.7, D: 0.2, A: 0.1 }), { H: 0.7, D: 0.2, A: 0.1 });
  for (let i = 0; i < 80; i++) recs.push({ p: { H: 0.7, D: 0.2, A: 0.1 }, outcome: i % 2 ? 'H' : 'D' });
  c.fit(recs);
  assert.equal(c.active, true);
  const q = c.apply({ H: 0.7, D: 0.2, A: 0.1 });
  close(q.H + q.D + q.A, 1);
  assert.ok(q.H < 0.7, 'overconfident home probability should be pulled down, got ' + q.H);
  assert.ok(q.D > 0.2);
});

test('calibrator reduces log loss on miscalibrated (synthetic) predictions', () => {
  const rng = require('./helpers.js').mulberry32(11);
  const recs = [];
  for (let i = 0; i < 600; i++) {
    const trueP = { H: 0.45, D: 0.3, A: 0.25 };
    const claimed = { H: 0.75, D: 0.15, A: 0.1 };
    const r = rng();
    recs.push({ p: claimed, outcome: r < trueP.H ? 'H' : r < trueP.H + trueP.D ? 'D' : 'A' });
  }
  const before = S.summarize(recs).logLoss;
  const c = new Cal.Calibrator({ minSamples: 100 }).fit(recs);
  const after = S.summarize(recs.map((r) => ({ p: c.apply(r.p), outcome: r.outcome }))).logLoss;
  assert.ok(after < before, `${after} < ${before}`);
});
