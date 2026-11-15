/**
 * TEST-ONLY helpers. The synthetic league below is generated from known parameters so tests can verify
 * that the engine recovers structure and that backtesting is leak-free. It is NEVER bundled into the app
 * and its output is never shown as real football data.
 */
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poissonSample(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/**
 * Synthetic multi-season league: `teams` teams, each season a random set of `perSeason` teams plays
 * `matchesPerSeason` matches between Sep and May. Strengths drawn once. Returns match records in app format.
 */
function syntheticLeague({ seed = 1, teams = 24, seasons = 6, matchesPerSeason = 125, startYear = 2018, withOdds = false, withXg = false } = {}) {
  const rng = mulberry32(seed);
  const ids = Array.from({ length: teams }, (_, i) => 'T' + String(i + 1).padStart(2, '0'));
  const att = {}, def = {};
  ids.forEach((id) => { att[id] = Math.exp((rng() - 0.5) * 0.9); def[id] = Math.exp((rng() - 0.5) * 0.9); });
  const matches = [];
  let counter = 0;
  for (let s = 0; s < seasons; s++) {
    const year = startYear + s;
    const season = `${year}-${String(year + 1).slice(2)}`;
    const start = Date.UTC(year, 8, 15), end = Date.UTC(year + 1, 4, 25);
    const pool = ids.slice().sort(() => rng() - 0.5).slice(0, 20);
    const dates = Array.from({ length: matchesPerSeason }, () => start + Math.floor(rng() * (end - start))).sort((a, b) => a - b);
    for (const ts of dates) {
      let h = pool[Math.floor(rng() * pool.length)], a = pool[Math.floor(rng() * pool.length)];
      while (a === h) a = pool[Math.floor(rng() * pool.length)];
      const lh = 1.35 * att[h] * def[a] * 1.3, la = 1.35 * att[a] * def[h];
      const hg = poissonSample(rng, lh), ag = poissonSample(rng, la);
      const rec = {
        id: `M${++counter}`, season, date: new Date(ts).toISOString().slice(0, 10), stage: 'Group',
        homeId: h, awayId: a, homeGoals: hg, awayGoals: ag, neutral: false,
      };
      if (withXg) { rec.homeXg = +(lh * (0.9 + rng() * 0.2)).toFixed(2); rec.awayXg = +(la * (0.9 + rng() * 0.2)).toFixed(2); }
      if (withOdds) {
        // Synthetic "bookmaker": true model probabilities with a 6% margin (test of the overround removal only)
        const P = require('../js/poisson.js'), DC = require('../js/dixoncoles.js');
        const pr = P.outcomeProbs(DC.dcMatrix(lh, la, -0.05));
        rec.oddsH = +(1 / (pr.H * 1.06)).toFixed(3); rec.oddsD = +(1 / (pr.D * 1.06)).toFixed(3); rec.oddsA = +(1 / (pr.A * 1.06)).toFixed(3);
      }
      matches.push(rec);
    }
  }
  const teamsList = ids.map((id) => ({ id, name: 'Team ' + id }));
  return { matches, teams: teamsList, truth: { att, def } };
}

/** Minimal in-memory Storage (same interface as window.localStorage). */
class MemoryStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

module.exports = { mulberry32, poissonSample, syntheticLeague, MemoryStorage };
