// Token Launch Radar — the scoring model (radar-2).
//
// A protocol's implied value answers one question: if this protocol issued a
// token tomorrow and the market priced it like the tokens its peers already
// trade at, what would it be worth? Everything below is computed from the
// sealed snapshot itself. No protocol name is ever special-cased.
//
//   peer multiple  — the median market-cap / TVL of the live-token protocols
//                     in the same category (at least 3 peers, else the whole
//                     market's median), clamped to [0.03, 1.00]
//   base           — tvl_usd x peer multiple
//   growth         — change_7d clamped to [-60, 120] per cent;
//                     multiplier = 1 + (growth / 100) x 0.5
//   maturity       — 0.6 + min(age_days, 1095) / 1095 x 0.4 (unknown age: 365)
//   implied value  — base x growth multiplier x maturity multiplier
//
// The board ranks every protocol on the snapshot's watchlist (the floor, never
// the ceiling) plus every other rankable pre-token protocol below the floor:
// pre-token, not a CEX, and not a versioned pool of another protocol. The
// live-token protocols are kept apart in their own view, priced by the market,
// never mixed into the ranked board.

/** One protocol as the sealed snapshot carries it: exactly ten fields. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard and the README. */
export const MODEL = {
  version: 'radar-2',
  minPeers: 3,
  multipleLow: 0.03,
  multipleHigh: 1.0,
  growthWeight: 0.5,
  growthLow: -60,
  growthHigh: 120,
  maturityFloor: 0.6,
  maturityRange: 0.4,
  maturityDays: 1095,
  unknownAgeDays: 365,
} as const;

/** How many live-token protocols the Live view carries, by market cap. */
export const LIVE_COUNT = 24;

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The middle value of a sorted list, or null when it is empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from `listedAt` to `asOf`, or null when either date is missing. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records no token for this protocol. */
export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker (V2, v2, 2.0 ...) is a pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the board may rank this protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: Protocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/**
 * The peer multiple for a category: the median market-cap / TVL of the
 * live-token protocols in that category. Categories with too few peers fall
 * back to the whole market's median. The result is clamped so one wild peer
 * (a tiny TVL with a huge market cap, or the reverse) cannot set the price.
 */
export function peerMultiples(protocols: Protocol[]): { byCategory: Map<string, number>; overall: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of protocols) {
    if (isPreToken(p) || !p.mcap_usd || !p.tvl_usd) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!(ratio > 0) || !Number.isFinite(ratio)) continue;
    allRatios.push(ratio);
    const key = p.category ?? '(no category)';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
  }
  const overall = median(allRatios) ?? 0.2;
  const clamp = (v: number): number => Math.min(MODEL.multipleHigh, Math.max(MODEL.multipleLow, v));
  const byCategory = new Map<string, number>();
  for (const [key, list] of ratiosByCategory) {
    const m = median(list);
    if (list.length >= MODEL.minPeers && m !== null) byCategory.set(key, clamp(m));
  }
  return { byCategory, overall: clamp(overall) };
}

/** How many live peers a category's multiple rests on (0 when it falls back). */
export function peerCount(protocols: Protocol[], category: string | null): number {
  const key = category ?? '(no category)';
  let n = 0;
  for (const p of protocols) {
    if (isPreToken(p) || !p.mcap_usd || !p.tvl_usd) continue;
    if ((p.category ?? '(no category)') === key) n++;
  }
  return n;
}

/** One protocol's score: its implied value and every factor behind it. */
export interface Score {
  implied: number;
  peerMultiple: number;
  peerPeers: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
}

export function scoreProtocol(
  p: Protocol,
  asOf: string,
  peers: { byCategory: Map<string, number>; overall: number },
  all: Protocol[],
): Score {
  const key = p.category ?? '(no category)';
  const peerMultiple = peers.byCategory.get(key) ?? peers.overall;
  const peerPeers = peerCount(all, p.category);
  const growthPct = Math.min(MODEL.growthHigh, Math.max(MODEL.growthLow, num(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * MODEL.growthWeight;
  const age = ageInDays(asOf, p.listed_at);
  const ageForModel = age ?? MODEL.unknownAgeDays;
  const maturityMult =
    MODEL.maturityFloor + (Math.min(Math.max(ageForModel, 0), MODEL.maturityDays) / MODEL.maturityDays) * MODEL.maturityRange;
  const implied = Math.max(1, Math.round(p.tvl_usd * peerMultiple * growthMult * maturityMult));
  return { implied, peerMultiple, peerPeers, growthPct, growthMult, maturityMult, age };
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    peer_multiple: number;
    peer_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact row: the board with its farm plan. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  on_watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol for the dashboard's Live view, priced by the market. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_per_tvl: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Build the ranked board: the watchlist first, then every rankable pre-token protocol below the floor. */
export function buildBoard(snapshot: SnapshotDoc): BoardRow[] {
  const peers = peerMultiples(snapshot.protocols);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Protocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, peers, snapshot.protocols) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((entry, i) => {
    const { p, s } = entry;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        peer_multiple: round4(s.peerMultiple),
        peer_count: s.peerPeers,
        growth_pct: round2(s.growthPct),
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        age_days: s.age,
      },
      farm_steps: farmPlan(p, s.age).map(joinStep),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: SnapshotDoc): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_COUNT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_per_tvl: p.mcap_usd && p.tvl_usd ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** The board plus the dashboard's data, from the snapshot. */
export function buildRadar(snapshot: SnapshotDoc): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      peer_multiple: r.model.peer_multiple,
      peer_count: r.model.peer_count,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      on_watchlist: snapshot.watchlist.includes(r.slug),
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- farm plans

/** One farm step: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string for board.json, inside the gate's 20..600 characters. */
export function joinStep(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Typical gas for one transaction on a chain, in dollars. */
function gasOn(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return '$4 to $8';
  if (c.includes('bitcoin') || c.includes('b squared') || c.includes('bsquared')) return '$2 to $5';
  if (c.includes('solana') || c.includes('sui') || c.includes('aptos')) return 'under $0.10';
  if (c.includes('tron')) return 'under $1';
  return '$0.20 to $1';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: Protocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The farm family a protocol belongs to, from its category. */
export function familyOf(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('dex') || c.includes('leveraged farm') || c.includes('liquidity manager')) return 'dex';
  if (c.includes('yield')) return 'yield';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('stak') || c.includes('restak')) return 'staking';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('prediction') || c.includes('options'))
    return 'trading';
  if (c.includes('rwa') || c.includes('stable')) return 'rwa';
  if (c.includes('curator') || c.includes('allocator') || c.includes('index')) return 'curator';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('chain') || c.includes('payment')) return 'chain';
  return 'general';
}

/**
 * A protocol's farm plan: six concrete steps, each with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names.
 */
export function farmPlan(p: Protocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const gas = gasOn(chain);
  const name = p.name;
  const setup: FarmStep = {
    text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  };
  const weekly: FarmStep = {
    text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
    cost: `about ${gas} of gas a week`,
    time: '10 minutes a week',
  };
  const holdStep: FarmStep = {
    text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
    cost: `the $${capital} stays in the position`,
    time: `${hold} days`,
  };
  const claim: FarmStep = {
    text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
    cost: 'no fee to check, and never pay to claim',
    time: '10 minutes',
  };
  const log: FarmStep = {
    text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
    cost: 'nothing but the log',
    time: '5 minutes',
  };
  const main: FarmStep = (() => {
    switch (familyOf(p)) {
      case 'lending':
        return {
          text: `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it and repay it once.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '20 minutes to set up',
        };
      case 'dex':
        return {
          text: `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and make one swap through it each week.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '20 minutes to set up',
        };
      case 'yield':
        return {
          text: `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and harvest the rewards weekly.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '15 minutes to set up',
        };
      case 'bridge':
        return {
          text: `Bridge $${capital} of USDC to ${chain} through ${name}, use the bridged funds in its app, then bridge a small amount back.`,
          cost: `$${capital} of capital, about ${gas} of gas, plus the bridge fee`,
          time: '20 minutes to set up',
        };
      case 'staking':
        return {
          text: `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in your wallet.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '15 minutes to set up',
        };
      case 'trading':
        return {
          text: `Deposit $${capital} of USDC as margin on ${name} on ${chain}, open one small position, and close it the same week.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '20 minutes to set up',
        };
      case 'rwa':
        return {
          text: `Mint $${capital} of the yield-bearing asset ${name} offers on ${chain} and hold it through one full distribution cycle.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '15 minutes to set up',
        };
      case 'curator':
        return {
          text: `Deposit $${capital} into a ${name} vault on ${chain}, check which strategy it allocated to, and keep the shares.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '15 minutes to set up',
        };
      case 'insurance':
        return {
          text: `Buy $${capital} of cover from ${name} on ${chain} for a protocol you already use, and keep the policy active.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '20 minutes to set up',
        };
      case 'chain':
        return {
          text: `Bridge $${capital} of USDC to ${chain}, use one native app on it through ${name}, and keep a small balance there.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '20 minutes to set up',
        };
      default:
        return {
          text: `Deposit $${capital} of USDC into ${name} on ${chain} and use its main feature once a week.`,
          cost: `$${capital} of capital and about ${gas} of gas`,
          time: '15 minutes to set up',
        };
    }
  })();
  return [setup, main, weekly, holdStep, claim, log];
}

// ---------------------------------------------------------------- validation

/** Why a board is not one the gate will take, or null when it passes every row. */
export function boardIssue(board: BoardRow[], snapshot: SnapshotDoc): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `${r.slug} has a farm step of ${n} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new Error('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new Error('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The dashboard's data as one script: `window.RADAR = {...};`, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
