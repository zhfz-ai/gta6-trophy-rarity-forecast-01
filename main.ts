// Dilution-aware earn-rate forecaster for gta6-trophy-rarity-forecast-01.
//
// An Exophase earn rate is earners / tracked players. Right after a launch
// the denominator floods in far faster than the numerator grows, so every
// rate falls even while more people earn each trophy (dilution); later the
// pool growth decelerates and earners catch up (catch-up). A persistence
// forecast sees neither force. This program forecasts the two sides
// separately and blends them with persistence:
//
//   1. Pool: log(tracked players) regressed on log-time since release over
//      the distinct refreshes in the case history (slope clamped to
//      [0, 2.5]); with a single distinct refresh, a modest growth prior.
//   2. Earners: each trophy's earner count (rate x pool) extrapolated in
//      log-time with a damped slope, capped at the trophy's week-one
//      ceiling share of the forecast pool; the decomposition median is
//      forecast earners / forecast pool.
//   3. Saturation: each rate as a logistic in log-time toward the same
//      ceiling (story chapters high; platinum and 100% completion near
//      zero in week one).
//   4. Median: weighted blend of persistence, (2) and (3) in logit space.
//      Weights follow the evidence in the case: thin histories lean on the
//      decomposition (it is the only leg that sees first-refresh
//      dilution), rich histories lean on saturation, and a falling recent
//      regime shifts weight to persistence + decomposition.
//   5. Spread: max(random-walk floor, walk-forward refresh-to-refresh
//      volatility inside the history) plus a refresh-jump term that grows
//      when the page has not refreshed for a while, because Exophase
//      refreshes in steps and a stale page is about to jump.
//   6. The story chain is made monotone (first trophy >= chapter 1 >= ...
//      >= final mission >= 100% >= platinum) by pooling adjacent
//      violators on logit medians, since earners of a later step are a
//      subset of the earlier one's; the platinum median is the minimum.
//
// Deterministic: sorted inputs, no randomness, no wall-clock reads beyond
// the case's own timestamps. Node 22+, standard library only, offline.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const RELEASE_MS = Date.UTC(2026, 10, 19, 0, 0, 0);

interface Trophy { id: number; tier: string }
interface Read { slot: string; players_tracked: number; rates: Array<number | null> }
interface Case {
  at: string;
  horizon_minutes: number;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const hoursSinceRelease = (iso: string): number => (Date.parse(iso) - RELEASE_MS) / 3_600_000;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** OLS y ~ a + b*x; returns [a, b, residual RMS]. */
function ols(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  if (n === 0) return [0, 0, 0.8];
  if (n === 1) return [ys[0], 0, 0.8];
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return [my, 0, 0.8];
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  return [a, b, Math.sqrt(ss / n)];
}

/** Week-one ceiling per trophy (percent): story chapters can reach a large
 *  share of tracked players; grind/completion trophies cannot. */
function capOf(t: Trophy): number {
  const byId: Record<number, number> = { 1: 0.5, 2: 100, 3: 65, 4: 55, 5: 45, 6: 38, 7: 30, 14: 0.6 };
  if (byId[t.id] !== undefined) return byId[t.id];
  if (t.tier === 'platinum') return 0.5;
  if (t.tier === 'gold') return 10;
  if (t.tier === 'silver') return 4;
  return 30;
}

function quantilesFrom(medianPct: number, sigma: number): number[] {
  const l = logit(medianPct);
  return Z.map((z) => round4(invLogit(l + z * sigma)));
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  // Distinct refreshes only: consecutive reads with identical pool and
  // rates are the same page read twice and carry no new information.
  const refs: Read[] = [];
  let prevKey = '';
  for (const h of c.history) {
    const key = `${h.players_tracked}|${h.rates.join(',')}`;
    if (key !== prevKey) refs.push(h);
    prevKey = key;
  }
  const last = refs[refs.length - 1];
  // Anchor rate per trophy: its last observed rate (reads may lack one).
  const lastRates = c.trophies.map((_, i) => {
    for (let k = refs.length - 1; k >= 0; k--) {
      const r = refs[k].rates[i];
      if (r !== null && r !== undefined) return r;
    }
    return 0;
  });
  const xs = refs.map((h) => Math.log1p(Math.max(0, hoursSinceRelease(h.slot))));
  const hNow = Math.max(0.1, hoursSinceRelease(c.at));
  const xTgt = Math.log1p(hNow + c.horizon_minutes / 60);
  const dx = Math.max(0, xTgt - xs[xs.length - 1]);
  const dDays = c.horizon_minutes / 1440;
  const stale = Math.max(0, hNow - hoursSinceRelease(last.slot));
  const gaps: number[] = [];
  for (let i = 1; i < refs.length; i++) {
    gaps.push(hoursSinceRelease(refs[i].slot) - hoursSinceRelease(refs[i - 1].slot));
  }
  const meanGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 5;

  // Pool forecast: power law in log-time, anchored at the last refresh.
  let nTgt: number;
  if (refs.length < 2) {
    nTgt = last.players_tracked * (1 + 0.9 * (xTgt - xs[xs.length - 1]));
  } else {
    const ys = refs.map((h) => Math.log(Math.max(1, h.players_tracked)));
    const [, b] = ols(xs, ys);
    const slope = Math.max(0, Math.min(b, 2.5));
    nTgt = Math.exp(ys[ys.length - 1] + slope * (xTgt - xs[xs.length - 1]));
  }

  // Walk-forward volatility + recent regime from refresh-to-refresh moves.
  const wf: number[] = [];
  for (let i = 1; i < refs.length; i++) {
    for (let j = 0; j < lastRates.length; j++) {
      const ra = refs[i - 1].rates[j];
      const rb = refs[i].rates[j];
      if (ra !== null && rb !== null) wf.push(logit(rb) - logit(ra));
    }
  }
  const wfSigma = wf.length > 0 ? median(wf.map((x) => Math.abs(x))) * 1.4826 : 0;
  const regime = wf.length > 0 ? median(wf.slice(-55)) : 0;

  const rows = c.trophies.map((t, i) => {
    const x0 = lastRates[i];
    const cap = capOf(t);

    // Earner forecast -> decomposition median.
    const eLast = (x0 / 100) * last.players_tracked;
    let eTgt: number;
    if (refs.length >= 2 && eLast > 0) {
      const es = refs.map((h) => {
        const ri = h.rates[i] ?? x0;
        return Math.log(Math.max(0.5, (ri / 100) * h.players_tracked));
      });
      const [, b] = ols(xs, es);
      const slope = Math.max(-0.2, Math.min(b, 3));
      eTgt = Math.exp(es[es.length - 1] + slope * 0.65 * dx);
    } else {
      eTgt = eLast * Math.pow(nTgt / Math.max(1, last.players_tracked), 0.35);
    }
    eTgt = Math.min(eTgt, (cap / 100) * nTgt);
    if (x0 >= 99.5) eTgt = nTgt * 0.99;
    const medDecomp = Math.min(99.99, Math.max(0.01, (100 * eTgt) / Math.max(1, nTgt)));

    // Saturation forecast: rate as a logistic in log-time toward its cap.
    const ys = refs.map((h) => {
      const ri = h.rates[i] ?? 0.01;
      const frac = Math.min(0.999, Math.max(0.0001, ri / cap));
      return Math.log(frac / (1 - frac));
    });
    const [, b2raw] = ols(xs, ys);
    const b2 = Math.max(-1, Math.min(b2raw, 2));
    const fracT = 1 / (1 + Math.exp(-(ys[ys.length - 1] + b2 * 0.8 * dx)));
    const medSat = Math.min(99.99, Math.max(0.01, cap * fracT));

    // Evidence-set logit blend.
    let wP = 0.25;
    let wD = 0.25;
    let wS = 0.5;
    if (refs.length < 3) { wP = 0.15; wD = 0.6; wS = 0.25; }
    else if (regime < -0.05) { wP = 0.45; wD = 0.4; wS = 0.15; }
    const medL = wP * logit(x0) + wD * logit(medDecomp) + wS * logit(medSat);
    let med = Math.min(cap, Math.max(0.01, invLogit(medL)));
    if (x0 >= 99.5) med = Math.max(med, 97);

    // Spread: random-walk floor vs walk-forward volatility, + jump term.
    const rw = 0.5 * Math.sqrt(dDays);
    const horizonScale = dx > 0 ? Math.sqrt(dx / 0.4) : 0.3;
    const wfTerm = wfSigma * horizonScale;
    const jump = refs.length < 2
      ? 1.05
      : 0.35 * Math.min(1, stale / Math.max(1, meanGap)) * Math.min(1, dx / 0.3 + 0.3);
    let sigma = Math.sqrt(Math.max(rw, wfTerm) ** 2 * 0.85 + jump ** 2 + 0.22 ** 2);
    sigma = Math.min(1.7, Math.max(0.45, sigma));
    return { id: t.id, q: quantilesFrom(med, sigma) };
  });

  // Story-chain monotonicity by pooling adjacent violators (logit medians).
  const chain = [2, 3, 4, 5, 6, 7, 14, 1];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const present = chain.filter((id) => byId.has(id));
  const vals = present.map((id) => logit(byId.get(id)!.q[2]));
  const blocks: number[][] = vals.map((v) => [v]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k + 1 < blocks.length; k++) {
      const mA = blocks[k].reduce((s, x) => s + x, 0) / blocks[k].length;
      const mB = blocks[k + 1].reduce((s, x) => s + x, 0) / blocks[k + 1].length;
      if (mA < mB) {
        blocks[k] = blocks[k].concat(blocks[k + 1]);
        blocks.splice(k + 1, 1);
        changed = true;
        break;
      }
    }
  }
  const flat: number[] = [];
  for (const bl of blocks) {
    const m = bl.reduce((s, x) => s + x, 0) / bl.length;
    for (let k = 0; k < bl.length; k++) flat.push(m);
  }
  present.forEach((id, k) => {
    const row = byId.get(id)!;
    const sigma = row.q[4] > row.q[0] ? (logit(row.q[4]) - logit(row.q[0])) / (2 * 1.645) : 0.5;
    row.q = quantilesFrom(invLogit(flat[k]), Math.max(0.2, sigma));
  });
  // The platinum requires every other trophy: its median is the lowest.
  const plat = byId.get(1);
  if (plat) {
    for (const r of rows) {
      if (r.q[2] < plat.q[2]) plat.q = quantilesFrom(r.q[2], 0.6);
    }
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
