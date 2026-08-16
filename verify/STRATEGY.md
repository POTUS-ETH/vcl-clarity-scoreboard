# VCL — the strategy specification

The single source of truth for how this system is traded. Everything that backtests it
reads from here. If code and this file disagree, this file is wrong or the code is — one
of them gets fixed, they do not both stand.

## The operating rule

**Every statement carries a provenance tag. Nothing is promoted without cause.**

| Tag | Means | Can I build on it? |
|---|---|---|
| `[CRAIG]` | Stated directly by the trader | Yes |
| `[VERIFIED]` | Reproduced from exchange tape or the logged rows; names its test | Yes |
| `[INFERRED]` | My guess from limited evidence | **No** — flag it in output, never silently rely on it |
| `[OPEN]` | Not known | No |

A line moves `[INFERRED] → [VERIFIED]` only when a named script passes, or
`[INFERRED] → [CRAIG]` only when he confirms it in words. **I never promote my own
inference by deciding it looks right.** That is the exact failure this file exists to
prevent: an assumption made in session 3 gets treated as gospel in session 11, and every
result after it is quietly built on sand.

When something is corrected, the old version is **deleted, not struck through**, and the
change is recorded in the changelog with the date and who corrected it. Two versions of a
rule in one file is how you end up backtesting neither.

---

## 1. Instrument and frame

- `[VERIFIED]` **SOLUSDT perpetual, Bybit.** All 32 logged rows. Schema also allows ETH
  and BTC; neither has been traded yet.
- `[VERIFIED]` **Charts render UTC-4 (New York).** Confirmed three ways: the export
  headers on Craig's screenshots, the x-axis brackets on #13, and 31 of 32 Entry Times
  landing on a bar that actually traded the logged entry price when read as New York.
  Test: `checktimes.js`.
- `[VERIFIED]` **Timeframes 15s and 1m.** Bybit's smallest kline is 1m, so 15s rows
  cannot be ordered intrabar from klines. Tick archive at `public.bybit.com/trading/`
  (1874 daily files) removes this limit once ingested.
- `[VERIFIED]` **Sessions: Asia, London, NY AM, NY PM.**
- `[VERIFIED]` **History available: SOLUSDT perp launched 2021-10-15.** ~4.8 years.

## 2. Geometry

`[VERIFIED]` The fib is drawn on an impulse leg. Six levels matter:

| Level | Role |
|---|---|
| `0` | Stop loss |
| `0.17` | Limit 1 (L1) |
| `0.382` | Entry |
| `1.0` | The anchor — "1 of fib" |
| `1.618` | Target A |
| `2.272` | Target B |

Verified across all 32 rows: every logged price sits on its level to the cent, and #13
was read straight off Craig's own chart (73.84 / 73.89 / 73.94 / 74.10 / 74.26 / 74.43).

- `[CRAIG]` **Clearing the anchor moves the stop to break-even.** This is the pivot the
  whole system turns on — it gates every one of the twelve outcomes.
- `[VERIFIED]` **Break-even means the POSITION breaks even** — the blended average of the
  fills, not the entry price. A two-fill trade stopped at BE returns exactly 0, not the
  L1 leg's gain. Test: `outcomes.js` (audit A, 252 cells, 0 mismatches).
- `[VERIFIED]` **The logged prices are DRAWN LEVELS, not order prices.** A wick that
  touches a level to the exact tick does not trigger it — price must trade through.
  Strict agrees with the log on 30 of 31 rows against inclusive's 28. Test: `tick.js`.
  This is why a real stop sits a few ticks beyond the drawn fib-0.
- `[OPEN]` **How the leg is chosen.** ← *the blocker for autonomous backtesting.* Fib
  placement is discretionary: on one trade the anchor sat exactly on a tape high while
  fib-0 was 26c off the window low. No algorithm recovers that without the rule.

## 3. Risk

- `[CRAIG]` **1R = (Entry − SL) + (L1 − SL), directional.** Always the full two-fill risk,
  whether or not L1 filled. R measures against the risk the *structure* puts up.
- `[CRAIG]` **The fill is not a choice.** Entry-only and entry+L1 are the same trade
  structure. They must never be split into rival statistics — splitting inflates whichever
  side has the cheaper basis. One score per trade, dispatched by whether L1 actually filled.
- `[VERIFIED]` The **numerator** counts only fills that happened. An entry-only trade that
  stops out loses less than 1R (~0.70R typically). That is a real outcome, not a rounding
  convenience.

## 4. Management

Four methodologies × the fill dispatch = the twelve scored columns.

- **BE** — stop to break-even on clearing the anchor; exit at target, or 0R at BE.
- **PVS** — the position-VWAP trail.
- **50% off** — `[CRAIG]` half the blended position banked **at the 1-of-fib**, remainder
  rides. (Changed 2026-08-16 from "when price returns to entry".)
- **EVS** — `[CRAIG]` **RETIRED 2026-08-16.** Scored identical to plain BE on every
  matched trade (+0.000R paired delta over 31 trades).

### PVS — what is and isn't known

- `[VERIFIED]` On Craig's charts, PVS is a **drawn level**: an anchored-VWAP curve runs
  forward and, where price gives it up, a horizontal ray carries that value across the
  chart, labelled and tagged on the price axis. Read directly off three of four
  screenshots: #13 74.11, #14 73.50, #20 74.57 — all exact.
- `[CRAIG]` "The PVS trail only trails the BoS if it is protected by that AVWAP."
- `[OPEN]` **The anchor.** None of peak / entry / leg-start AVWAP reproduces all four
  hand-read rays. Four points with a free lookback will fit anything, so `derive.js`
  `pvsTrail()` remains **UNVALIDATED and is never written back.**

## 5. Known data defects

- `#9` PVS Price logged 73.92; his own chart shows the ray **below** the 0.618 line at
  ~73.81. Awaiting his re-read.
- `#24` Moved-Stop-to-BE is false while its own Max Run (73.67) sits 37c past the anchor
  (74.04) with PVS Hit 1.618 ticked. Self-contradictory; scores are unaffected.
- `#23` entry logged 73.70, but that minute traded 73.71–73.74 and 73.70 never printed.
- 92 stray cells: entry-only columns populated on L1-filled rows. Never read by the
  board (`tradeR()` dispatches on L1 Filled); a landmine for anyone averaging a column.

---

## 6. OPEN QUESTIONS — what I need to backtest this myself

Answer by number; each answer updates this file and, where possible, gets a test that
replays it against the 32 logged trades.

1. **Leg selection.** What defines the swing the fib is drawn on? The screenshots show
   `CHoCH` labels — is change-of-character the trigger? Is there a minimum leg size, a
   lookback, a required BoS first?
2. **The filter.** What makes a setup takeable vs skippable? The screenshots show a
   `TT Transition / EMA lineup / 5m 15m 1H 4H → BULLISH/BEARISH` panel — is that a gate?
3. **The indicators.** The chart legend is collapsed to "⌄5" in every screenshot. What
   are the five, and which are decision-relevant vs decoration?
4. **Direction.** How is long vs short decided?
5. **PVS anchor.** Precisely where does the VWAP anchor, and what confirms a BoS for the
   trail to advance?
6. **Session.** Are all four traded the same way? Any session-specific rules?
7. **Timeframe.** When 15s vs 1m — and does the rule change with it?
8. **Invalidation.** Any time stop, news blackout, or "walk away" condition?
9. **Rejected setups.** ← *the highest-value gap.* Every logged row is a trade he TOOK.
   With zero negative examples, any detector I build fires on everything structurally
   similar and the win rate collapses. Half the edge is what he skips, and none of it is
   recorded.

---

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-08-16 | File created. Seeded from 32 logged rows, the Notion schema, four chart screenshots, and this session's verification work. | — |
| 2026-08-16 | EVS retired; 50%-off gate moved from "returns to entry" to the 1-of-fib. | Craig |
| 2026-08-16 | Stop-touch read as strict (trade through, not touch). | `tick.js` |
| 2026-08-16 | Break-even confirmed as blended average, not entry price. | `outcomes.js` |
