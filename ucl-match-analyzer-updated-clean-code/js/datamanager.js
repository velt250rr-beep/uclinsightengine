/**
 * datamanager.js — the single source of truth for teams, matches/fixtures, manual contexts and provenance.
 *
 * Hybrid-data rules implemented here:
 *  - Every stored field value carries provenance (source, timestamp, quality) through an import "batch".
 *  - Manual corrections are stored as separate OVERRIDES. A provider/CSV re-import updates the base value
 *    but never replaces an override; when the incoming value differs from a manual override it is recorded
 *    as a visible CONFLICT. Nothing is overwritten silently.
 *  - Matches are de-duplicated by id AND by (date, home, away) so API ids and CSV ids cannot double-count.
 *  - Missing values stay null; they are never defaulted to 0.
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const V = isNode ? require('./validation.js') : NS.validation;

  const FIELDS = ['season', 'date', 'stage', 'homeId', 'awayId', 'homeGoals', 'awayGoals', 'neutral', 'venue', 'status',
    'oddsH', 'oddsD', 'oddsA', 'homeXg', 'awayXg', 'homeShots', 'awayShots', 'homeSot', 'awaySot', 'homeBigChances', 'awayBigChances'];
  const STOP_TOKENS = new Set(['fc', 'cf', 'afc', 'sc', 'ssc', 'ac', 'as', 'sk', 'fk', 'bk', 'if', 'ud', 'sl', 'cd', 'rc', 'ca']);

  /** Team key: accent-free slug with generic club-type tokens removed ("FC Barcelona" == "Barcelona"). */
  function teamKey(name) {
    const toks = V.slug(name).split('-').filter(Boolean);
    const kept = toks.filter((t) => !STOP_TOKENS.has(t));
    return (kept.length ? kept : toks).join('-');
  }

  class DataManager {
    constructor(storage, opts = {}) {
      this.storage = storage;
      this.now = opts.now || (() => new Date().toISOString());
      this.state = this._empty();
      this.lastSaveError = null;
    }

    _empty() { return { schema: 1, teams: {}, matches: {}, batches: {}, batchSeq: 0, conflicts: [], contexts: {}, importLog: [] }; }

    load() {
      const s = this.storage.get('data');
      if (s && s.schema === 1) this.state = Object.assign(this._empty(), s);
      const bundled = NS.data || {};
      const hasBundled = (bundled.historical && bundled.historical.length) || (bundled.fixtures && bundled.fixtures.length);
      // Import the bundled files on first run and whenever their version changes. Imports merge by fixture, so
      // manual corrections are never overwritten (differences become visible conflicts).
      if (hasBundled && this.state.bundleVersion !== (bundled.version || '1')) {
        (bundled.teams || []).forEach((t) => this.upsertTeam(t));
        const rows = [...(bundled.historical || []), ...(bundled.fixtures || [])];
        const res = V.validateMatchRows(rows, { today: new Date(this.now()) });
        this.importMatches(res.valid, { source: 'bundled', quality: 'bundled', label: 'bundled data files v' + (bundled.version || '1') });
        this.state.bundleVersion = bundled.version || '1';
        this.save();
      }
      return this;
    }

    save() {
      const r = this.storage.set('data', this.state);
      this.lastSaveError = r.ok ? null : r.error;
      return r;
    }

    // ---------------------------------------------------------------- teams
    upsertTeam(t) {
      const id = teamKey(t.name || t.id);
      const ex = this.state.teams[id];
      if (ex) { Object.assign(ex, Object.fromEntries(Object.entries(t).filter(([k, v]) => v !== undefined && v !== null && k !== 'id'))); return ex.id; }
      this.state.teams[id] = Object.assign({ aliases: [] }, t, { id, name: t.name || id });
      return id;
    }
    resolveTeam(name) {
      const id = teamKey(name);
      if (!this.state.teams[id]) {
        const aliasOwner = Object.values(this.state.teams).find((t) => (t.aliases || []).map(teamKey).includes(id));
        if (aliasOwner) return aliasOwner.id;
        this.state.teams[id] = { id, name: String(name).trim(), aliases: [] };
      }
      return id;
    }
    teamName(id) { return (this.state.teams[id] && this.state.teams[id].name) || id; }
    teams() { return Object.values(this.state.teams).sort((a, b) => a.name.localeCompare(b.name)); }

    /** Merge duplicate team `fromId` into `toId` (e.g. "PSG" -> "Paris Saint-Germain"). */
    mergeTeams(fromId, toId) {
      if (fromId === toId || !this.state.teams[fromId] || !this.state.teams[toId]) return { ok: false, error: 'Unknown or identical teams' };
      let moved = 0;
      for (const e of Object.values(this.state.matches)) {
        for (const f of ['homeId', 'awayId']) {
          if (e.base[f] === fromId) { e.base[f] = toId; moved++; }
          if (e.overrides[f] && e.overrides[f].value === fromId) e.overrides[f].value = toId;
        }
      }
      const from = this.state.teams[fromId], to = this.state.teams[toId];
      to.aliases = [...new Set([...(to.aliases || []), from.name, fromId, ...(from.aliases || [])])];
      delete this.state.teams[fromId];
      // collapse duplicates created by the merge
      const seen = new Map();
      for (const [id, e] of Object.entries(this.state.matches)) {
        const m = this.effective(e);
        const key = `${(m.date || '').slice(0, 10)}|${m.homeId}|${m.awayId}`;
        if (seen.has(key)) { delete this.state.matches[id]; } else seen.set(key, id);
      }
      this.save();
      return { ok: true, moved };
    }

    // -------------------------------------------------------------- batches
    _batch(source, quality, label) {
      const id = 'b' + ++this.state.batchSeq;
      this.state.batches[id] = { source, quality, label: label || source, timestamp: this.now() };
      return id;
    }

    // -------------------------------------------------------------- matches
    _keyIndex() {
      const idx = new Map();
      for (const [id, e] of Object.entries(this.state.matches)) {
        const m = this.effective(e);
        idx.set(`${(m.date || '').slice(0, 10)}|${m.homeId}|${m.awayId}`, id);
      }
      return idx;
    }

    /**
     * Import validated records (output of validation.validateMatchRows().valid).
     * @returns report {added, updated, unchanged, merged, conflicts, resultChanges, batchId}
     */
    importMatches(records, { source = 'import:csv', quality = 'user-import', label } = {}) {
      const batchId = this._batch(source, quality, label);
      const rep = { added: 0, updated: 0, unchanged: 0, merged: 0, conflicts: 0, resultChanges: [], notes: [], batchId };
      const idx = this._keyIndex();
      for (const rec of records) {
        const homeId = this.resolveTeam(rec.homeName), awayId = this.resolveTeam(rec.awayName);
        const incoming = Object.assign({}, rec, { homeId, awayId });
        const key = `${(rec.date || '').slice(0, 10)}|${homeId}|${awayId}`;
        let id = incoming.id;
        if (!this.state.matches[id] && idx.has(key)) { id = idx.get(key); rep.merged++; }
        let entry = this.state.matches[id];
        if (!entry) {
          entry = this.state.matches[id] = { id, base: {}, src: {}, overrides: {} };
          for (const f of FIELDS) if (incoming[f] !== null && incoming[f] !== undefined) { entry.base[f] = incoming[f]; entry.src[f] = batchId; }
          idx.set(key, id); rep.added++;
          continue;
        }
        let changed = false;
        for (const f of FIELDS) {
          const v = incoming[f];
          if (v === null || v === undefined) continue;
          if (f === 'status' && entry.base.status === 'finished' && v !== 'finished') { rep.notes.push(`${id}: incoming status "${v}" ignored — match already finished`); continue; }
          if (entry.base[f] === v) continue;
          const ov = entry.overrides[f];
          if (ov && ov.value !== v) {
            const dup = this.state.conflicts.find((c) => !c.resolved && c.matchId === id && c.field === f && c.incoming === v);
            if (!dup) { this.state.conflicts.push({ matchId: id, field: f, incoming: v, manual: ov.value, source, timestamp: this.now(), resolved: false }); rep.conflicts++; }
          }
          if ((f === 'homeGoals' || f === 'awayGoals') && entry.base[f] !== undefined) rep.resultChanges.push(id);
          entry.base[f] = v; entry.src[f] = batchId; changed = true;
        }
        if (changed) rep.updated++; else rep.unchanged++;
      }
      rep.resultChanges = [...new Set(rep.resultChanges)];
      this.state.importLog.unshift({ batchId, timestamp: this.now(), source, label: label || source, added: rep.added, updated: rep.updated, conflicts: rep.conflicts });
      this.state.importLog = this.state.importLog.slice(0, 50);
      const sv = this.save();
      if (!sv.ok) rep.saveError = sv.error;
      return rep;
    }

    /** Manual edit of one field -> stored as an override (never touches the provider base value). */
    setOverride(matchId, field, value, note) {
      const e = this.state.matches[matchId];
      if (!e) return { ok: false, error: 'Unknown match' };
      if (!FIELDS.includes(field)) return { ok: false, error: 'Field not editable: ' + field };
      if (e.base[field] === value) delete e.overrides[field];
      else e.overrides[field] = { value, timestamp: this.now(), note: note || '' };
      return this.save();
    }
    clearOverride(matchId, field) {
      const e = this.state.matches[matchId];
      if (!e) return { ok: false, error: 'Unknown match' };
      delete e.overrides[field];
      return this.save();
    }
    /** Enter/correct a final result by hand (validated). */
    setManualResult(matchId, homeGoals, awayGoals) {
      const e = this.state.matches[matchId];
      if (!e) return { ok: false, error: 'Unknown match' };
      const ok = (v) => Number.isInteger(v) && v >= 0 && v <= 20;
      if (!ok(homeGoals) || !ok(awayGoals)) return { ok: false, error: 'Goals must be integers between 0 and 20' };
      const m = this.effective(e);
      if (Date.parse(m.date) > Date.parse(this.now()) + 36 * 3600e3) return { ok: false, error: 'Cannot record a result for a match in the future' };
      for (const [f, v] of [['homeGoals', homeGoals], ['awayGoals', awayGoals], ['status', 'finished']]) {
        if (e.base[f] === v) delete e.overrides[f]; else e.overrides[f] = { value: v, timestamp: this.now(), note: 'manual result' };
      }
      return this.save();
    }
    /** Record several final scores atomically after validating every row. */
    setManualResults(results) {
      if (!Array.isArray(results) || !results.length) return { ok: false, error: 'Enter at least one complete result.' };
      const timestamp = this.now(), nowMs = Date.parse(timestamp), seen = new Set(), updates = [];
      const validGoals = (v) => Number.isInteger(v) && v >= 0 && v <= 20;
      for (const row of results) {
        if (!row || seen.has(row.matchId)) return { ok: false, error: 'A match appears more than once in this batch.' };
        seen.add(row.matchId);
        const entry = this.state.matches[row.matchId];
        if (!entry) return { ok: false, error: 'Unknown match: ' + row.matchId };
        if (!validGoals(row.homeGoals) || !validGoals(row.awayGoals)) return { ok: false, error: 'Goals must be integers between 0 and 20.' };
        const match = this.effective(entry);
        if (Date.parse(match.date) > nowMs + 36 * 3600e3) return { ok: false, error: 'Cannot record a result for a match in the future: ' + match.homeName + ' v ' + match.awayName };
        updates.push({ entry, homeGoals: row.homeGoals, awayGoals: row.awayGoals });
      }
      const snapshots = updates.map(({ entry }) => ({ entry, overrides: JSON.parse(JSON.stringify(entry.overrides || {})) }));
      for (const { entry, homeGoals, awayGoals } of updates) {
        entry.overrides = entry.overrides || {};
        for (const [field, value] of [['homeGoals', homeGoals], ['awayGoals', awayGoals], ['status', 'finished']]) {
          if (entry.base[field] === value) delete entry.overrides[field];
          else entry.overrides[field] = { value, timestamp, note: 'manual result' };
        }
      }
      const saved = this.save();
      if (!saved.ok) {
        snapshots.forEach(({ entry, overrides }) => { entry.overrides = overrides; });
        return saved;
      }
      return { ok: true, count: updates.length };
    }
    /** Create a match by hand from a validated record. */
    addManualMatch(record) {
      return this.importMatches([record], { source: 'manual', quality: 'manual', label: 'manual entry' });
    }
    deleteMatch(id) { delete this.state.matches[id]; delete this.state.contexts[id]; this.save(); }

    resolveConflict(index, choice) {
      const c = this.state.conflicts[index];
      if (!c || c.resolved) return { ok: false, error: 'Conflict not found' };
      const e = this.state.matches[c.matchId];
      if (choice === 'accept-incoming' && e) delete e.overrides[c.field];
      c.resolved = true; c.resolution = choice; c.resolvedAt = this.now();
      return this.save();
    }
    openConflicts() { return this.state.conflicts.map((c, i) => ({ ...c, index: i })).filter((c) => !c.resolved); }

    effective(entry) {
      const m = {};
      for (const f of FIELDS) m[f] = entry.base[f] !== undefined ? entry.base[f] : null;
      const manualFields = [];
      for (const [f, o] of Object.entries(entry.overrides)) { m[f] = o.value; manualFields.push(f); }
      m.id = entry.id;
      m.homeName = this.teamName(m.homeId); m.awayName = this.teamName(m.awayId);
      m.manualFields = manualFields;
      if (m.neutral === null) m.neutral = false;
      return m;
    }
    getMatch(id) { const e = this.state.matches[id]; return e ? this.effective(e) : null; }

    provenanceOf(id, field) {
      const e = this.state.matches[id];
      if (!e) return null;
      const ov = e.overrides[field];
      if (ov) return { field, value: ov.value, origin: 'manual', source: 'manual', quality: 'manual', timestamp: ov.timestamp, overridden: true, baseValue: e.base[field] ?? null };
      if (e.base[field] === undefined || e.base[field] === null) return { field, value: null, origin: 'missing', source: null, quality: 'missing', timestamp: null, overridden: false };
      const b = this.state.batches[e.src[field]] || {};
      return { field, value: e.base[field], origin: b.source || 'unknown', source: b.source, quality: b.quality || 'unknown', timestamp: b.timestamp || null, overridden: false };
    }

    listMatches(f = {}) {
      const q = (f.q || '').trim().toLowerCase();
      let out = Object.values(this.state.matches).map((e) => this.effective(e));
      if (f.status) out = out.filter((m) => m.status === f.status);
      if (f.season) out = out.filter((m) => m.season === f.season);
      if (f.stage) out = out.filter((m) => m.stage === f.stage);
      if (f.teamId) out = out.filter((m) => m.homeId === f.teamId || m.awayId === f.teamId);
      if (f.from) out = out.filter((m) => m.date.slice(0, 10) >= f.from);
      if (f.to) out = out.filter((m) => m.date.slice(0, 10) <= f.to);
      if (q) out = out.filter((m) => `${m.homeName} ${m.awayName} ${m.stage || ''} ${m.venue || ''} ${m.season || ''}`.toLowerCase().includes(q));
      return out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
    }
    finishedMatches() {
      return this.listMatches({ status: 'finished' }).filter((m) => Number.isInteger(m.homeGoals) && Number.isInteger(m.awayGoals));
    }
    seasons() { return [...new Set(Object.values(this.state.matches).map((e) => this.effective(e).season).filter(Boolean))].sort(); }
    stages() { return [...new Set(Object.values(this.state.matches).map((e) => this.effective(e).stage).filter(Boolean))].sort(); }

    // -------------------------------------------------------------- manual context (injuries, lineups …)
    getContext(matchId) { return this.state.contexts[matchId] || { fields: {}, meta: {} }; }
    setContext(matchId, patch, source = 'manual') {
      const c = (this.state.contexts[matchId] = this.state.contexts[matchId] || { fields: {}, meta: {} });
      for (const [k, v] of Object.entries(patch)) { c.fields[k] = v; c.meta[k] = { source, timestamp: this.now() }; }
      return this.save();
    }
    setContextFromProvider(matchId, patch, source = 'api') {
      const c = (this.state.contexts[matchId] = this.state.contexts[matchId] || { fields: {}, meta: {} });
      for (const [k, v] of Object.entries(patch || {})) {
        if (c.meta[k] && c.meta[k].source === 'manual') continue;
        if (JSON.stringify(c.fields[k]) === JSON.stringify(v)) continue;
        c.fields[k] = v; c.meta[k] = { source, timestamp: this.now() };
      }
      return this.save();
    }

    // -------------------------------------------------------------- reporting / export
    summary() {
      const ms = Object.values(this.state.matches).map((e) => this.effective(e));
      const finished = ms.filter((m) => m.status === 'finished');
      const bySeason = {};
      for (const m of ms) { if (!m.season) continue; const s = (bySeason[m.season] = bySeason[m.season] || { total: 0, finished: 0 }); s.total++; if (m.status === 'finished') s.finished++; }
      return {
        teams: Object.keys(this.state.teams).length, matches: ms.length, finished: finished.length,
        scheduled: ms.filter((m) => m.status === 'scheduled').length, bySeason,
        completeness: V.completenessReport(finished), openConflicts: this.openConflicts().length,
        lastImport: this.state.importLog[0] || null, persistent: this.storage.persistent, lastSaveError: this.lastSaveError,
      };
    }

    exportAll() { return JSON.parse(JSON.stringify({ ...this.state, exportedAt: this.now(), app: 'ucl-match-analyzer' })); }
    restore(json) {
      if (!json || json.schema !== 1 || !json.matches || !json.teams) return { ok: false, error: 'Not a valid backup (missing schema/matches/teams)' };
      this.state = Object.assign(this._empty(), json);
      delete this.state.exportedAt; delete this.state.app;
      return this.save();
    }
    exportMatchesCSV() {
      const cols = ['id', 'season', 'date', 'stage', 'home', 'away', 'homeGoals', 'awayGoals', 'neutral', 'venue', 'status', 'oddsH', 'oddsD', 'oddsA', 'homeXg', 'awayXg', 'homeShots', 'awayShots', 'homeSot', 'awaySot', 'homeBigChances', 'awayBigChances'];
      return matchesToCSV(this.listMatches(), cols);
    }
    clearAll() { this.state = this._empty(); this.save(); }
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function matchesToCSV(list, cols) {
    const lines = [cols.join(',')];
    for (const m of list) lines.push(cols.map((c) => csvCell(c === 'home' ? m.homeName : c === 'away' ? m.awayName : c === 'neutral' ? (m.neutral ? 1 : 0) : m[c])).join(','));
    return lines.join('\n');
  }
  /** Header-only CSV templates for the Data Management page. */
  function csvTemplate() {
    return 'id,season,date,stage,home,away,homeGoals,awayGoals,neutral,venue,status,oddsH,oddsD,oddsA,homeXg,awayXg,homeShots,awayShots,homeSot,awaySot,homeBigChances,awayBigChances\n';
  }

  const api = { FIELDS, teamKey, DataManager, matchesToCSV, csvTemplate };
  NS.dataManager = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
