# UCL Match Analyzer

A browser-only (HTML5 + CSS3 + vanilla ES6) UEFA Champions League analyzer that produces **one** calibrated 1X2 decision per match, with a walk-forward backtest, benchmarks and a full audit trail.

> **Bundled data (real):** `data/historicaldata.js` holds 1,247 real UCL results, 2017/18–2025/26 (main competition, 90-minute scores), from [openfootball/champions-league](https://github.com/openfootball/champions-league) (public domain). It contains **no odds, xG, shots, injuries or lineups**; those inputs are reported as missing and the bookmaker benchmark is unavailable. It also contains the real 2026/27 league-phase results to matchday 4 (UEFA.com, cross-checked with NBC Sports) and the 72 scheduled matches of matchdays 5–8 (dates only, no kickoff times). No data is invented; teams file is empty. The bundled files are imported on first open and whenever their version changes; your manual edits are never overwritten.
> The 70% accuracy figure is an **evaluation target, not a promise**. Measured on those data (walk-forward, 5 seasons 2021/22–2025/26, 753 matches): **57.5% accuracy (95% CI 53.9–61.0%) — TARGET NOT MET**; Brier 0.547 vs 0.623 for the frequency baseline (skill +12.2%); log loss 0.928; calibration error 0.9%. Draws are never the most likely outcome, so Draw accuracy is 0/139 — inherent to single-pick 1X2.

## 1. Run
```
cd ucl-match-analyzer
python3 -m http.server 8080     # or: npm run serve    (any static server works; file:// also works)
# open http://localhost:8080
```
Tests (Node ≥ 18): `npm test`

## 2. Load data
Data Management → Import CSV/JSON (or paste). Required columns: `date, home, away`. Results: `homeGoals, awayGoals`. Optional: `season, stage, venue, neutral, oddsH, oddsD, oddsA` (decimal), `homeXg, awayXg, homeShots, awayShots, homeSot, awaySot, homeBigChances, awayBigChances`. Football-Data.co.uk style headers (`FTHG, FTAG, B365H…`) are recognised. Empty cells are *missing*, never 0. A CSV template can be downloaded in the app. For the backtest you need ≥ 1 completed season with ≥ 100 matches and ≥ 16 teams (ideally 5 seasons + earlier history for warm-up).

## 3. Data provider (API mode) — secrets
A frontend-only app **cannot** protect a secret API key. This app has no key field. Instead it calls a *proxy URL you control* that injects the key server-side.
1. Deploy `proxy/worker.js` as a Cloudflare Worker (or equivalent serverless function).
2. `wrangler secret put FOOTBALL_DATA_TOKEN`; set `ALLOWED_ORIGIN` to your site.
3. Settings → Data provider → Proxy base URL → your worker URL. Then Data Management → Fetch matches (season start years, e.g. `2024, 2023`). Deploy the current `proxy/worker.js` to forward the optional lineup-unfolding request.
The football-data.org mapper follows the documented v4 response shape and is unit-tested on payloads of that shape, **but was not run against the live service** (no network in the build environment). The basic/free tier does not provide xG, odds, injuries or lineups. Eligible plans can return 1X2 odds, team shot statistics and lineups; this app imports those fields only when present. xG and injury data still need a trusted CSV or Custom JSON source. 90-minute scores are used for 1X2 (extra-time/penalty results are not).
Hybrid rules: manual edits are stored as overrides; a later API/CSV import never replaces them — differing values appear as **conflicts** to resolve. Every field's origin/timestamp is visible (Match Analysis → Field provenance).

### AMAI (Artificial Match Analysis Intelligence)
AMAI is an optional explainer and chat assistant inside Match Analysis. It explains the existing model output using the current match's compact statistics; it does not replace or improve the prediction engine. To enable it, add `AMAI_OPENAI_KEY` as a Cloudflare Worker secret (`wrangler secret put AMAI_OPENAI_KEY`) and redeploy the current `proxy/worker.js`. The AMAI endpoint reuses the Worker URL in Settings → Data provider. The default model is `gpt-6-luna`; set the optional Worker variable `AMAI_MODEL` to another model available to your API account. AMAI sends the selected match summary, a short in-memory chat history and the question to the configured AI provider, not the full local match database; API responses use `store: false`. OpenAI API usage may incur charges. Keep `ALLOWED_ORIGIN` restricted to your site.

For a richer custom provider, `GET /matches?season=2024` may return either an array of match rows or `{ "matches": [...] }`. Rows use the same names accepted by CSV/JSON import (`date`, `home`, `away`, `homeGoals`, `awayGoals`, `oddsH/D/A`, `homeXg/awayXg`, shots and shots-on-target fields). All values pass through the same validator and retain source/timestamp provenance; missing values are never filled with estimates. Odds are benchmark data only. xG affects predictions only when enabled and the configured minimum history is met. After importing richer data or changing engine settings, re-run the walk-forward backtest and compare Brier score and log loss before keeping the change.

## 4. Method
* **Dixon–Coles**: λ_home = μ·att_h·def_a·γ, λ_away = μ·att_a·def_h; Poisson scorelines with the τ correction on 0-0/1-0/0-1/1-1; ρ by weighted likelihood. Fitted by alternating closed-form updates with exponential time-decay (default half-life ≈ 1 year) and shrinkage toward league average (`priorMatches` pseudo-matches per team — necessary because UCL pairings are sparse).
* **Elo** with goal-difference multiplier and home advantage, mapped to 1X2 by the Davidson draw model (ν fitted on training data).
* **Blend**: linear pool, 50/50 by default (no evidence-free tuning). **xG** nudges λ only when both teams have ≥ 5 matches of xG, weight n/(n+10) capped at 0.5. **Squad adjustment** exists but is **off** by default because it is an unvalidated assumption; injuries/lineups/formations otherwise feed only data-quality and display.
* **Calibration**: 3-parameter vector scaling, ridge-regularised, active only after ≥ 200 genuinely out-of-sample predictions. The scoreline grid is rescaled so its 1X2 totals equal the final probabilities. Pick = argmax (ties → 1, X, 2).
* **Confidence** (Low/Medium/High) = 0.35·separation + 0.20·component agreement + 0.20·data completeness + 0.25·validation score, then caps: not validated → ≤ Medium; data < 35% → Low; top-two gap < 10 pts → Low, < 20 pts → ≤ Medium; data completeness < 50% → ≤ Medium; a team with < 8 loaded matches → ≤ Medium; unknown team → Low. The weights are documented judgment, not fitted — they are an ordinal label, not a probability.

## 5. Backtesting methodology
Per kickoff **day**, chronologically: train from scratch on matches from strictly earlier days → fit calibrator only on earlier out-of-sample predictions → predict from a stripped view (teams/date/venue flag/stage; no score, odds, xG) → store → next day. Same-day matches never inform each other. A leakage audit throws if any training match is not earlier than the prediction day. Reported: accuracy (+ Wilson 95% CI), Brier, log loss, ECE & reliability diagram, confusion matrix, per-class accuracy, per-season and per-confidence-range results, plus comparison with the training-frequency baseline and (when reliable odds exist) normalised bookmaker probabilities on the *same* matches. Runs are fingerprinted (dataset hash, config hash) and flagged stale if data or settings change. Caveat: hyper-parameters are fixed defaults, not tuned on the test seasons.

## 6. Prediction history / post-match
Predictions are frozen on save and timestamped. Only predictions saved before kickoff count toward live accuracy (others are flagged). Evaluations are separate records, so the original prediction is never overwritten; Brier/log loss/accuracy update as results are imported or entered.

## 7. Test results
`npm test` → **36 automated tests** (statistics, Poisson, Dixon–Coles, Elo, calibration, probability sums, edge cases/missing data, validation, CSV/JSON import & export round-trip, LocalStorage persistence/quota/corruption, API success/errors/retries/secret guard, hybrid override protection, chronological separation, future-result leak test, history immutability). Browser smoke test (Chromium via Playwright, desktop 1360px and mobile 390px): all pages render, import → backtest → analysis → save prediction works, no console errors, no horizontal overflow. Tests use *synthetic* leagues generated from known parameters, only to verify code behaviour; these never ship in the app and say nothing about real football accuracy.

## 8. Known limitations
* Results above come from results-only data; no bookmaker odds were available, so the market benchmark was not run. Team names across seasons were unified by hand.
* UCL-only history ignores domestic form; Elo/strengths start from sparse data each season. Rest days/congestion derived from loaded UCL matches only unless entered manually.
* Squad/tactics are not validated inputs; xG is only as good as what you import.
* Draws are rarely the argmax, so Draw accuracy is typically low — inherent to single-pick 1X2.
* Live API path unverified against the real provider; LocalStorage (~5 MB) can fill — export backups.
* Time zones: dates are UTC; date-only fixtures are treated as unverifiable-timing for live statistics unless saved a day earlier.

## 9. Code style and maintenance
See [CODE_STYLE.md](CODE_STYLE.md) for indentation, comments, file ownership, and case-sensitive import conventions.
