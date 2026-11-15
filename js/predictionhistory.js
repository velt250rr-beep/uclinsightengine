/**
 * predictionhistory.js — immutable store of pre-match predictions and their post-match evaluations.
 *
 *  - A prediction record is frozen when created and can never be modified or deleted through this API.
 *  - Evaluations are SEPARATE records that reference the prediction; evaluating never touches the prediction.
 *  - Timing integrity: a prediction counts as "pre-match" only if it was created strictly before kickoff.
 *    Date-only fixtures (no kickoff time) count as pre-match only if created on an earlier UTC day.
 *    Anything else is stored for transparency but flagged and EXCLUDED from live accuracy statistics.
 *  - Once a fixture has an evaluation, no further predictions can be created for it.
 *  - The "official" prediction for a fixture is the latest eligible (pre-match) one.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const S = isNode ? require('./statistics.js') : NS.statistics;

  function kickoffInfo(date) {
    const hasTime = /T\d{2}:\d{2}/.test(date);
    return { ts: Date.parse(date), hasTime };
  }

  function classifyTiming(date, createdAtIso) {
    const k = kickoffInfo(date), created = Date.parse(createdAtIso);
    if (isNaN(k.ts) || isNaN(created)) return 'unverified';
    if (k.hasTime) return created < k.ts ? 'pre-match' : 'post-kickoff';
    // date-only: only trust predictions made before that UTC day began
    return created < k.ts ? 'pre-match' : 'unverified-timing';
  }

  class PredictionHistory {
    constructor(storage, opts = {}) {
      this.storage = storage;
      this.now = opts.now || (() => new Date().toISOString());
      this.state = { predictions: [], evaluations: [], discarded: [], seq: 0 };
    }
    load() { const s = this.storage.get('predictions'); if (s && Array.isArray(s.predictions)) this.state = Object.assign({ discarded: [] }, s, { discarded: Array.isArray(s.discarded) ? s.discarded : [] }); return this; }
    save() { return this.storage.set('predictions', this.state); }

    /** Create an immutable prediction from an analysis result. */
    create(match, analysis) {
      if (!match || !analysis || !analysis.final) return { ok: false, error: 'No analysis to store' };
      if (match.status === 'finished') return { ok: false, error: 'Match is already finished — a pre-match prediction can no longer be created.' };
      if (this.evaluationFor(match.id)) return { ok: false, error: 'This fixture has already been evaluated.' };
      const createdAt = this.now();
      const timing = classifyTiming(match.date, createdAt);
      const f = analysis.final;
      const rec = Object.freeze({
        id: 'p' + ++this.state.seq, fixtureId: match.id, createdAt, kickoff: match.date, timing,
        season: match.season, stage: match.stage,
        homeId: match.homeId, awayId: match.awayId, homeName: match.homeName, awayName: match.awayName,
        probs: { ...f.probs }, rawProbs: { ...f.rawProbs }, components: JSON.parse(JSON.stringify(f.components)),
        pick: f.pick, symbol: S.SYMBOL[f.pick], confidence: { ...f.confidence }, expectedGoals: { ...f.expectedGoals },
        topScorelines: f.topScorelines.slice(0, 5), dataQuality: { score: analysis.dataQuality.score, status: analysis.dataQuality.status },
        validationStatus: analysis.validation.status, configVersion: analysis.configVersion, configHash: analysis.configHash, nTrain: analysis.nTrain,
        calibrationActive: !!f.calibrationActive,
      });
      this.state.predictions.push(rec);
      const sv = this.save();
      return sv.ok ? { ok: true, prediction: rec, warning: timing !== 'pre-match' ? `Saved, but flagged "${timing}" — it is excluded from live accuracy statistics.` : undefined } : { ok: false, error: sv.error, prediction: rec };
    }

    forFixture(fixtureId) { return this.state.predictions.filter((p) => p.fixtureId === fixtureId); }
    official(fixtureId) {
      const eligible = this.forFixture(fixtureId).filter((p) => p.timing === 'pre-match' && !this.isDiscarded(p.id));
      return eligible.length ? eligible[eligible.length - 1] : null;
    }
    evaluationFor(fixtureId) {
      const ev = this.state.evaluations.filter((e) => e.fixtureId === fixtureId);
      return ev.length ? ev[ev.length - 1] : null;
    }

    /** Evaluate the official prediction of a fixture against its actual result. Original prediction is untouched. */
    evaluate(fixtureId, homeGoals, awayGoals) {
      const p = this.official(fixtureId);
      if (!p) return { ok: false, error: 'No eligible pre-match prediction exists for this fixture.' };
      if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) return { ok: false, error: 'Invalid result' };
      const outcome = S.outcomeFromScore(homeGoals, awayGoals);
      const prev = this.evaluationFor(fixtureId);
      if (prev && prev.result.homeGoals === homeGoals && prev.result.awayGoals === awayGoals) return { ok: true, evaluation: prev, unchanged: true };
      const ev = Object.freeze({
        id: 'e' + ++this.state.seq, predictionId: p.id, fixtureId, evaluatedAt: this.now(),
        result: { homeGoals, awayGoals, outcome }, pick: p.pick, correct: p.pick === outcome,
        brier: S.brierScore(p.probs, outcome), logLoss: S.logLoss(p.probs, outcome), probOfActual: p.probs[outcome],
        supersedes: prev ? prev.id : null,
      });
      this.state.evaluations.push(ev);
      const sv = this.save();
      return sv.ok ? { ok: true, evaluation: ev } : { ok: false, error: sv.error };
    }

    /** Auto-evaluate every finished match that has an official prediction and no evaluation for its current result. */
    evaluatePending(matches) {
      const done = [];
      for (const m of matches) {
        if (m.status !== 'finished' || !Number.isInteger(m.homeGoals)) continue;
        if (!this.official(m.id)) continue;
        const r = this.evaluate(m.id, m.homeGoals, m.awayGoals);
        if (r.ok && !r.unchanged) done.push(r.evaluation);
      }
      return done;
    }

    /** Latest evaluation per fixture, joined with its prediction, chronological. */
    evaluated() {
      const latest = new Map();
      for (const e of this.state.evaluations) latest.set(e.fixtureId, e);
      return [...latest.values()].map((e) => ({ evaluation: e, prediction: this.state.predictions.find((p) => p.id === e.predictionId) }))
        .filter((x) => x.prediction).sort((a, b) => Date.parse(a.prediction.kickoff) - Date.parse(b.prediction.kickoff));
    }

    /** Live accuracy over evaluated pre-match predictions. */
    stats() {
      const ev = this.evaluated();
      const recs = ev.map((x) => ({ p: x.prediction.probs, outcome: x.evaluation.result.outcome, date: x.prediction.kickoff }));
      const sm = S.summarize(recs);
      // running series for charts
      let c = 0, b = 0, l = 0;
      const series = ev.map((x, i) => { c += x.evaluation.correct ? 1 : 0; b += x.evaluation.brier; l += x.evaluation.logLoss; return { n: i + 1, date: x.prediction.kickoff, accuracy: c / (i + 1), brier: b / (i + 1), logLoss: l / (i + 1) }; });
      return { summary: sm, series, records: recs, calibration: S.calibrationBins(recs, 5), confidence: S.confidenceRanges(recs) };
    }

    isDiscarded(predictionId) { return (this.state.discarded || []).includes(predictionId); }
    discardPending(fixtureId) {
      if (this.evaluationFor(fixtureId)) return { ok: false, error: 'An evaluated prediction cannot be removed from result tracking.' };
      const prediction = this.pending().find((p) => p.fixtureId === fixtureId);
      if (!prediction) return { ok: false, error: 'No pending prediction exists for this fixture.' };
      if (!Array.isArray(this.state.discarded)) this.state.discarded = [];
      this.state.discarded.push(prediction.id);
      const saved = this.save();
      if (!saved.ok) { this.state.discarded.pop(); return { ok: false, error: saved.error }; }
      return { ok: true, prediction };
    }

    pending() {
      const evaluated = new Set(this.state.evaluations.map((e) => e.fixtureId));
      const ids = [...new Set(this.state.predictions.map((p) => p.fixtureId))].filter((id) => !evaluated.has(id));
      return ids.map((id) => {
        const remaining = this.forFixture(id).filter((p) => !this.isDiscarded(p.id));
        return this.official(id) || remaining.slice(-1)[0] || null;
      }).filter(Boolean);
    }
    all() { return this.state.predictions.slice().reverse(); }
    exportJSON() { return JSON.parse(JSON.stringify({ app: 'ucl-match-analyzer', exportedAt: this.now(), ...this.state })); }
    exportCSV() {
      const rows = ['predictionId,fixtureId,createdAt,timing,kickoff,home,away,pHome,pDraw,pAway,pick,confidence,dataQuality,validation,evaluatedResult,correct,brier,logLoss'];
      const evs = new Map(this.state.evaluations.map((e) => [e.predictionId, e]));
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      for (const p of this.state.predictions) {
        const e = evs.get(p.id);
        rows.push([p.id, p.fixtureId, p.createdAt, p.timing, p.kickoff, q(p.homeName), q(p.awayName), p.probs.H.toFixed(4), p.probs.D.toFixed(4), p.probs.A.toFixed(4), p.symbol, p.confidence.label, p.dataQuality.status, q(p.validationStatus),
          e ? `${e.result.homeGoals}-${e.result.awayGoals}` : '', e ? e.correct : '', e ? e.brier.toFixed(4) : '', e ? e.logLoss.toFixed(4) : ''].join(','));
      }
      return rows.join('\n');
    }
    importJSON(json) {
      if (!json || !Array.isArray(json.predictions) || !Array.isArray(json.evaluations)) return { ok: false, error: 'Not a prediction-history backup' };
      this.state = { predictions: json.predictions.map((p) => Object.freeze(p)), evaluations: json.evaluations.map((e) => Object.freeze(e)), discarded: Array.isArray(json.discarded) ? json.discarded : [], seq: json.seq || json.predictions.length + json.evaluations.length };
      return this.save();
    }
  }

  const api = { PredictionHistory, classifyTiming };
  NS.predictionHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
