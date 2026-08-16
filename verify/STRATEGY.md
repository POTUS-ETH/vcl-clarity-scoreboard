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

## 2. Trend — read first, before anything else

> **STATUS: being taught 2026-08-16. INCOMPLETE — more coming from Craig.**
> Do not start building a detector off this section yet.

- `[CRAIG]` **Trend is identified top-down across three timeframes: daily → 1 hour →
  15 minute.** The high timeframe is read first and the lower ones refine it.
- `[CRAIG]` **Trade with the trend, not against it.** "Try not to fight the trend."

## 3. The two setup archetypes

`[CRAIG]` There are two triggers, and they differ in where the **1-of-fib** is anchored:

**A — Change of character after a correction.**
Price is trending, puts in a corrective move against that trend, and a CHoCH marks the
correction ending. The system capitalises on the resumption.

**B — Trend continuation off a break of structure.**
The 1-of-fib is anchored to the **break-of-structure high**.

Both anchor the fib to a structural extreme, which is what makes the claim testable —
`anchors.js` checks whether every logged anchor sits on a swing high (long) or swing low
(short) formed before the entry bar. *Not yet run — waiting for the teaching to finish.*

### Still open on this section

- Where does **fib 0** go in each archetype? Craig has specified the 1; the 0 (the stop,
  and the other end of the leg) is not yet stated.
- For archetype A, is the anchor the swing the CHoCH broke, or the extreme of the
  corrective move itself?
- Which timeframe is the fib drawn on — the trade timeframe (1m/15s), or the 15m?
- Must all three timeframes agree, or does the daily set bias while 15m only times it?

## 4. Geometry

### How the fib is CONSTRUCTED — the order matters

`[CRAIG]` The fib is **not** drawn low-to-high with the entry falling out of it. It is
pinned by two points and the rest is solved:

1. **The 1-of-fib** goes on structure — the CHoCH, or the break-of-structure high (§3).
2. **The entry** goes **one tick beyond the selected AVWAP** (above it on a long).
3. **The 0 is then derived**, because the entry must land on 0.382 of the 0→1 range.

```
zero = (entry - 0.382 * anchor) / 0.618
```

`[VERIFIED]` **32 of 32 rows, every one within a single tick** (mean absolute error
0.0049 — precisely two-decimal rounding of a computed level, not a judgement call). With
0 and 1 pinned, L1, 1.618 and 2.272 are all forced within a tick as well: the six levels
are one linear family. Test: `fibsolve.js`.

**What this collapses.** The geometry has exactly **two** discretionary inputs — the
structural anchor, and which AVWAP is selected. The stop, L1 and both targets are
arithmetic. This retires the earlier belief that fib-0 was a chosen swing low: it never
was, which is why it sat 26c off the window low on the trade that first raised the
question.

**Consequence for risk.** Since `entry - zero = 0.382(a-z)` and `L1 - zero = 0.17(a-z)`:

```
1R = 0.552 * (anchor - zero)  =  0.893 * (anchor - entry)
```

So position risk is set entirely by the gap between the AVWAP and the structure. A wide
AVWAP-to-structure distance is a wide stop, and there is no separate sizing decision.

`[OPEN]` **Which AVWAP is "the selected" one** — anchored to what event? This is now the
single remaining unknown in the geometry.

Six levels:

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
- `[OPEN]` **Where exactly the structural anchor lands** in each archetype (§3). Half of
  what used to be "the blocker" is gone — fib-0 is solved, not chosen — so what remains is
  the anchor and the AVWAP selection, nothing else.

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

1. ~~**Leg selection.**~~ **PARTLY ANSWERED 2026-08-16.** The 0 is solved from the entry
   and the 1, not chosen (§4). Still open: exactly where the structural anchor lands in
   each archetype, and **which AVWAP the entry is set a tick beyond** — that is now the
   only free input left in the geometry.
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
