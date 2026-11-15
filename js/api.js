/**
 * api.js — provider client for API mode. NEVER holds a secret key.
 *
 * A frontend-only app cannot protect a secret API key: anything in browser JavaScript is readable by every
 * visitor. Therefore this client talks to a URL you control (a "proxy base URL") that injects the secret
 * server-side. See /proxy/worker.js for a ready-to-deploy Cloudflare Worker and the README.
 *
 * All methods return {ok:true, data} or {ok:false, error:{type,status,message}} and never throw.
 * Error types: config | network | timeout | auth | rate_limit | not_found | server | parse | http
 *
 * The football-data.org v4 mapper below follows that API's documented response shape. It has been unit-tested
 * against payloads of that shape but NOT against the live service (no network in the build environment).
 * The basic/free provider tier does not supply xG, odds, injuries or lineups. Eligible plans may return odds,
 * team shot statistics and lineups; xG and injury inputs still need a trusted CSV/JSON source or manual entry.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const V = isNode ? require('./validation.js') : NS.validation;

  const STAGE_LABELS = {
    GROUP_STAGE: 'Group Stage', LEAGUE_STAGE: 'League Phase', PLAYOFFS: 'Knockout Play-offs', LAST_16: 'Round of 16',
    QUARTER_FINALS: 'Quarter-finals', SEMI_FINALS: 'Semi-finals', FINAL: 'Final',
    QUALIFYING: 'Qualifying', PRELIMINARY_ROUND: 'Preliminary Round',
  };
  const CAPABILITIES = {
    'football-data': { fixtures: true, results: true, standings: true, teams: true, xg: false, odds: true, injuries: false, lineups: true },
    custom: { fixtures: true, results: true, standings: false, teams: true, xg: true, odds: true, injuries: true, lineups: true },
  };

  /** Map one football-data.org v4 match object to a raw import row (validated later like any other row). */
  function mapFootballDataMatch(m) {
    if (!m || m.id === null || m.id === undefined || !m.homeTeam || !m.awayTeam || !m.utcDate) return null;
    const st = String(m.status || '').toUpperCase();
    const status = st === 'FINISHED' || st === 'AWARDED' ? 'finished' : ['IN_PLAY', 'PAUSED', 'LIVE'].includes(st) ? 'live' : ['POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(st) ? 'postponed' : 'scheduled';
    const score = m.score || {};
    // 1X2 is modelled on the 90-minute result. fullTime includes extra time in v4, so prefer regularTime then.
    let h = null, a = null;
    if (status === 'finished') {
      const reg = score.duration && score.duration !== 'REGULAR' ? score.regularTime : score.fullTime;
      if (reg && Number.isInteger(reg.home) && Number.isInteger(reg.away)) { h = reg.home; a = reg.away; }
    }
    const season = m.season && m.season.startDate ? V.deriveSeason(m.season.startDate) : null;
    const row = {
      id: 'fd-' + m.id, season, date: m.utcDate, stage: STAGE_LABELS[m.stage] || m.stage || null,
      homeName: m.homeTeam.name || m.homeTeam.shortName, awayName: m.awayTeam.name || m.awayTeam.shortName,
      homeGoals: h, awayGoals: a, neutral: m.stage === 'FINAL', venue: m.venue || null,
      status: status === 'finished' && h === null ? 'scheduled' : status,
      _dropReason: status === 'finished' && h === null ? 'finished match without a usable 90-minute score' : undefined,
    };
    const addNumber = (key, value) => { if (typeof value === 'number' && Number.isFinite(value)) row[key] = value; };
    const odds = m.odds || {};
    addNumber('oddsH', odds.homeWin); addNumber('oddsD', odds.draw); addNumber('oddsA', odds.awayWin);
    const homeStats = m.homeTeam.statistics || {}, awayStats = m.awayTeam.statistics || {};
    addNumber('homeShots', homeStats.shots); addNumber('awayShots', awayStats.shots);
    addNumber('homeSot', homeStats.shots_on_goal); addNumber('awaySot', awayStats.shots_on_goal);
    return row;
  }

  /** Optional match context from football-data.org responses; absent/unfolded data stays absent. */
  function mapFootballDataContext(m) {
    if (!m || m.id === null || m.id === undefined || !m.homeTeam || !m.awayTeam || !m.utcDate) return null;
    const fields = {};
    for (const side of ['home', 'away']) {
      const team = m[side + 'Team'] || {};
      const lineup = Array.isArray(team.lineup) ? team.lineup.map((p) => p && typeof p.name === 'string' ? p.name.trim() : '').filter(Boolean) : [];
      if (lineup.length) fields[side + 'Lineup'] = { status: lineup.length >= 11 ? 'confirmed' : 'expected', players: lineup };
      if (typeof team.formation === 'string' && team.formation.trim()) fields[side + 'Formation'] = team.formation.trim();
    }
    if (!Object.keys(fields).length) return null;
    return { id: 'fd-' + m.id, date: m.utcDate, homeName: m.homeTeam.name || m.homeTeam.shortName, awayName: m.awayTeam.name || m.awayTeam.shortName, fields };
  }

  class ApiClient {
    /**
     * @param cfg {provider, baseUrl, timeoutMs, retries, fetchImpl, sleep}
     * baseUrl: your proxy (e.g. https://ucl-proxy.example.workers.dev). Must NOT contain credentials.
     */
    constructor(cfg = {}) {
      this.provider = cfg.provider || 'football-data';
      this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
      this.timeoutMs = cfg.timeoutMs ?? 12000;
      this.retries = cfg.retries ?? 2;
      this.fetchImpl = cfg.fetchImpl || (typeof fetch === 'function' ? fetch.bind(global) : null);
      this.sleep = cfg.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    capabilities() { return CAPABILITIES[this.provider] || CAPABILITIES.custom; }

    static looksLikeSecret(url) {
      return /([?&](api[_-]?key|token|apikey|access_token|x-auth-token)=)|:\/\/[^/]*:[^@/]*@/i.test(url || '');
    }

    async request(path, params = {}, extraHeaders = {}) {
      if (!this.baseUrl) return { ok: false, error: { type: 'config', message: 'No proxy base URL configured (Settings → Data provider).' } };
      if (ApiClient.looksLikeSecret(this.baseUrl)) return { ok: false, error: { type: 'config', message: 'The base URL appears to contain a secret key. Put secrets in the server-side proxy, never in this app.' } };
      if (!this.fetchImpl) return { ok: false, error: { type: 'config', message: 'fetch() is not available in this environment.' } };
      const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const url = this.baseUrl + path + (qs ? '?' + qs : '');
      let last;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
        try {
          const res = await this.fetchImpl(url, { method: 'GET', headers: Object.assign({ Accept: 'application/json' }, extraHeaders), signal: ctl ? ctl.signal : undefined });
          if (timer) clearTimeout(timer);
          if (res.ok) {
            let data;
            try { data = await res.json(); } catch (e) { return { ok: false, error: { type: 'parse', status: res.status, message: 'Provider returned invalid JSON.' } }; }
            return { ok: true, data };
          }
          const retryAfter = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
          if (res.status === 401 || res.status === 403) return { ok: false, error: { type: 'auth', status: res.status, message: 'Provider/proxy rejected the request (check the proxy’s secret key and plan access).' } };
          if (res.status === 404) return { ok: false, error: { type: 'not_found', status: 404, message: 'Endpoint or season not found.' } };
          if (res.status === 429) last = { type: 'rate_limit', status: 429, message: 'Rate limit reached — wait a minute and retry.', retryAfter };
          else if (res.status >= 500) last = { type: 'server', status: res.status, message: `Provider error (${res.status}).` };
          else return { ok: false, error: { type: 'http', status: res.status, message: `Unexpected HTTP ${res.status}.` } };
          if (attempt < this.retries) await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * Math.pow(2, attempt));
        } catch (e) {
          if (timer) clearTimeout(timer);
          const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
          last = aborted ? { type: 'timeout', message: `Request timed out after ${this.timeoutMs} ms.` } : { type: 'network', message: 'Network error (offline, blocked by CORS, or proxy unreachable).' };
          if (attempt < this.retries) await this.sleep(500 * Math.pow(2, attempt));
        }
      }
      return { ok: false, error: last };
    }

    /** Fixtures + results for a season. `season` is the start year (2024 = 2024-25). */
    async fetchMatches(season) {
      const path = this.provider === 'football-data' ? '/v4/competitions/CL/matches' : '/matches';
      const r = await this.request(path, { season }, this.provider === 'football-data' ? { 'X-Unfold-Lineups': 'true' } : {});
      if (!r.ok) return r;
      const raw = Array.isArray(r.data) ? r.data : r.data && r.data.matches;
      if (!Array.isArray(raw)) return { ok: false, error: { type: 'parse', message: 'Response has no "matches" array.' } };
      const rows = [], contexts = [], dropped = [];
      for (const m of raw) {
        const row = this.provider === 'football-data' ? mapFootballDataMatch(m) : m;
        if (!row) { dropped.push('malformed match object'); continue; }
        if (this.provider === 'football-data') { const context = mapFootballDataContext(m); if (context) contexts.push(context); }
        if (row._dropReason) dropped.push(`${row.id}: ${row._dropReason}`);
        delete row._dropReason;
        rows.push(row);
      }
      return { ok: true, data: { rows, contexts, dropped, fetchedAt: new Date().toISOString(), season } };
    }

    async fetchStandings(season) {
      if (!this.capabilities().standings) return { ok: false, error: { type: 'config', message: 'Standings not supported by this provider.' } };
      const r = await this.request('/v4/competitions/CL/standings', { season });
      if (!r.ok) return r;
      const tables = (r.data.standings || []).filter((s) => s.type === 'TOTAL').map((s) => ({
        group: s.group || s.stage || null,
        table: (s.table || []).map((t) => ({ position: t.position, team: t.team && t.team.name, played: t.playedGames, won: t.won, draw: t.draw, lost: t.lost, gf: t.goalsFor, ga: t.goalsAgainst, points: t.points })),
      }));
      return { ok: true, data: { tables, fetchedAt: new Date().toISOString() } };
    }

    async fetchTeams(season) {
      if (!this.capabilities().teams) return { ok: false, error: { type: 'config', message: 'Teams not supported by this provider.' } };
      const r = await this.request('/v4/competitions/CL/teams', { season });
      if (!r.ok) return r;
      return { ok: true, data: { teams: (r.data.teams || []).map((t) => ({ name: t.name, short: t.shortName || t.tla || null, country: t.area && t.area.name })) , fetchedAt: new Date().toISOString() } };
    }
  }

  const api = { ApiClient, mapFootballDataMatch, mapFootballDataContext, CAPABILITIES, STAGE_LABELS };
  NS.api = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
