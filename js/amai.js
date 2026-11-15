/* AMAI client: sends only a compact match-analysis context through the configured secure proxy. */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});

  function contextFromAnalysis(a, context) {
    const fields = (context && context.fields) || {};
    const team = (side) => {
      const t = a.teams[side], p = t.profile || {};
      const lineup = fields[side + 'Lineup'] || t.lineup || null;
      const people = (items) => (Array.isArray(items) ? items : []).filter((x) => x && x.name).map((x) => String(x.name).slice(0, 80)).slice(0, 12);
      return {
        name: t.name,
        elo: t.elo,
        attackIndex: t.attack,
        defenceIndex: t.defence,
        matchesInHistory: p.n,
        record: p.overall ? { wins: p.overall.w, draws: p.overall.d, losses: p.overall.l, goalsForPerMatch: p.overall.gf, goalsAgainstPerMatch: p.overall.ga } : null,
        recentForm: (p.last5 || []).map((r) => ({ result: r.res, score: r.score, opponent: r.opp, home: r.home, date: r.date })),
        formPoints: p.formPoints,
        xg: p.xg || null,
        shots: p.shots ? { perGame: p.shots.perGame, onTargetPerGame: p.shots.sotPerGame } : null,
        formation: fields[side + 'Formation'] || t.formation || null,
        lineup: lineup ? { status: lineup.status || 'unknown', players: (lineup.players || []).slice(0, 18) } : null,
        injuries: people(fields[side + 'Injuries'] || t.injuries),
        suspensions: people(fields[side + 'Suspensions'] || t.suspensions),
      };
    };
    return {
      match: { home: a.match.home, away: a.match.away, date: a.match.date, stage: a.match.stage, season: a.match.season, venue: a.match.venue, neutral: a.match.neutral },
      prediction: { pick: a.final.label, probabilities: a.final.probs, confidence: a.final.confidence.label, expectedGoals: a.final.expectedGoals },
      teams: { home: team('home'), away: team('away') },
      factors: (a.final.factors || []).map((x) => ({ name: x.name, detail: x.detail })),
      modelEvidence: (a.final.evidence || []).slice(0, 5),
      dataQuality: (a.dataQuality.items || []).slice(0, 16).map((x) => ({ label: x.label, value: x.value, status: x.status, source: x.source, note: x.note })),
      validation: a.validation ? a.validation.status : 'not available',
      bookmakerBenchmark: a.bookmaker ? a.bookmaker.probs : null,
      headToHead: a.h2h ? { meetings: a.h2h.n, homeWins: a.h2h.homeWins, draws: a.h2h.draws, awayWins: a.h2h.awayWins, recent: (a.h2h.last || []).slice(0, 4) } : null,
      limitation: 'This is an explanation of the existing statistical model, not a replacement prediction. Missing inputs remain missing.',
    };
  }

  async function respond(baseUrl, payload) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'Set the AMAI proxy URL in Settings first.' };
    if (!/^https?:\/\//i.test(base) || (NS.api && NS.api.ApiClient.looksLikeSecret(base))) return { ok: false, error: 'Use a secure proxy URL without API keys or credentials.' };
    if (!global.fetch) return { ok: false, error: 'This browser does not support secure requests.' };
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timer = controller ? global.setTimeout(() => controller.abort(), 35000) : null;
    try {
      const response = await global.fetch(base + '/amai/respond', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
      let data;
      try { data = await response.json(); } catch (_) { return { ok: false, error: 'The AMAI proxy returned an unreadable response.' }; }
      if (!response.ok) return { ok: false, error: data && data.error ? data.error : `AMAI request failed (${response.status}).` };
      if (!data || typeof data.answer !== 'string' || !data.answer.trim()) return { ok: false, error: 'AMAI returned an empty answer.' };
      return { ok: true, answer: data.answer.trim(), model: data.model || null };
    } catch (error) {
      const timedOut = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      return { ok: false, error: timedOut ? 'AMAI took too long to respond. Try again.' : 'Could not reach the AMAI proxy. Check the URL and network.' };
    } finally {
      if (timer) global.clearTimeout(timer);
    }
  }

  NS.amai = { contextFromAnalysis, respond };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.amai;
})(typeof window !== 'undefined' ? window : globalThis);
