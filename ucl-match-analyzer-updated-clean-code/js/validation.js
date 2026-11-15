/**
 * validation.js — CSV/JSON parsing and strict validation of imported / manually entered data.
 * Nothing here touches storage or the DOM. Invalid rows are rejected with a precise reason;
 * questionable-but-usable rows are accepted with warnings. Missing optional values stay null
 * (never defaulted to 0).
 */
(function (global) {
  'use strict';
  const NS = (global.UCL = global.UCL || {});

  const MATCH_FIELDS = ['id', 'season', 'date', 'stage', 'homeName', 'awayName', 'homeGoals', 'awayGoals', 'neutral', 'venue', 'status',
    'oddsH', 'oddsD', 'oddsA', 'homeXg', 'awayXg', 'homeShots', 'awayShots', 'homeSot', 'awaySot', 'homeBigChances', 'awayBigChances'];
  /** Optional analytic fields whose absence is reported as "missing" (never silently treated as zero). */
  const OPTIONAL_STAT_FIELDS = ['homeXg', 'awayXg', 'homeShots', 'awayShots', 'homeSot', 'awaySot', 'homeBigChances', 'awayBigChances', 'oddsH', 'oddsD', 'oddsA'];

  const ALIASES = {
    id: 'id', matchid: 'id', season: 'season', date: 'date', kickoff: 'date', datetime: 'date', time: 'time',
    stage: 'stage', round: 'stage', home: 'homeName', hometeam: 'homeName', hometeamname: 'homeName',
    away: 'awayName', awayteam: 'awayName', awayteamname: 'awayName',
    homegoals: 'homeGoals', hg: 'homeGoals', fthg: 'homeGoals', homescore: 'homeGoals',
    awaygoals: 'awayGoals', ag: 'awayGoals', ftag: 'awayGoals', awayscore: 'awayGoals',
    neutral: 'neutral', neutralvenue: 'neutral', venue: 'venue', stadium: 'venue', status: 'status',
    oddsh: 'oddsH', b365h: 'oddsH', avgh: 'oddsH', homeodds: 'oddsH',
    oddsd: 'oddsD', b365d: 'oddsD', avgd: 'oddsD', drawodds: 'oddsD',
    oddsa: 'oddsA', b365a: 'oddsA', avga: 'oddsA', awayodds: 'oddsA',
    homexg: 'homeXg', xgh: 'homeXg', awayxg: 'awayXg', xga: 'awayXg',
    homeshots: 'homeShots', hs: 'homeShots', awayshots: 'awayShots', as: 'awayShots',
    homesot: 'homeSot', hst: 'homeSot', homeshotsontarget: 'homeSot', awaysot: 'awaySot', ast: 'awaySot', awayshotsontarget: 'awaySot',
    homebigchances: 'homeBigChances', awaybigchances: 'awayBigChances',
  };

  const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  /** RFC-4180-style CSV parser (quotes, escaped quotes, CRLF, BOM, ; or tab delimiter). */
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inQ = false;
    for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]++; }
    const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); if (row.some((c) => c.trim() !== '')) rows.push(row); }
    if (!rows.length) return { headers: [], rows: [], delimiter: delim, unknownColumns: [] };
    const rawHeaders = rows[0].map((h) => h.trim());
    const headers = rawHeaders.map((h) => ALIASES[normKey(h)] || null);
    const unknownColumns = rawHeaders.filter((h, i) => !headers[i] && h !== '');
    const out = rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => { if (h) o[h] = (r[i] ?? '').trim(); });
      return o;
    });
    return { headers: headers.filter(Boolean), rows: out, delimiter: delim, unknownColumns };
  }

  /** Canonicalise the keys of a JSON object using the same aliases as CSV headers. */
  function canonicalizeKeys(obj) {
    const o = {};
    for (const k of Object.keys(obj)) { const c = ALIASES[normKey(k)]; if (c) o[c] = obj[k]; else if (MATCH_FIELDS.includes(k)) o[k] = obj[k]; }
    if (obj.home && typeof obj.home === 'object') o.homeName = obj.home.name;
    if (obj.away && typeof obj.away === 'object') o.awayName = obj.away.name;
    return o;
  }

  const blank = (v) => v === undefined || v === null || String(v).trim() === '';
  const toNum = (v) => (blank(v) ? null : Number(String(v).trim().replace(',', '.')));

  /** Returns normalised date string (YYYY-MM-DD or full ISO UTC) or null. */
  function parseDate(v) {
    if (blank(v)) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return valid(+m[1], +m[2], +m[3]) ? s : null;
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return valid(+m[3], +m[2], +m[1]) ? `${m[3]}-${m[2]}-${m[1]}` : null;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      if (!valid(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return null;
      const tz = m[7] ? (m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : 'Z';
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz}`);
      return isNaN(t) ? null : new Date(t).toISOString().replace('.000Z', 'Z');
    }
    return null;
  }
  function valid(y, mo, d) {
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  function deriveSeason(date) {
    const y = +date.slice(0, 4), mo = +date.slice(5, 7);
    const start = mo >= 7 ? y : y - 1;
    return `${start}-${String(start + 1).slice(2)}`;
  }

  function parseBool(v) {
    if (typeof v === 'boolean') return v;
    if (blank(v)) return false;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'neutral'].includes(s)) return true;
    if (['0', 'false', 'no', 'n'].includes(s)) return false;
    return null;
  }

  /**
   * Validate one raw row (already canonical-keyed). Returns {record, errors, warnings}.
   * `record` is null when there are errors.
   */
  function validateMatchRow(raw, { today = new Date() } = {}) {
    const errors = [], warnings = [];
    const r = {};
    const home = blank(raw.homeName) ? '' : String(raw.homeName).trim();
    const away = blank(raw.awayName) ? '' : String(raw.awayName).trim();
    if (!home) errors.push({ field: 'homeName', msg: 'home team is required' });
    if (!away) errors.push({ field: 'awayName', msg: 'away team is required' });
    if (home && away && slug(home) === slug(away)) errors.push({ field: 'awayName', msg: 'home and away teams must differ' });
    r.homeName = home; r.awayName = away;

    let dateRaw = raw.date;
    if (!blank(raw.time) && !blank(raw.date) && /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/.test(String(raw.date).trim())) {
      const d0 = parseDate(raw.date);
      if (d0) dateRaw = `${d0}T${String(raw.time).trim()}`;
    }
    const date = parseDate(dateRaw);
    if (!date) errors.push({ field: 'date', msg: `invalid or missing date "${raw.date ?? ''}" (use YYYY-MM-DD or ISO datetime, UTC)` });
    r.date = date;

    // scores
    const hg = toNum(raw.homeGoals), ag = toNum(raw.awayGoals);
    const hasH = hg !== null, hasA = ag !== null;
    if (hasH !== hasA) errors.push({ field: 'homeGoals', msg: 'both goals must be given, or neither' });
    else if (hasH) {
      for (const [f, v] of [['homeGoals', hg], ['awayGoals', ag]]) if (!Number.isInteger(v) || v < 0 || v > 20) errors.push({ field: f, msg: `goals must be an integer 0–20 (got "${raw[f]}")` });
    }
    r.homeGoals = hasH && !errors.some((e) => e.field.endsWith('Goals')) ? hg : null;
    r.awayGoals = hasA && !errors.some((e) => e.field.endsWith('Goals')) ? ag : null;
    const finished = r.homeGoals !== null && r.awayGoals !== null;
    let status = blank(raw.status) ? (finished ? 'finished' : 'scheduled') : String(raw.status).trim().toLowerCase();
    if (!['finished', 'scheduled', 'live', 'postponed'].includes(status)) { warnings.push({ field: 'status', msg: `unknown status "${raw.status}" — using derived value` }); status = finished ? 'finished' : 'scheduled'; }
    if (status === 'finished' && !finished) { errors.push({ field: 'status', msg: 'status is finished but scores are missing' }); }
    if (finished && status !== 'finished') { warnings.push({ field: 'status', msg: 'scores present — status set to finished' }); status = 'finished'; }
    if (finished && date && Date.parse(date) > today.getTime() + 36 * 3600e3) errors.push({ field: 'date', msg: 'a result cannot be recorded for a match in the future' });
    r.status = status;

    r.stage = blank(raw.stage) ? null : String(raw.stage).trim();
    r.venue = blank(raw.venue) ? null : String(raw.venue).trim();
    const nb = parseBool(raw.neutral);
    if (nb === null) { warnings.push({ field: 'neutral', msg: `unrecognised neutral flag "${raw.neutral}" — treated as false` }); r.neutral = false; } else r.neutral = nb;

    if (blank(raw.season) && date) { r.season = deriveSeason(date); warnings.push({ field: 'season', msg: `season derived from date: ${r.season}` }); }
    else if (!blank(raw.season)) {
      const s = String(raw.season).trim();
      if (!/^\d{4}[-/]\d{2}(\d{2})?$/.test(s)) errors.push({ field: 'season', msg: `season must look like 2023-24 (got "${s}")` });
      else r.season = s.replace('/', '-').replace(/^(\d{4}-\d{2})\d{2}$/, '$1');
    } else r.season = null;

    // odds: all-or-nothing, each > 1
    const odds = ['oddsH', 'oddsD', 'oddsA'].map((f) => toNum(raw[f]));
    const given = odds.filter((v) => v !== null).length;
    if (given === 3) {
      if (odds.every((v) => isFinite(v) && v > 1 && v < 1000)) { [r.oddsH, r.oddsD, r.oddsA] = odds; const ov = odds.reduce((s, v) => s + 1 / v, 0); if (ov < 1 || ov > 1.25) warnings.push({ field: 'odds', msg: `implied overround ${(ov * 100).toFixed(1)}% outside 100–125% — odds will not be used as a benchmark` }); }
      else { errors.push({ field: 'odds', msg: 'decimal odds must all be numbers > 1' }); }
    } else if (given > 0) { warnings.push({ field: 'odds', msg: 'partial odds ignored (need H, D and A)' }); }
    for (const f of ['oddsH', 'oddsD', 'oddsA']) if (r[f] === undefined) r[f] = null;

    // advanced stats — null stays null
    for (const f of ['homeXg', 'awayXg']) {
      const v = toNum(raw[f]);
      if (v !== null && (!isFinite(v) || v < 0 || v > 10)) errors.push({ field: f, msg: `xG must be a number 0–10 (got "${raw[f]}")` });
      r[f] = v !== null && isFinite(v) && v >= 0 && v <= 10 ? v : null;
    }
    if ((r.homeXg === null) !== (r.awayXg === null)) { warnings.push({ field: 'xG', msg: 'only one side has xG — xG ignored for this match' }); r.homeXg = null; r.awayXg = null; }
    for (const f of ['homeShots', 'awayShots', 'homeSot', 'awaySot', 'homeBigChances', 'awayBigChances']) {
      const v = toNum(raw[f]);
      if (v !== null && (!Number.isInteger(v) || v < 0 || v > 60)) errors.push({ field: f, msg: `${f} must be an integer 0–60 (got "${raw[f]}")` });
      r[f] = v !== null && Number.isInteger(v) && v >= 0 && v <= 60 ? v : null;
    }
    if (r.homeSot !== null && r.homeShots !== null && r.homeSot > r.homeShots) warnings.push({ field: 'homeSot', msg: 'shots on target exceed shots (home)' });
    if (r.awaySot !== null && r.awayShots !== null && r.awaySot > r.awayShots) warnings.push({ field: 'awaySot', msg: 'shots on target exceed shots (away)' });
    if (finished && r.homeShots !== null && r.homeGoals > r.homeShots && r.homeShots > 0) warnings.push({ field: 'homeShots', msg: 'goals exceed shots (home) — check data' });

    r.id = blank(raw.id) ? (date && home && away ? `${date.slice(0, 10)}_${slug(home)}_${slug(away)}` : null) : String(raw.id).trim();
    return { record: errors.length ? null : r, errors, warnings };
  }

  /** Validate many rows. Reports 1-based row numbers (excluding the header). Duplicate ids inside the file are rejected. */
  function validateMatchRows(rows, opts) {
    const valid = [], errors = [], warnings = [];
    const seen = new Map();
    rows.forEach((raw, i) => {
      const res = validateMatchRow(canonicalizeKeys(raw), opts);
      res.errors.forEach((e) => errors.push({ row: i + 1, ...e }));
      res.warnings.forEach((w) => warnings.push({ row: i + 1, ...w }));
      if (res.record) {
        if (seen.has(res.record.id)) { errors.push({ row: i + 1, field: 'id', msg: `duplicate match id "${res.record.id}" (first seen in row ${seen.get(res.record.id)})` }); return; }
        seen.set(res.record.id, i + 1);
        valid.push(res.record);
      }
    });
    return { valid, errors, warnings, total: rows.length };
  }

  /** Parse a CSV string or JSON string into rows + metadata. Never throws. */
  function parseImport(text, kind) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'File is empty' };
    const looksJson = kind === 'json' || (kind !== 'csv' && (t[0] === '{' || t[0] === '['));
    if (looksJson) {
      let j;
      try { j = JSON.parse(t); } catch (e) { return { ok: false, error: 'Invalid JSON: ' + e.message }; }
      const matches = Array.isArray(j) ? j : j.matches || j.fixtures || [];
      if (!Array.isArray(matches)) return { ok: false, error: 'JSON must be an array of matches or an object with a "matches" array' };
      return { ok: true, format: 'json', rows: matches.filter((m) => m && typeof m === 'object'), teams: Array.isArray(j.teams) ? j.teams : [], unknownColumns: [] };
    }
    const p = parseCSV(t);
    if (!p.rows.length) return { ok: false, error: 'CSV has no data rows' };
    const need = ['homeName', 'awayName', 'date'];
    const missing = need.filter((h) => !p.headers.includes(h));
    if (missing.length) return { ok: false, error: `CSV is missing required column(s): ${missing.join(', ')}. Required: date, home, away.` };
    return { ok: true, format: 'csv', rows: p.rows, teams: [], unknownColumns: p.unknownColumns };
  }

  /** Dataset coverage report: % of matches that have each optional stat. */
  function completenessReport(matches) {
    const n = matches.length;
    const out = { n, fields: {} };
    for (const f of OPTIONAL_STAT_FIELDS) {
      const have = matches.filter((m) => m[f] !== null && m[f] !== undefined).length;
      out.fields[f] = { have, missing: n - have, coverage: n ? have / n : 0 };
    }
    return out;
  }

  /** Is the odds triple usable as a benchmark? (all > 1, overround within 100–125%). */
  function reliableOdds(m) {
    const o = [m.oddsH, m.oddsD, m.oddsA];
    if (!o.every((v) => typeof v === 'number' && isFinite(v) && v > 1)) return false;
    const ov = o.reduce((s, v) => s + 1 / v, 0);
    return ov >= 1 && ov <= 1.25;
  }

  /** Remove the bookmaker margin by proportional normalisation of implied probabilities. */
  function normalizedOddsProbs(m) {
    const ih = 1 / m.oddsH, id = 1 / m.oddsD, ia = 1 / m.oddsA, s = ih + id + ia;
    return { H: ih / s, D: id / s, A: ia / s };
  }

  /** Range checks for model configuration patches coming from the Settings page. */
  function validateConfigPatch(cfg) {
    const errs = [];
    const chk = (path, v, lo, hi, int) => {
      if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) errs.push(`${path} must be ${int ? 'an integer ' : ''}between ${lo} and ${hi}`);
    };
    if (cfg.elo) { chk('elo.k', cfg.elo.k, 1, 100); chk('elo.homeAdvantage', cfg.elo.homeAdvantage, 0, 200); chk('elo.initial', cfg.elo.initial, 500, 2500); }
    if (cfg.dc) { chk('dc.xi', cfg.dc.xi, 0, 0.01); chk('dc.priorMatches', cfg.dc.priorMatches, 0, 20); }
    if (cfg.blend) chk('blend.eloWeight', cfg.blend.eloWeight, 0, 1);
    if (cfg.calibration) { chk('calibration.minSamples', cfg.calibration.minSamples, 50, 5000, true); chk('calibration.l2', cfg.calibration.l2, 0, 100); }
    if (cfg.xg) {
      chk('xg.minMatches', cfg.xg.minMatches, 1, 50, true);
      chk('xg.maxWeight', cfg.xg.maxWeight, 0, 1);
      chk('xg.halfWeightMatches', cfg.xg.halfWeightMatches, 1, 100);
      if (cfg.xg.profileMatches !== undefined) chk('xg.profileMatches', cfg.xg.profileMatches, 0, 100, true);
    }
    if (cfg.squad) { chk('squad.replacementDrop', cfg.squad.replacementDrop, 0, 1); chk('squad.maxReduction', cfg.squad.maxReduction, 0, 0.5); }
    if (cfg.minTrainMatches !== undefined) chk('minTrainMatches', cfg.minTrainMatches, 10, 1000, true);
    return errs;
  }

  /** Validate manual squad-context entries (injuries, rest days …). */
  function validateContext(ctx) {
    const errs = [];
    const share = (v, label) => { if (v !== null && v !== undefined && v !== '' && !(+v >= 0 && +v <= 1)) errs.push(`${label} must be between 0 and 1`); };
    for (const side of ['home', 'away']) {
      for (const p of ctx[side + 'Injuries'] || []) {
        if (!p.name || !String(p.name).trim()) errs.push(`${side}: a missing player needs a name`);
        share(p.attackShare, `${side} ${p.name || 'player'} attack share`); share(p.defenceShare, `${side} ${p.name || 'player'} defence share`);
      }
      const rd = ctx[side + 'RestDays'];
      if (rd !== null && rd !== undefined && rd !== '' && !(Number.isInteger(+rd) && +rd >= 0 && +rd <= 60)) errs.push(`${side} rest days must be an integer 0–60`);
      const m14 = ctx[side + 'Matches14d'];
      if (m14 !== null && m14 !== undefined && m14 !== '' && !(Number.isInteger(+m14) && +m14 >= 0 && +m14 <= 10)) errs.push(`${side} matches in last 14 days must be an integer 0–10`);
    }
    return errs;
  }

  const api = {
    MATCH_FIELDS, OPTIONAL_STAT_FIELDS, slug, parseCSV, canonicalizeKeys, parseDate, deriveSeason,
    validateMatchRow, validateMatchRows, parseImport, completenessReport, reliableOdds, normalizedOddsProbs,
    validateConfigPatch, validateContext,
  };
  NS.validation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
