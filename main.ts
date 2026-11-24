// Pump.fun Replay Sprint bot — "Early Sniper, Patient Exit"
// Entry for make.fun's "Winner Takes All — $5 Pump.fun Replay Sprint".
// Strategy, in one paragraph:
//   Buy a fresh bonding curve as early as possible (its first 20 trades),
//   in the minimum 0.01 SOL size, then let winners run: take half at
//   +50%, trail the rest (exit if it falls 25% from a +50% peak), cut
//   every loser at -15%, and time-stop any stalled token after 50 trades
//   or 5000 slots. One shot per mint, at most 5 open positions, never
//   more than 1% of a curve's real SOL reserve in one batch (the harness
//   cap), never a size below the 0.01 SOL round-trip minimum. No clock,
//   no randomness, no network, no environment reads: the only inputs are
//   the hello / batch / slot messages the harness sends, so the two
//   grading runs agree byte for byte.
//
// Why this shape: on the kit's dev window (1,222 mints, 126,801 trades
// over 24h) the median mint ends down and only ~12% finish positive,
// but ~30% spike +50% and ~16% spike +100% at some point. Holding
// loses; the money is in catching the early spike and leaving before
// the fade. Buying after a big spike is worse than buying at inception,
// so the entry filter skips mints that already ran +60% or dumped -20%.
// A sell-wall dump in the first trades (sell volume >> buy volume)
// is also a skip: that is the rug / dump signature in this data.
// Small size matters: at 0.01 SOL the 1%-of-reserve cap rarely binds
// late entries, and the fixed tx fee stays small next to the position.
// Long holds matter too: the 5-position cap plus slow exits keeps the
// bot to ~60 mints per day, and the marginal mint in this data loses
// money, so trading less — but holding runners longer — beats churning.
//
// Fees matter: ~1.25% curve fees per side plus 105,000 lamports of
// tx fees per order, so a round trip costs ~2.7% of size. A +50%
// first take-profit clears that many times over; a -15% stop keeps
// one bad tick from ever blowing up the 10 SOL paper bankroll.
//
// Dev result (this competition's kit grade-local, process driver):
// -0.063 SOL net PnL, 62 distinct mints, 22.6% win rate, 0.87% max
// drawdown — better than every kit baseline (best baseline: sniper
// -0.423 SOL) but still slightly negative, so the honest expectation
// for the final 6h window is a coin flip decided by whether it
// catches a runner. A stress test of 12 rebuilt windows for this
// same strategy was negative every time (median -0.18 SOL).

import { runBot, type BotState, type Batch, type OrderInput } from "./vendor/makefun-bot.ts";

// ---- tunables (all in one place so a sweep can move them) ----
const BUY_LAMPORTS = 10_000_000n;
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: guardrail round-trip minimum
const MAX_OPEN = 5;
const MAX_BUYS_PER_BATCH = 2;
const MAX_ENTRY_TRADES = 20;
const MAX_ENTRY_SLOT_AGE = 600; // ...or within 600 slots of its creation
const SKIP_IF_RAN_UP = 0.6; // already +60% from its first price: too late
const SKIP_IF_DUMPED = -0.2; // already -20% from its first price: dead/dumping
const TAKE_PARTIAL_AT = 0.5;
const TRAIL_AFTER_PEAK = 0.5;
const TRAIL_DROP = 0.25;
const STOP_LOSS = -0.15;
const TIME_STOP_TRADES = 50;
const TIME_STOP_SLOTS = 5000;
const BUY_SLIPPAGE_BPS = 10000;
const SELL_SLIPPAGE_BPS = 10000;

interface MintTrack {
  firstPrice: number;
  peakRet: number;
  trades: number;
  buySol: bigint;
  sellSol: bigint;
  createdSlot: number | null;
  entrySlot: number | null;
  entryTrades: number;
  partialDone: boolean;
  done: boolean; // exited or skipped for good: one shot per mint
}

const tracks = new Map<string, MintTrack>();

function priceOf(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

// How many tokens can be sold in one order without the curve refusing
// it: a sell is rejected (max_order_size) when the SOL it would take
// from the curve exceeds the curve's real SOL reserves. A rug drains
// those reserves, so a dying mint can only be exited in slices sized
// to a fraction of what is left. Solve the constant-product quote
// q = vq*t/(vt+t) for t at q = half the real reserves.
// Returns 0 when the slice is not worth selling at all: a sell whose
// proceeds are below the tx fee is rejected as zero_amount, and a
// position worth less than ~3x the tx fee is dust — abandon it instead
// of retrying a rejected order on every batch for the rest of the run.
const MIN_SELL_VALUE_LAMPORTS = 300_000n; // ~3x the 105,000 tx fee
function sellableTokens(
  state: BotState,
  mint: string,
  holdingTokens: bigint,
  priceLamportsPerToken: number,
): bigint {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return 0n;
  const targetQ = c.real_quote_reserves / 2n;
  if (targetQ <= 0n) return 0n;
  const vq = c.virtual_quote_reserves;
  const vt = c.virtual_token_reserves;
  const chunk =
    targetQ >= vq ? vt : (targetQ * vt) / (vq - targetQ);
  const amount = chunk >= holdingTokens ? holdingTokens : chunk;
  if (amount <= 0n) return 0n;
  const estValue = BigInt(Math.floor(Number(amount) * priceLamportsPerToken));
  if (estValue < MIN_SELL_VALUE_LAMPORTS) return 0n;
  return amount;
}

function pendingFor(state: BotState, mint: string, side: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function trackFor(mint: string): MintTrack {
  let t = tracks.get(mint);
  if (!t) {
    t = {
      firstPrice: 0,
      peakRet: 0,
      trades: 0,
      buySol: 0n,
      sellSol: 0n,
      createdSlot: null,
      entrySlot: null,
      entryTrades: 0,
      partialDone: false,
      done: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

await runBot({
  onHello(_state) {
    // Nothing to seed: hello carries capital, caps and fees, and the
    // strategy reads them from state on every batch instead.
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // ---- 1. Fold this batch's events into the per-mint tracks ----
    for (const e of batch.events) {
      const t = trackFor(e.mint);
      if (e.event === "CreateEvent") {
        t.createdSlot = e.slot;
      } else if (e.event === "TradeEvent") {
        t.trades += 1;
        if (e.is_buy) t.buySol += BigInt(e.sol_amount);
        else t.sellSol += BigInt(e.sol_amount);
        const p = priceOf(state, e.mint);
        if (p !== null && t.firstPrice === 0) t.firstPrice = p;
      } else if (e.event === "CompleteEvent") {
        t.done = true; // migrated: no more trading, harness closes it
      }
    }

    // ---- 1b. A mint we entered and no longer hold is done: one shot. ----
    for (const [mint, t] of tracks) {
      if (t.entrySlot !== null && !t.done && !state.positions.has(mint)) {
        if (!pendingFor(state, mint, "buy") && !pendingFor(state, mint, "sell")) {
          t.done = true;
        }
      }
    }

    // ---- 2. Exits first: protect every open position ----
    for (const [mint, holding] of state.positions) {
      const t = tracks.get(mint);
      const price = priceOf(state, mint);
      if (!t || price === null || holding.token_amount === 0n) continue;
      // One exit order at a time per mint: never stack sells on a fill
      // that has not come back yet.
      if (pendingFor(state, mint, "sell")) continue;
      const costPerToken =
        Number(holding.cost_lamports) / Number(holding.token_amount);
      if (costPerToken <= 0) continue;
      const ret = price / costPerToken - 1;
      if (ret > t.peakRet) t.peakRet = ret;
      const tradesHeld = t.trades - t.entryTrades;
      const slotsHeld =
        t.entrySlot === null ? 0 : state.slot - t.entrySlot;

      const stopHit = ret <= STOP_LOSS;
      const trailHit =
        t.peakRet >= TRAIL_AFTER_PEAK && ret <= t.peakRet - TRAIL_DROP;
      const stalled =
        (tradesHeld >= TIME_STOP_TRADES || slotsHeld >= TIME_STOP_SLOTS) &&
        ret < TAKE_PARTIAL_AT;

      if (stopHit || trailHit || stalled) {
        const amount = sellableTokens(state, mint, holding.token_amount, price);
        if (amount === 0n) {
          // Curve is drained: nothing sellable left, stop retrying and
          // let the harness write the bag off instead of spamming
          // rejected orders for the rest of the run.
          t.done = true;
          continue;
        }
        orders.push({
          side: "sell",
          mint,
          token_amount:
            amount >= holding.token_amount ? holding.token_amount : amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        continue;
      }
      // Partial take-profit: half at +50%, let the rest trail.
      if (!t.partialDone && ret >= TAKE_PARTIAL_AT) {
        const half = holding.token_amount / 2n;
        const amount = sellableTokens(state, mint, half, price);
        if (amount === 0n) {
          t.done = true;
          continue;
        }
        orders.push({
          side: "sell",
          mint,
          token_amount: amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        t.partialDone = true;
      }
    }
    if (orders.length > 0) return orders;

    // ---- 3. Entries: fresh mints only, small and filtered ----
    if (state.committedPositionCount() >= MAX_OPEN) return orders;
    let buys = 0;
    for (const e of batch.events) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (state.committedPositionCount() >= MAX_OPEN) break;
      if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
      const mint = e.mint;
      const t = tracks.get(mint);
      const curve = state.curves.get(mint);
      if (!t || !curve || curve.complete || t.done) continue;
      if (state.positions.has(mint)) continue;
      // Pending orders are keyed by client id, not mint: check them too.
      if (pendingFor(state, mint, "buy")) continue;

      // Only in the mint's first few trades / shortly after creation.
      if (t.trades > MAX_ENTRY_TRADES) continue;
      if (
        t.createdSlot !== null &&
        state.slot - t.createdSlot > MAX_ENTRY_SLOT_AGE &&
        t.trades > 1
      ) {
        continue;
      }
      // Need at least one trade so the curve has real reserves to size
      // against (a bare CreateEvent has real SOL reserves of 0).
      if (t.trades < 1) continue;

      const price = priceOf(state, mint);
      if (price === null || t.firstPrice === 0) continue;
      const fromFirst = price / t.firstPrice - 1;
      // Late top-tick entry: the spike already happened.
      if (fromFirst >= SKIP_IF_RAN_UP) {
        t.done = true;
        continue;
      }
      // Already dumping from its first price.
      if (fromFirst <= SKIP_IF_DUMPED) {
        t.done = true;
        continue;
      }
      // Rug / sell-wall filter: early sell volume dwarfing buy volume.
      if (t.trades >= 2 && t.sellSol > 3n * t.buySol && t.buySol > 0n) {
        t.done = true;
        continue;
      }

      // Dynamic sizing: fixed 0.01 SOL, capped by the harness's 1% of
      // real reserve, by free cash, and floored at the 0.01 SOL minimum.
      const cap = state.maxBuyLamports(mint);
      let size = BUY_LAMPORTS;
      if (size > cap) size = cap;
      const free = state.freeCashLamports() - state.txFeeLamports();
      if (size > free) size = free;
      if (size < MIN_BUY_LAMPORTS) continue;

      orders.push({
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      t.entrySlot = state.slot;
      t.entryTrades = t.trades;
      t.peakRet = 0;
      buys += 1;
    }
    return orders;
  },

  onDone(_state, _done) {
    // Final account is already flattened by the harness; nothing to do.
  },
});
