/** Integration tests for validation, storage, data access, and analysis flows. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/validation.js');
const Store = require('../js/storage.js');
const { DataManager } = require('../js/datamanager.js');
const { ApiClient, mapFootballDataMatch, mapFootballDataContext } = require('../js/api.js');
const { PredictionHistory } = require('../js/predictionhistory.js');
const BT = require('../js/backtesting.js');
const AE = require('../js/analysisengine.js');
const S = require('../js/statistics.js');
const { syntheticLeague, MemoryStorage } = require('./helpers.js');

const asRows = (matches, names) => matches.map((m) => ({ ...m, homeName: 'Team ' + m.homeId, awayName: 'Team ' + m.awayId }));
function loadedDM(opts) {
  const lg = syntheticLeague(opts);
  const dm = new DataManager(Store.createStorage(new MemoryStorage()), { now: () => '2026-11-01T00:00:00Z' });
  const res = V.validateMatchRows(asRows(lg.matches), { today: new Date('2026-11-01') });
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors.slice(0, 3)));
  dm.importMatches(res.valid, { source: 'test' });
  return { dm, lg };
}

test('CSV parsing: quotes, delimiters, aliases, BOM', () => {
  const p = V.parseCSV('﻿date;home;away;FTHG;FTAG\n2024-09-17;"Club, A";B;2;1\r\n2024-09-18;C;D;0;0\n');
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].homeName, 'Club, A');
  assert.equal(p.rows[0].homeGoals, '2');
  assert.equal(p.delimiter, ';');
});

test('validation rejects bad rows with reasons and keeps missing as null', () => {
  const rows = [
    { date: '2024-09-17', home: 'A', away: 'B', homeGoals: '2', awayGoals: '1' },
    { date: '2024-13-45', home: 'A', away: 'B' },
    { date: '2024-09-17', home: 'A', away: 'A' },
    { date: '2024-09-17', home: 'A', away: 'B', homeGoals: '-1', awayGoals: '1' },
    { date: '2024-09-17', home: 'A', away: 'B', homeGoals: '1' },
    { date: '2024-09-19', home: 'C', away: 'D', homeGoals: '1', awayGoals: '1', oddsH: '0.5', oddsD: '3', oddsA: '3' },
    { date: '2024-09-20', home: 'E', away: 'F', homeGoals: '1', awayGoals: '0' },
  ];
  const r = V.validateMatchRows(rows, { today: new Date('2026-01-01') });
  assert.equal(r.valid.length, 2);
  assert.equal(r.errors.length, 5);
  assert.equal(r.valid[1].homeXg, null);
  assert.equal(r.valid[1].oddsH, null);
  assert.ok(r.errors.some((e) => /future|invalid|differ|integer|both goals|odds/.test(e.msg)));
});

test('future result rejected; duplicate ids rejected', () => {
  const r = V.validateMatchRows([{ date: '2030-01-01', home: 'A', away: 'B', homeGoals: '1', awayGoals: '0' }], { today: new Date('2026-01-01') });
  assert.equal(r.valid.length, 0);
  const d = V.validateMatchRows([{ id: 'x', date: '2024-01-01', home: 'A', away: 'B' }, { id: 'x', date: '2024-02-01', home: 'A', away: 'C' }]);
  assert.equal(d.valid.length, 1); assert.equal(d.errors.length, 1);
});

test('parseImport handles bad JSON / empty / missing columns / valid JSON', () => {
  assert.equal(V.parseImport('').ok, false);
  assert.equal(V.parseImport('{bad').ok, false);
  assert.equal(V.parseImport('date,foo\n2024-01-01,1').ok, false);
  const j = V.parseImport(JSON.stringify({ matches: [{ date: '2024-01-01', home: 'A', away: 'B' }] }));
  assert.equal(j.ok, true); assert.equal(j.rows.length, 1);
});

test('odds: overround removal sums to 1; unreliable odds rejected', () => {
  const m = { oddsH: 2, oddsD: 3.5, oddsA: 4 };
  const p = V.normalizedOddsProbs(m);
  assert.ok(Math.abs(p.H + p.D + p.A - 1) < 1e-12);
  assert.ok(V.reliableOdds(m));
  assert.equal(V.reliableOdds({ oddsH: 1.2, oddsD: 1.2, oddsA: 1.2 }), false);
  assert.equal(V.reliableOdds({ oddsH: null, oddsD: 3, oddsA: 3 }), false);
});

test('config validation', () => {
  assert.equal(V.validateConfigPatch({ elo: { k: 30, homeAdvantage: 65, initial: 1500 } }).length, 0);
  assert.ok(V.validateConfigPatch({ elo: { k: -3, homeAdvantage: 65, initial: 1500 } }).length > 0);
  assert.ok(V.validateConfigPatch({ blend: { eloWeight: 2 } }).length > 0);
  assert.ok(V.validateContext({ homeInjuries: [{ name: '', attackShare: 2 }] }).length >= 2);
});

test('storage: roundtrip, corrupt JSON fallback, quota error, memory fallback', () => {
  const be = new MemoryStorage();
  const st = Store.createStorage(be);
  assert.deepEqual(st.set('k', { a: 1 }), { ok: true });
  assert.deepEqual(st.get('k'), { a: 1 });
  be.setItem(Store.PREFIX + 'bad', '{oops');
  assert.equal(st.get('bad', 'fb'), 'fb');
  const full = { getItem: () => null, setItem: () => { const e = new Error('q'); e.name = 'QuotaExceededError'; throw e; }, removeItem() {}, key: () => null, length: 0 };
  const r = Store.createStorage(full).set('x', 1);
  assert.equal(r.ok, false); assert.match(r.error, /quota/i);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {}, key: () => null, length: 0 };
  assert.equal(Store.createStorage(broken).persistent, true); // explicit backend is trusted; writes report errors
  assert.equal(Store.createStorage(broken).set('a', 1).ok, false);
});

test('persistence: DataManager state survives reload from the same storage', () => {
  const be = new MemoryStorage();
  const st = Store.createStorage(be);
  const dm = new DataManager(st);
  dm.importMatches(V.validateMatchRows([{ date: '2024-09-17', home: 'A', away: 'B', homeGoals: '1', awayGoals: '0' }]).valid, { source: 'csv' });
  const dm2 = new DataManager(Store.createStorage(be)).load();
  assert.equal(dm2.listMatches().length, 1);
  assert.equal(dm2.finishedMatches().length, 1);
});

test('provider lineups and formations never overwrite manual match context', () => {
  const dm = new DataManager(Store.createStorage(new MemoryStorage()), { now: () => '2026-11-01T00:00:00Z' });
  dm.importMatches(V.validateMatchRows([{ date: '2026-11-20', home: 'A', away: 'B' }]).valid);
  const id = dm.listMatches()[0].id;
  dm.setContext(id, { homeLineup: { status: 'expected', players: ['Manual player'] }, homeFormation: '4-4-2' });
  dm.setContextFromProvider(id, { homeLineup: { status: 'confirmed', players: ['API player'] }, homeFormation: '4-3-3', awayLineup: { status: 'confirmed', players: ['Away player'] } }, 'api:football-data');
  const ctx = dm.getContext(id);
  assert.deepEqual(ctx.fields.homeLineup, { status: 'expected', players: ['Manual player'] });
  assert.equal(ctx.meta.homeLineup.source, 'manual');
  assert.equal(ctx.fields.homeFormation, '4-4-2');
  assert.deepEqual(ctx.fields.awayLineup, { status: 'confirmed', players: ['Away player'] });
  assert.equal(ctx.meta.awayLineup.source, 'api:football-data');
});

test('hybrid: manual override is never silently overwritten; conflict is recorded', () => {
  const dm = new DataManager(Store.createStorage(new MemoryStorage()), { now: () => '2026-11-01T00:00:00Z' });
  const rec = V.validateMatchRows([{ date: '2024-09-17', home: 'FC Alpha', away: 'Beta', homeGoals: '1', awayGoals: '0' }]).valid;
  dm.importMatches(rec, { source: 'api:football-data', quality: 'api' });
  const id = dm.listMatches()[0].id;
  dm.setOverride(id, 'homeGoals', 2, 'fixed by hand');
  const again = V.validateMatchRows([{ date: '2024-09-17', home: 'Alpha', away: 'Beta', homeGoals: '3', awayGoals: '0' }]).valid;
  const rep = dm.importMatches(again, { source: 'api:football-data', quality: 'api' });
  assert.equal(dm.listMatches().length, 1, 'same fixture merged despite different id/name form');
  assert.equal(dm.getMatch(id).homeGoals, 2, 'manual value kept');
  assert.equal(rep.conflicts, 1);
  assert.equal(dm.openConflicts().length, 1);
  assert.equal(dm.provenanceOf(id, 'homeGoals').origin, 'manual');
  assert.equal(dm.provenanceOf(id, 'awayGoals').origin, 'api:football-data');
  assert.equal(dm.provenanceOf(id, 'homeXg').origin, 'missing');
  dm.resolveConflict(0, 'accept-incoming');
  assert.equal(dm.getMatch(id).homeGoals, 3);
});

test('manual result validation', () => {
  const dm = new DataManager(Store.createStorage(new MemoryStorage()), { now: () => '2026-11-01T00:00:00Z' });
  dm.importMatches(V.validateMatchRows([{ date: '2026-11-20', home: 'A', away: 'B' }]).valid);
  const id = dm.listMatches()[0].id;
  assert.equal(dm.setManualResult(id, 1, 0).ok, false, 'future result refused');
  dm.importMatches(V.validateMatchRows([{ date: '2026-10-20', home: 'C', away: 'D' }]).valid);
  const id2 = dm.listMatches().find((m) => m.homeName === 'C').id;
  assert.equal(dm.setManualResult(id2, -1, 0).ok, false);
  assert.equal(dm.setManualResult(id2, 2, 2).ok, true);
  assert.equal(dm.getMatch(id2).status, 'finished');
});

test('CSV export -> import roundtrip preserves matches', () => {
  const { dm } = loadedDM({ seed: 2, seasons: 2, matchesPerSeason: 40 });
  const csv = dm.exportMatchesCSV();
  const p = V.parseImport(csv);
  assert.ok(p.ok);
  const r = V.validateMatchRows(p.rows, { today: new Date('2026-11-01') });
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid.length, dm.listMatches().length);
});

test('API: success mapping, 90-minute score, errors, retries, secret guard', async () => {
  const payload = { matches: [
    { id: 1, utcDate: '2024-09-17T19:00:00Z', status: 'FINISHED', stage: 'LEAGUE_STAGE', season: { startDate: '2024-09-01' }, homeTeam: { name: 'A', formation: '4-3-3', lineup: [{ name: 'Home player' }], statistics: { shots: 11, shots_on_goal: 4 } }, awayTeam: { name: 'B', formation: '4-4-2', lineup: [{ name: 'Away player' }], statistics: { shots: 8, shots_on_goal: 3 } }, odds: { homeWin: 2.1, draw: 3.5, awayWin: 3.6 }, score: { duration: 'REGULAR', fullTime: { home: 2, away: 1 } } },
    { id: 2, utcDate: '2025-04-10T19:00:00Z', status: 'FINISHED', stage: 'QUARTER_FINALS', season: { startDate: '2024-09-01' }, homeTeam: { name: 'C' }, awayTeam: { name: 'D' }, score: { duration: 'EXTRA_TIME', fullTime: { home: 3, away: 2 }, regularTime: { home: 2, away: 2 } } },
    { id: 3, utcDate: '2026-12-01T19:00:00Z', status: 'TIMED', homeTeam: { name: 'E' }, awayTeam: { name: 'F' }, score: {} },
    { id: 4, status: 'FINISHED' },
  ] };
  let requestHeaders;
  const ok = new ApiClient({ baseUrl: 'https://proxy.test', fetchImpl: async (_url, options) => { requestHeaders = options.headers; return { ok: true, status: 200, json: async () => payload }; } });
  const r = await ok.fetchMatches(2024);
  assert.ok(r.ok); assert.equal(r.data.rows.length, 3); assert.equal(r.data.dropped.length, 1);
  assert.equal(r.data.rows[1].homeGoals, 2); assert.equal(r.data.rows[1].awayGoals, 2);
  assert.equal(r.data.rows[0].season, '2024-25');
  assert.equal(r.data.rows[0].oddsH, 2.1); assert.equal(r.data.rows[0].oddsD, 3.5); assert.equal(r.data.rows[0].oddsA, 3.6);
  assert.equal(r.data.rows[0].homeShots, 11); assert.equal(r.data.rows[0].awaySot, 3);
  assert.equal(r.data.contexts.length, 1); assert.equal(r.data.contexts[0].fields.homeLineup.status, 'expected');
  assert.equal(r.data.contexts[0].fields.awayFormation, '4-4-2'); assert.equal(requestHeaders['X-Unfold-Lineups'], 'true');
  assert.equal(r.data.rows[2].status, 'scheduled');
  assert.equal(mapFootballDataMatch({ utcDate: '2024-09-17', homeTeam: { name: 'A' }, awayTeam: { name: 'B' } }), null);
  assert.equal(mapFootballDataContext({ id: 9, utcDate: '2024-09-17', homeTeam: { name: 'A' }, awayTeam: { name: 'B' } }), null);
  assert.equal(mapFootballDataContext({ utcDate: '2024-09-17', homeTeam: { name: 'A', lineup: [{ name: 'A1' }] }, awayTeam: { name: 'B' } }), null);

  const mk = (status, headers) => new ApiClient({ baseUrl: 'https://p.test', retries: 0, sleep: async () => {}, fetchImpl: async () => ({ ok: false, status, headers: { get: (h) => (headers || {})[h] }, json: async () => ({}) }) });
  assert.equal((await mk(403).fetchMatches(2024)).error.type, 'auth');
  assert.equal((await mk(404).fetchMatches(2024)).error.type, 'not_found');
  assert.equal((await mk(429).fetchMatches(2024)).error.type, 'rate_limit');
  assert.equal((await mk(500).fetchMatches(2024)).error.type, 'server');

  let calls = 0;
  const flaky = new ApiClient({ baseUrl: 'https://p.test', retries: 2, sleep: async () => {}, fetchImpl: async () => { calls++; if (calls < 3) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ matches: [] }) }; } });
  assert.ok((await flaky.fetchMatches(2024)).ok); assert.equal(calls, 3);
  const down = new ApiClient({ baseUrl: 'https://p.test', retries: 1, sleep: async () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await down.fetchMatches(2024)).error.type, 'network');
  const badJson = new ApiClient({ baseUrl: 'https://p.test', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }) });
  assert.equal((await badJson.fetchMatches(2024)).error.type, 'parse');
  assert.equal((await badJson.fetchStandings(2024)).error.type, 'parse');
  assert.equal((await new ApiClient({}).fetchMatches(2024)).error.type, 'config');
  assert.equal((await new ApiClient({ baseUrl: 'https://x.test/?apiKey=SECRET', fetchImpl: async () => { throw new Error('must not be called'); } }).fetchMatches(2024)).error.type, 'config');
  assert.equal(mapFootballDataMatch(null), null);
});

test('backtest: chronological split, no leakage, deterministic, pre-match view hides results', async () => {
  const { dm } = loadedDM({ seed: 21, seasons: 6, matchesPerSeason: 125, withOdds: true });
  const all = dm.listMatches();
  const cfg = { calibration: { minSamples: 150 } };
  const a = await BT.walkForward(all, { config: cfg, today: new Date('2026-11-01') });
  assert.equal(a.status, 'COMPLETE');
  assert.equal(a.audit.violations, 0);
  assert.ok(a.audit.checks === a.audit.groups && a.audit.groups > 50);
  assert.equal(a.seasonSelection.seasons.length, 5);
  // first scored match must not be in the earliest part with too little history
  assert.ok(a.records.every((r) => r.nTrain >= 60));
  // every record's training size equals the number of matches strictly before its day
  const fin = all.filter((m) => m.status === 'finished');
  for (const r of a.records.slice(0, 40).concat(a.records.slice(-40))) {
    const before = fin.filter((m) => m.date.slice(0, 10) < r.date.slice(0, 10)).length;
    assert.equal(r.nTrain, before);
  }
  const b = await BT.walkForward(all, { config: cfg, today: new Date('2026-11-01') });
  assert.equal(a.datasetFingerprint, b.datasetFingerprint);
  assert.deepEqual(a.records.map((r) => r.pick), b.records.map((r) => r.pick));
  assert.equal(a.summary.series.model.accuracy, b.summary.series.model.accuracy);
  const v = BT.preMatchView(all.find((m) => m.status === 'finished'));
  assert.equal(v.homeGoals, undefined); assert.equal(v.oddsH, undefined); assert.equal(v.homeXg, undefined);
  assert.throws(() => BT.assertNoLeakage([{ id: 'x', date: '2024-05-01' }], '2024-05-01'), /LEAKAGE/);
  // probabilities valid, benchmark present
  assert.ok(a.records.every((r) => Math.abs(r.p.H + r.p.D + r.p.A - 1) < 1e-9));
  assert.ok(a.summary.bookmaker && a.summary.bookmaker.n > 100);
  assert.ok(Math.abs(a.summary.series.model.confusion.H.H + a.summary.series.model.confusion.H.D + a.summary.series.model.confusion.H.A - a.summary.series.model.perClass.H.n) < 1e-9);
});

test('backtest: changing a FUTURE result does not change earlier predictions (leak test)', async () => {
  const { dm } = loadedDM({ seed: 33, seasons: 6, matchesPerSeason: 125 });
  const all = dm.listMatches();
  const cfg = { calibration: { enabled: false } };
  const base = await BT.walkForward(all, { config: cfg, today: new Date('2026-11-01') });
  const last = base.records[base.records.length - 1];
  const tweaked = all.map((m) => (m.id === last.id ? { ...m, homeGoals: m.homeGoals + 5 } : m));
  const alt = await BT.walkForward(tweaked, { config: cfg, today: new Date('2026-11-01') });
  const n = base.records.length - 1;
  for (let i = 0; i < n; i++) assert.deepEqual(base.records[i].p, alt.records[i].p, 'prediction ' + i + ' changed');
});

test('backtest: insufficient data is reported, not faked', async () => {
  const none = await BT.walkForward([], {});
  assert.equal(none.status, 'BACKTEST DATA INSUFFICIENT');
  const { dm } = loadedDM({ seed: 4, seasons: 2, matchesPerSeason: 30 });
  const small = await BT.walkForward(dm.listMatches(), { today: new Date('2026-11-01') });
  assert.equal(small.status, 'BACKTEST DATA INSUFFICIENT');
  assert.match(BT.validationFromBacktest(small).status, /NOT VALIDATED/);
  assert.match(BT.validationFromBacktest(null).status, /NOT VALIDATED/);
});

test('backtest: incomplete season (missing results) is rejected', () => {
  const { dm } = loadedDM({ seed: 8, seasons: 3, matchesPerSeason: 125 });
  const all = dm.listMatches().map((m, i) => (m.season === '2020-21' && i % 7 === 0 ? { ...m, status: 'scheduled', homeGoals: null, awayGoals: null } : m));
  const sel = BT.selectSeasons(all, { today: new Date('2026-11-01') });
  assert.ok(!sel.seasons.some((s) => s.season === '2020-21'));
  assert.ok(sel.rejected.some((r) => r.season === '2020-21' && /without a result/.test(r.reason)));
});

test('analysis: one decision, probabilities sum to 100, no look-ahead, missing data flagged', async () => {
  const { dm } = loadedDM({ seed: 12, seasons: 4, matchesPerSeason: 125 });
  const all = dm.listMatches();
  const target = all.filter((m) => m.season === '2020-21')[60];
  const a = AE.analyzeFixture({ match: target, matches: all, config: {}, backtest: null, context: { fields: {}, meta: {} }, meta: {}, now: '2026-11-01T00:00:00Z' });
  assert.ok(['H', 'D', 'A'].includes(a.final.pick));
  assert.equal(a.final.symbol, S.SYMBOL[a.final.pick]);
  assert.ok(Math.abs(a.final.percentages.reduce((x, y) => x + y, 0) - 100) < 1e-9);
  assert.equal(a.final.pick, S.argmaxOutcome(a.final.probs));
  const before = all.filter((m) => m.status === 'finished' && m.date.slice(0, 10) < target.date.slice(0, 10)).length;
  assert.equal(a.nTrain, before);
  assert.match(a.validation.status, /NOT VALIDATED/);
  assert.notEqual(a.final.confidence.label, 'High');
  assert.ok(a.dataQuality.items.some((i) => i.key === 'injuries' && i.status === 'missing'));
  assert.ok(a.dataQuality.items.some((i) => i.key === 'xg' && i.status === 'missing'));
  assert.equal(a.teams.home.profile.xg, null);
  assert.equal(a.bookmaker, null);
});

test('confidence: 40% favourite with small gap is Low; strong separation not auto-High without validation', () => {
  const comp = { dc: { H: 0.4, D: 0.3, A: 0.3 }, elo: { H: 0.4, D: 0.3, A: 0.3 } };
  const low = AE.computeConfidence({ probs: { H: 0.4, D: 0.32, A: 0.28 }, components: comp, dataScore: 1, validation: { score: 1, validated: true } });
  assert.equal(low.label, 'Low');
  const strong = AE.computeConfidence({ probs: { H: 0.7, D: 0.2, A: 0.1 }, components: { dc: { H: 0.7, D: 0.2, A: 0.1 }, elo: { H: 0.68, D: 0.2, A: 0.12 } }, dataScore: 1, validation: { score: 0, validated: false } });
  assert.notEqual(strong.label, 'High');
  const hi = AE.computeConfidence({ probs: { H: 0.7, D: 0.2, A: 0.1 }, components: { dc: { H: 0.7, D: 0.2, A: 0.1 }, elo: { H: 0.68, D: 0.2, A: 0.12 } }, dataScore: 1, validation: { score: 1, validated: true } });
  assert.equal(hi.label, 'High');
});

test('prediction history: immutable, timing-checked, evaluation does not alter prediction', () => {
  const be = new MemoryStorage();
  let clock = '2026-11-01T10:00:00Z';
  const h = new PredictionHistory(Store.createStorage(be), { now: () => clock });
  const { dm } = loadedDM({ seed: 5, seasons: 3, matchesPerSeason: 100 });
  const all = dm.listMatches();
  const target = { ...all.filter((m) => m.season === '2019-20')[80], date: '2026-11-05T20:00:00Z', status: 'scheduled', homeGoals: null, awayGoals: null, id: 'fx1' };
  const an = AE.analyzeFixture({ match: target, matches: all, config: {}, backtest: null, context: { fields: {}, meta: {} }, meta: {}, now: clock });
  const r = h.create(target, an);
  assert.ok(r.ok); assert.equal(r.prediction.timing, 'pre-match');
  assert.throws(() => { 'use strict'; r.prediction.pick = 'A'; });
  const snapshot = JSON.stringify(h.state.predictions[0]);
  clock = '2026-11-06T09:00:00Z';
  const ev = h.evaluate('fx1', 3, 0);
  assert.ok(ev.ok); assert.equal(ev.evaluation.result.outcome, 'H');
  assert.equal(JSON.stringify(h.state.predictions[0]), snapshot, 'original prediction unchanged');
  assert.equal(ev.evaluation.correct, r.prediction.pick === 'H');
  assert.ok(Math.abs(ev.evaluation.brier - S.brierScore(r.prediction.probs, 'H')) < 1e-12);
  assert.equal(h.create(target, an).ok, false, 'no new prediction after evaluation');
  // post-kickoff prediction is flagged and excluded
  const h2 = new PredictionHistory(Store.createStorage(new MemoryStorage()), { now: () => '2026-11-05T21:00:00Z' });
  const late = h2.create(target, an);
  assert.equal(late.prediction.timing, 'post-kickoff');
  assert.equal(h2.evaluate('fx1', 1, 1).ok, false);
  // finished match cannot get a new prediction
  assert.equal(h2.create({ ...target, status: 'finished' }, an).ok, false);
  // reload persistence
  const h3 = new PredictionHistory(Store.createStorage(be)).load();
  assert.equal(h3.all().length, 1); assert.equal(h3.stats().summary.n, 1);
  assert.match(h3.exportCSV(), /predictionId/);
});
