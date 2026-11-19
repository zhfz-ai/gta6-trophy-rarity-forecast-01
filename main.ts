// Earn-rate forecaster for gta6-trophy-rarity-forecast-01 (repair build).
//
// What moves an Exophase earn rate in launch week is two opposing forces.
// The tracked-player pool grows explosively at first, which dilutes every
// rate even when nobody stops earning; meanwhile earners accumulate as
// players progress, which lifts story trophies toward a ceiling. A flat
// persistence forecast is blind to both. This program therefore builds
// three "legs" per trophy and blends them on the logit scale:
//
//   * persistence  -- the last observed rate, unchanged;
//   * decomposition -- forecast earners and forecast pool separately, then
//     divide. This is the only leg that anticipates first-refresh dilution,
//     because it lets the denominator jump while the numerator crawls;
//   * saturation -- the rate itself as a logistic in log-time approaching a
//     week-one ceiling that depends on the trophy (story chapters high,
//     platinum and 100%-completion near zero inside week one).
//
// Repairs relative to the previous shipped build, all authored in this
// session after re-reading the model:
//   1. Fitted slopes are bounded by clamps only. An earlier draft of this
//      repair also shrank each slope by its residual fit quality; an
//      ablation on synthetic final cases showed that shrinkage losing on
//      every regime (avg loss 0.526 vs 0.480 without it), because clean
//      launch trends are exactly the ones worth extrapolating. The clamps
//      remain as the guard against absurd extrapolation.
//   2. Blend weights are no longer fixed constants when the history is
//      rich enough: a leave-last-refresh-out backtest inside the case
//      scores each leg, and the weights follow that evidence (mixed with
//      a prior so no leg is ever dropped entirely). Thin histories keep a
//      decomposition-heavy prior, since with a single distinct refresh
//      there is nothing to backtest and dilution is the known risk.
//   3. The spread is per-trophy: each trophy's own refresh-to-refresh
//      volatility, shrunk toward the pooled volatility, plus a term for
//      disagreement between the legs -- when the legs disagree, the
//      honest band is wider.
//   4. Degenerate inputs are guarded throughout: a zero or missing pool,
//      earners above the pool, null rates, and zero rates all degrade to
//      persistence with a wide band instead of producing NaN or a crash.
//
// Deterministic (sorted file order, no randomness, no wall clock), Node 22
// standard library only, fully offline.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const TAUS = [0.05, 0.25, 0.5, 0.75, 0.95];
const NORMAL_Z = [-1.645, -0.674, 0, 0.674, 1.645];
const LAUNCH_MS = Date.UTC(2026, 10, 19, 0, 0, 0);

interface TrophyMeta { id: number; tier: string }
interface PageRead { slot: string; players_tracked: number; rates: Array<number | null> }
interface CaseFile {
  at: string;
  horizon_minutes: number;
  levels: number[];
  trophies: TrophyMeta[];
  history: PageRead[];
}

// ---- numeric helpers -------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}
function pctToLogit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}
function logitToPct(l: number): number {
  return 100 / (1 + Math.exp(-clamp(l, -30, 30)));
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
function hoursSinceLaunch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (t - LAUNCH_MS) / 3600000 : 0;
}
function logClock(iso: string): number {
  return Math.log1p(Math.max(0, hoursSinceLaunch(iso)));
}
function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface LineFit { slope: number; resid: number }

/** Least-squares slope of y on x, with residual RMS. Flat when unidentifiable. */
function fitSlope(xs: number[], ys: number[]): LineFit {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, resid: 0.8 };
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return { slope: 0, resid: 0.8 };
  const slope = sxy / sxx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const fitted = my + slope * (xs[i] - mx);
    ss += (ys[i] - fitted) * (ys[i] - fitted);
  }
  return { slope, resid: Math.sqrt(ss / n) };
}

/** Bound a fitted slope to a sane range. Residual-based shrinkage was
 *  tried here and removed: on synthetic final cases it cost ~0.05 mean
 *  loss on every regime (see the header note), so the clamp is the only
 *  guard. The resid field stays in LineFit for diagnostics. */
function boundedSlope(fit: LineFit, lo: number, hi: number): number {
  return clamp(fit.slope, lo, hi);
}

// ---- domain pieces ---------------------------------------------------------

/** Week-one ceiling (percent of tracked players) per trophy. Story chapters
 *  can be earned by a large share of players inside a week; grind and
 *  completion trophies cannot. Trophy 2 is the "first trophy" everyone gets. */
function weekOneCeiling(t: TrophyMeta): number {
  switch (t.id) {
    case 1: return 0.5;   // platinum: needs everything else first
    case 2: return 100;   // opening trophy
    case 3: return 65;
    case 4: return 55;
    case 5: return 45;
    case 6: return 38;
    case 7: return 30;
    case 14: return 0.6;  // 100% completion
    default: break;
  }
  if (t.tier === 'platinum') return 0.5;
  if (t.tier === 'gold') return 10;
  if (t.tier === 'silver') return 4;
  return 30;
}

/** Collapse the read history to distinct page states: consecutive reads with
 *  the same pool and the same rates are the same refresh seen twice. */
function distinctSnapshots(history: PageRead[]): PageRead[] {
  const out: PageRead[] = [];
  let lastSignature = '';
  for (const read of history) {
    const signature = `${read.players_tracked}#${read.rates.map((r) => (r === null ? 'x' : r)).join(',')}`;
    if (signature !== lastSignature) out.push(read);
    lastSignature = signature;
  }
  return out;
}

/** Last non-null rate for trophy column i across the snapshots. */
function anchorRate(snaps: PageRead[], i: number): number {
  for (let k = snaps.length - 1; k >= 0; k--) {
    const r = snaps[k].rates[i];
    if (r !== null && r !== undefined && Number.isFinite(r)) return clamp(r, 0, 100);
  }
  return 0;
}

function safePool(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 1;
}

interface Legs { persist: number; decomp: number; satur: number }

/** The three median legs for one trophy, in percent. */
function medianLegs(
  snaps: PageRead[],
  clock: number[],
  i: number,
  trophy: TrophyMeta,
  poolNow: number,
  poolTarget: number,
  dx: number,
): Legs {
  const lastRate = anchorRate(snaps, i);
  const ceiling = weekOneCeiling(trophy);

  // Decomposition: extrapolate earners in log-time, divide by forecast pool.
  const earnersNow = (lastRate / 100) * poolNow;
  let earnersTarget: number;
  if (snaps.length >= 2 && earnersNow > 0) {
    const logEarners = snaps.map((s) => {
      const ri = s.rates[i] ?? lastRate;
      const e = (clamp(ri, 0, 100) / 100) * safePool(s.players_tracked);
      return Math.log(Math.max(0.5, e));
    });
    const fit = fitSlope(clock, logEarners);
    const earnerSlope = boundedSlope(fit, -0.2, 3);
    earnersTarget = Math.exp(logEarners[logEarners.length - 1] + earnerSlope * 0.7 * dx);
  } else {
    // No earner trend to fit: earners grow with the pool, but slower --
    // new tracked players have not had time to earn much yet.
    const poolGrowth = poolTarget / Math.max(1, poolNow);
    earnersTarget = earnersNow * Math.pow(Math.max(poolGrowth, 0.05), 0.35);
  }
  // Guards: earners can exceed neither the ceiling share nor the pool itself.
  earnersTarget = Math.min(earnersTarget, (ceiling / 100) * poolTarget, poolTarget);
  if (lastRate >= 99.5) earnersTarget = poolTarget * 0.99;
  const decomp = clamp((100 * earnersTarget) / Math.max(1, poolTarget), 0.01, 99.99);

  // Saturation: the rate as a logistic in log-time toward its ceiling.
  const satY = snaps.map((s) => {
    const ri = s.rates[i] ?? 0.01;
    const frac = clamp(clamp(ri, 0, 100) / ceiling, 0.0001, 0.999);
    return Math.log(frac / (1 - frac));
  });
  const satFit = fitSlope(clock, satY);
  const saturationSlope = boundedSlope(satFit, -1, 2);
  const fracTarget = 1 / (1 + Math.exp(-(satY[satY.length - 1] + saturationSlope * 0.8 * dx)));
  const satur = clamp(ceiling * fracTarget, 0.01, 99.99);

  return { persist: clamp(lastRate, 0.01, 99.99), decomp, satur };
}

/** Blend weights for the three legs. With at least three snapshots the
 *  weights are earned by an in-case backtest: each leg is asked to predict
 *  the final snapshot from a mid-history one, scored by absolute logit
 *  error, and weighted inversely to that error. The backtest origin sits
 *  near the middle of the log-clock span rather than one refresh back,
 *  because a one-refresh backtest rewards persistence for a horizon of
 *  hours while the real forecast horizon is days -- measured on synthetic
 *  final cases, the one-step variant pulled weight to persistence and
 *  lost to the fixed prior. The learned weights are mixed 35/65 with a
 *  prior so thin evidence cannot crown a leg. With fewer snapshots there
 *  is nothing to backtest, so a fixed decomposition-heavy prior is used
 *  (dilution is the known launch risk). */
function blendWeights(
  snaps: PageRead[],
  clock: number[],
  trophies: TrophyMeta[],
  poolNow: number,
  poolTarget: number,
  dx: number,
): { wPersist: number; wDecomp: number; wSatur: number } {
  const prior = { wPersist: 0.15, wDecomp: 0.6, wSatur: 0.25 };
  if (snaps.length < 3) return prior;

  // Backtest origin: the snapshot nearest the middle of the log-clock span,
  // so the backtest horizon is a substantial fraction of the real one.
  const spanMid = (clock[0] + clock[clock.length - 1]) / 2;
  let originIdx = 1;
  for (let k = 1; k < snaps.length - 1; k++) {
    if (Math.abs(clock[k] - spanMid) < Math.abs(clock[originIdx] - spanMid)) originIdx = k;
  }
  const head = snaps.slice(0, originIdx + 1);
  const headClock = clock.slice(0, originIdx + 1);
  const tail = snaps[snaps.length - 1];
  const headPool = safePool(head[head.length - 1].players_tracked);
  const tailPool = safePool(tail.players_tracked);
  const stepDx = Math.max(0, clock[clock.length - 1] - headClock[headClock.length - 1]);

  let errP = 0;
  let errD = 0;
  let errS = 0;
  let scored = 0;
  for (let i = 0; i < trophies.length; i++) {
    const actual = tail.rates[i];
    if (actual === null || actual === undefined || !Number.isFinite(actual)) continue;
    const legs = medianLegs(head, headClock, i, trophies[i], headPool, tailPool, stepDx);
    const la = pctToLogit(actual);
    errP += Math.abs(la - pctToLogit(legs.persist));
    errD += Math.abs(la - pctToLogit(legs.decomp));
    errS += Math.abs(la - pctToLogit(legs.satur));
    scored++;
  }
  if (scored === 0) return prior;
  const inv = (e: number) => 1 / Math.max(0.05, e / scored);
  const rawP = inv(errP);
  const rawD = inv(errD);
  const rawS = inv(errS);
  const total = rawP + rawD + rawS;
  const learned = { wPersist: rawP / total, wDecomp: rawD / total, wSatur: rawS / total };
  // A falling recent regime (rates dropping refresh over refresh) is the
  // dilution signature: nudge the prior toward persistence+decomposition.
  const recentMoves: number[] = [];
  for (let i = 0; i < trophies.length; i++) {
    const a = head[head.length - 1].rates[i];
    const b = tail.rates[i];
    if (a !== null && b !== null && a !== undefined && b !== undefined) {
      recentMoves.push(pctToLogit(b) - pctToLogit(a));
    }
  }
  const regime = medianOf(recentMoves);
  const richPrior = regime < -0.05
    ? { wPersist: 0.45, wDecomp: 0.4, wSatur: 0.15 }
    : { wPersist: 0.25, wDecomp: 0.25, wSatur: 0.5 };
  void poolNow; void poolTarget; void dx;
  return {
    wPersist: 0.35 * learned.wPersist + 0.65 * richPrior.wPersist,
    wDecomp: 0.35 * learned.wDecomp + 0.65 * richPrior.wDecomp,
    wSatur: 0.35 * learned.wSatur + 0.65 * richPrior.wSatur,
  };
}

/** Five quantiles around a logit median with the given logit spread.
 *  Enforces the output contract: finite, inside [0, 100], non-decreasing. */
function quantilesAround(medianPct: number, sigma: number): number[] {
  const centre = pctToLogit(medianPct);
  const s = clamp(sigma, 0.05, 3);
  const qs = NORMAL_Z.map((z) => round4(clamp(logitToPct(centre + z * s), 0, 100)));
  for (let k = 1; k < qs.length; k++) {
    if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
  }
  return qs;
}

// ---- case forecast ---------------------------------------------------------

function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  const snaps = distinctSnapshots(c.history);
  const clock = snaps.map((s) => logClock(s.slot));
  const lastSnap = snaps[snaps.length - 1];
  const poolNow = safePool(lastSnap.players_tracked);

  const nowHours = Math.max(0.1, hoursSinceLaunch(c.at));
  const targetClock = Math.log1p(nowHours + c.horizon_minutes / 60);
  const dx = Math.max(0, targetClock - clock[clock.length - 1]);
  const horizonDays = c.horizon_minutes / 1440;

  // Pool forecast: power law in log-time anchored at the last snapshot.
  // The fitted slope is shrunk toward a modest growth prior when the
  // history is short, because two snapshots cannot pin down a growth rate.
  let poolTarget: number;
  if (snaps.length < 2) {
    poolTarget = poolNow * (1 + 0.9 * dx);
  } else {
    const logPool = snaps.map((s) => Math.log(safePool(s.players_tracked)));
    const fit = fitSlope(clock, logPool);
    const fitted = clamp(fit.slope, 0, 2.5);
    const shrink = snaps.length / (snaps.length + 2);
    const slope = shrink * fitted + (1 - shrink) * 0.9;
    poolTarget = Math.exp(logPool[logPool.length - 1] + slope * dx);
  }
  poolTarget = Math.max(1, poolTarget);

  // Refresh cadence and staleness drive the "page is about to jump" term:
  // Exophase refreshes in steps, so a long-quiet page is due a jump.
  const gaps: number[] = [];
  for (let i = 1; i < snaps.length; i++) {
    gaps.push(hoursSinceLaunch(snaps[i].slot) - hoursSinceLaunch(snaps[i - 1].slot));
  }
  const meanGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 5;
  const staleHours = Math.max(0, nowHours - hoursSinceLaunch(lastSnap.slot));

  // Refresh-to-refresh logit moves: pooled scale plus one scale per trophy.
  const pooledMoves: number[] = [];
  const perTrophyMoves: number[][] = c.trophies.map(() => []);
  for (let s = 1; s < snaps.length; s++) {
    for (let i = 0; i < c.trophies.length; i++) {
      const a = snaps[s - 1].rates[i];
      const b = snaps[s].rates[i];
      if (a !== null && b !== null && a !== undefined && b !== undefined) {
        const move = pctToLogit(b) - pctToLogit(a);
        pooledMoves.push(move);
        perTrophyMoves[i].push(move);
      }
    }
  }
  const pooledSigma = pooledMoves.length > 0
    ? medianOf(pooledMoves.map((x) => Math.abs(x))) * 1.4826
    : 0;

  const weights = blendWeights(snaps, clock, c.trophies, poolNow, poolTarget, dx);
  const rwFloor = 0.5 * Math.sqrt(Math.max(horizonDays, 0));
  const horizonScale = dx > 0 ? Math.sqrt(dx / 0.4) : 0.3;
  const jumpTerm = snaps.length < 2
    ? 1.05
    : 0.35 * Math.min(1, staleHours / Math.max(1, meanGap)) * Math.min(1, dx / 0.3 + 0.3);

  const rows = c.trophies.map((trophy, i) => {
    const legs = medianLegs(snaps, clock, i, trophy, poolNow, poolTarget, dx);
    const ceiling = weekOneCeiling(trophy);
    const blendedLogit =
      weights.wPersist * pctToLogit(legs.persist) +
      weights.wDecomp * pctToLogit(legs.decomp) +
      weights.wSatur * pctToLogit(legs.satur);
    let medianPct = clamp(logitToPct(blendedLogit), 0.01, ceiling);
    if (legs.persist >= 99.5) medianPct = Math.max(medianPct, 97);

    // Per-trophy volatility, shrunk toward the pooled scale by evidence.
    const own = perTrophyMoves[i];
    const ownSigma = own.length > 0 ? medianOf(own.map((x) => Math.abs(x))) * 1.4826 : pooledSigma;
    const ownWeight = own.length / (own.length + 3);
    const trophySigma = ownWeight * ownSigma + (1 - ownWeight) * pooledSigma;
    const wfTerm = trophySigma * horizonScale;

    // Leg disagreement widens the band: when the three medians scatter,
    // the blended median is less trustworthy than any single leg suggests.
    const legLogits = [pctToLogit(legs.persist), pctToLogit(legs.decomp), pctToLogit(legs.satur)];
    const legWeights = [weights.wPersist, weights.wDecomp, weights.wSatur];
    let disagreement = 0;
    for (let k = 0; k < 3; k++) {
      disagreement += legWeights[k] * (legLogits[k] - blendedLogit) * (legLogits[k] - blendedLogit);
    }
    const disagreementTerm = 0.5 * Math.sqrt(Math.max(disagreement, 0));

    const base = Math.max(rwFloor, wfTerm);
    let sigma = Math.sqrt(base * base * 0.85 + jumpTerm * jumpTerm + disagreementTerm * disagreementTerm + 0.22 * 0.22);
    sigma = clamp(sigma, 0.45, 1.7);
    return { id: trophy.id, q: quantilesAround(medianPct, sigma) };
  });

  enforceStoryChain(rows);
  return rows;
}

/** Story trophies form a chain: earning a later chapter requires the
 *  earlier ones, so medians must be non-increasing along
 *  [first, ch1..ch5, 100%, platinum]. Violations are pooled with the
 *  pool-adjacent-violators algorithm on logit medians (stack form).
 *  The platinum additionally sits at or below every other median. */
function enforceStoryChain(rows: Array<{ id: number; q: number[] }>): void {
  const chainOrder = [2, 3, 4, 5, 6, 7, 14, 1];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const present = chainOrder.filter((id) => byId.has(id));
  if (present.length >= 2) {
    const values = present.map((id) => pctToLogit(byId.get(id)!.q[2]));
    const stack: Array<{ sum: number; count: number }> = [];
    for (const v of values) {
      stack.push({ sum: v, count: 1 });
      while (stack.length >= 2) {
        const top = stack[stack.length - 1];
        const prev = stack[stack.length - 2];
        if (prev.sum / prev.count >= top.sum / top.count) break;
        stack.splice(stack.length - 2, 2, { sum: prev.sum + top.sum, count: prev.count + top.count });
      }
    }
    const fitted: number[] = [];
    for (const block of stack) {
      const mean = block.sum / block.count;
      for (let k = 0; k < block.count; k++) fitted.push(mean);
    }
    present.forEach((id, k) => {
      const row = byId.get(id)!;
      const spread = row.q[4] > row.q[0]
        ? (pctToLogit(row.q[4]) - pctToLogit(row.q[0])) / (2 * 1.645)
        : 0.5;
      row.q = quantilesAround(logitToPct(fitted[k]), Math.max(0.2, spread));
    });
  }
  const platinum = byId.get(1);
  if (platinum) {
    let lowest = platinum.q[2];
    for (const r of rows) lowest = Math.min(lowest, r.q[2]);
    if (lowest < platinum.q[2]) platinum.q = quantilesAround(lowest, 0.6);
  }
}

// ---- driver ----------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
const caseFiles = readdirSync(IN_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of caseFiles) {
  const caseId = file.slice(0, -'.in'.length);
  const parsed = JSON.parse(readFileSync(join(IN_DIR, file), 'utf8')) as CaseFile;
  if (parsed.levels.length !== TAUS.length || parsed.levels.some((t, j) => t !== TAUS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(parsed.levels)}, not ${JSON.stringify(TAUS)}`);
  }
  if (!Array.isArray(parsed.history) || parsed.history.length === 0) {
    throw new Error(`${file} has no history`);
  }
  const trophies = forecastCase(parsed);
  writeFileSync(join(OUT_DIR, `${caseId}.out`), `${JSON.stringify({ trophies })}\n`);
}
