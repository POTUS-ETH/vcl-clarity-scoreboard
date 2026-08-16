# VCL — the strategy specification

**VCL = VWAP Continuation Ladder.** Inevitrade's Sweep + BoS continuation strategy on the
15s–1m timeframe.

The single source of truth for how this system is traded. Everything that backtests it
reads from here. If code and this file disagree, one of them gets fixed — they do not
both stand.

## The operating rule

**Every statement carries a provenance tag. Nothing is promoted without cause.**

| Tag | Means | Build on it? |
|---|---|---|
| `[SOP]` | From the written VCL SOP page ([link](https://app.notion.com/p/3b27e54146b58108b338c0c9b94a7746)) | Yes — but see §7, the SOP and the live board disagree on targets |
| `[CRAIG]` | Said directly, in conversation | Yes |
| `[VERIFIED]` | Reproduced from exchange tape or the logged rows; names its test | Yes |
| `[INFERRED]` | My guess from limited evidence | **No** — flag it, never silently rely on it |
| `[OPEN]` | Not known | No |

A line moves to `[VERIFIED]` only when a named script passes, or to `[CRAIG]` only when he
confirms it in words. **I never promote my own inference because it looks right.** That is
the failure this file exists to prevent: a guess made in session 3 treated as gospel in
session 11, with every result after it built on sand.

Corrections **delete** the old version rather than striking it through. Two versions of a
rule in one file is how you end up backtesting neither.

---

## 1. Instrument and frame

- `[VERIFIED]` **SOLUSDT perpetual, Bybit.** All 32 logged rows.
- `[SOP]` **Crypto target timeframe is 1m** (futures use 15s). ~2 trades/session on 1m,
  ~5 on 15s.
- `[SOP]` **Crypto is not session-restricted** — tradeable across all sessions, unlike
  futures where liquidity thins outside specific windows.
- `[VERIFIED]` **Charts render UTC-4 (New York).** Test: `checktimes.js`.
- `[VERIFIED]` **History: SOLUSDT perp launched 2021-10-15** (~4.8 yrs). 1m klines free;
  tick archive at `public.bybit.com/trading/` (1874 daily files) for 15s and intrabar order.

## 2. Trade criteria — the six steps

`[SOP]` In order:

1. **Macro trend (≥15m) bias** — market structure still intact.
2. **Micro trend (≤15m) aligns with macro.** If it doesn't, wait for alignment or for a
   macro structure break. Do not trade.
3. **Sweep of a consolidation.**
4. **Break of Structure (BoS)** in the bias direction.
5. **Anchored VWAP dropped on the sweep candle.**
6. **Fib's "1" anchored to the high/low *after* the BoS.**

`[CRAIG]` Trend is read top-down: **daily → 1 hour → 15 minute.** Trade with it, not
against it.

`[SOP]` Directionality: a bearish micro looks for a sweep of a *bullish* impulse that
reverses, and vice versa.

`[SOP]` **There is no oscillator or indicator filter. The AVWAP anchor plus a confirmed
BoS is the entire trade trigger.** This closes the question of what the five collapsed
chart indicators do: they are not decision-relevant.

`[SOP]` **Crypto requires an EXTERNAL structure sweep.** Internal-structure sweeps are
acceptable on futures only — crypto liquidity is split across venues, so an internal level
is too noisy to anchor on.

## 3. Construction

### 3a. The AVWAP anchor — CRYPTO USES CRAIG'S VARIANT, NOT THE SOP'S SWEEP

`[CRAIG]` **We trade Craig's methodology. Most SOP criteria stand, but the sweep step does
not** — on crypto, price action makes a sweep too hard to identify reliably.

**What replaces it:**

> Anchor off a **swing low or high that has reacted to an FVG**. The reaction should carry
> **increased volume**. Anchor on the **extreme candle that led to the BoS/ChoCh**, and
> enter at the VWAP anchored there.

`[CRAIG]` **The FVG is found on a higher timeframe — 5m or 15m. The anchor and the
execution are always on the 1m**, either way, so long as the setup aligns with one of
those two principles.

`[OPEN]` **5m FVG vs 15m FVG — which works better is not yet known.** This is a defined
A/B the backtest is meant to settle, not a thing to assume. Treat it as two variants of
the strategy until the data says otherwise.

`[OPEN]` Craig said "the highest candle that led to a BoS/ChoCh". On a long the anchor
should be the swing **low** of the FVG reaction. Confirm whether "highest" was generic for
"the extreme candle in the relevant direction", or whether longs genuinely anchor on a high.
Not assumed either way.

**Method note — the anchor cannot be recovered from the entry price.** `anchorsolve.js`
inverted the relationship: since the entry sits a slight gap beyond the AVWAP, and an
anchored VWAP is fully determined by its anchor bar, scanning candidate anchors should
recover it. It does not. An AVWAP is nearly flat in its anchor over these windows, so even
demanding the gap be **within a single tick** leaves a median of 7 viable anchors per trade
(600 searched). All 32 rows "solve", which is exactly the problem.

The consequence is a build order, not a dead end. Narrowing 600 candidates to ~7 is a
**98.8% reduction** — a powerful validator, a useless identifier. So:

1. The **structural rule** (FVG reaction + volume + BoS) must pick the anchor.
2. The **AVWAP-to-entry relationship then checks it** — a detector whose chosen bar falls
   outside the ~7-candidate set is provably wrong on that row.

That gives any future anchor detector an immediate, independent pass/fail per trade, which
is a better position than either piece alone. It also means **the FVG-timeframe question
(5m vs 15m) cannot be settled by inversion** — an earlier attempt scored 29/32 on *both*,
which is the signature of a test that does not discriminate rather than agreement.

`[SOP]` *(retained for futures, and as the origin of the model)* The SOP anchors instead on
the **highest/lowest candle wick that swept the prior low/high near the end of the
consolidation, before the BoS** — VCL's core "Sweep + BoS" variant, the solid green line.
On crypto this is superseded by the FVG rule above.

`[SOP]` **The fib's 1** — the highest/lowest point *after* the BoS.

`[CRAIG]` **The entry** — fib 0.382, placed with a slight gap **above** the AVWAP on a
long, **below** it on a short.

`[CRAIG]` **The 0 is then derived**, since the entry must land on 0.382 of the 0→1 range:

```
zero = (entry - 0.382 * anchor) / 0.618
```

`[VERIFIED]` **32 of 32 rows, every one within a single tick** (mean abs error 0.0049 —
two-decimal rounding of a computed level, not a judgement call). Checked split by side so
a rule fitted to the majority class couldn't hide: 20 longs and 12 shorts both pass. With
0 and 1 pinned, L1 (0.17), 1.618 and 2.272 are forced within a tick too. Test: `fibsolve.js`.

`[SOP]` The 0 "sits at, or just beyond, the AVWAP anchor candle" — a consequence of the
construction, not an independent choice.

**So the geometry has exactly two free inputs: the sweep candle, and the post-BoS extreme.**
Everything else is arithmetic.

`[VERIFIED]` The logged prices are **drawn levels, not order prices** — a wick touching a
level to the tick does not trigger it; price must trade through. Strict beats inclusive
30–28 across 31 rows. Test: `tick.js`.

## 4. Risk

- `[CRAIG]` `[VERIFIED]` **1R = (Entry − SL) + (L1 − SL) = 0.552 × (anchor − zero)**, always
  the full two-fill ladder risk, whether or not L1 filled.
- Equivalently **1R = 0.893 × (anchor − entry)** — risk is set entirely by the gap between
  the AVWAP and the post-BoS structure. There is no separate sizing decision.
- `[CRAIG]` **The fill is not a choice.** Entry-only and entry+L1 are the same trade
  structure and must never be split into rival statistics. One score per trade, dispatched
  by whether L1 actually filled.
- `[VERIFIED]` The numerator counts only fills that happened — an entry-only stop-out loses
  ~0.70R, not 1R. Test: `outcomes.js`.
- `[SOP]` Position size is set off the entry price alone, or the blended entry+L1 average
  when both fill. VCL sets **no fixed Qty₁:Qty₂ ratio** (unlike TCL) — split it however
  keeps total risk at the chosen amount.

## 5. Management

- `[SOP]` **Full exit at target, or a discretionary 50% partial at the same marker** — if
  partial, the remainder rides a **pure BoS trail with no second fixed target**.
- `[CRAIG]` **The PVS trail only trails the BoS if it is protected by that AVWAP.**
  Consistent with the SOP's "pure BoS trail" — the AVWAP is the permission to advance it.
- `[SOP]` **If only the entry order fills and a partial is taken:** cancel the resting L1,
  and move the stop to *just beyond the last swing before the BoS*.
- `[SOP]` **Wait for the next BoS or ChoCh before looking for the next trade.**
- `[CRAIG]` On the test board the 50% partial is banked **at the 1-of-fib** (changed
  2026-08-16 from "when price returns to entry").
- `[CRAIG]` Clearing the anchor moves the stop to break-even.
- `[VERIFIED]` **Break-even means the POSITION breaks even** — the blended average of the
  fills, not the entry price. A two-fill trade stopped at BE returns exactly 0.
- `[CRAIG]` **EVS retired 2026-08-16** — scored identical to plain BE on every matched
  trade (+0.000R paired delta over 31 trades).

## 6. Conditions to avoid

`[SOP]`

1. Do not long/short near the **Daily VWAP** until a decision has been made on which side
   is in control, relative to trend.
2. Do not short a double bottom, or long a double top.
3. **If price keeps fading your VWAP** — approaching then repeatedly pushing away — avoid
   the trade. It means the anchor is probably wrong, or you're exposed to a sweep.

## 7. ⚠ Targets — the SOP and the test board disagree

`[SOP]` live targets are **fixed R off the ladder**, differing by instrument and fill:

| Fill | Futures | Crypto |
|---|---|---|
| Entry only | fib 0.95 = 1R | **fib 1.485 = 2R** |
| L1 filled | fib 0.55 = 1R | **fib 0.82 = 2R** |

`[VERIFIED]` That table is internally consistent with the R law — checked against the
SOP's own MNQ worked example. Entry-only at 0.95 pays `(0.95−0.382)/0.552 = 1.03R`;
L1-filled at 0.55 pays `[(0.55−0.382)+(0.55−0.17)]/0.552 = 0.99R`. Crypto: 1.485 → 2.00R,
0.82 → 1.97R. **The targets were solved to land on 1R/2R** — they aren't round numbers
someone picked.

**But the crypto log scores 1.618 and 2.272, not 1.485 and 0.82.** At 1.618 an entry-only
fill pays ~2.24R and an L1 fill ~4.86R — materially further out than the SOP's 2R.

`[OPEN]` **Which is current?** Either the board is testing longer targets *against* the SOP
baseline, or the SOP is stale. This must be settled before any backtest, because it decides
what "the strategy" even is. Note the SOP's own 2R targets **are not scored on the board at
all** — worth adding as the baseline to beat.

## 8. Reference — the SOP's own backtested stats

`[SOP]` Conservative; useful as a sanity bar for whatever I produce.

| Instrument | Win rate | Expectancy |
|---|---|---|
| Futures | 65% | 0.45R |
| Crypto | 55% | 0.60R |

Crypto is **gross of fees and funding** — on frequent 1m entries, taker fees plus perp
funding eat into it materially. Expectancy runs above what the fixed targets alone would
give at those win rates; the SOP attributes the gap to the 50%-partial + BoS-trail runners.

## 9. Known data defects

- `#9` PVS Price logged 73.92; his chart shows the ray below the 0.618 line at ~73.81.
- `#24` Moved-Stop-to-BE false while its own Max Run sits 37c past the anchor.
- `#23` entry logged 73.70; that minute traded 73.71–73.74 and 73.70 never printed.
- 92 stray cells: entry-only columns populated on L1-filled rows. Never read by the board.

## 10. OPEN QUESTIONS

1. **Targets** — §7. Which is live: the SOP's 2R, or the board's 1.618/2.272?
2. **"Sweep of a consolidation"** — what marks the consolidation, and what counts as an
   *external* structure sweep on crypto specifically?
3. **BoS confirmation** — what separates a confirmed BoS from a fakeout? The SOP grades
   ChoCh templates "decisive, fair value gap present" vs "not decisive, no FVG". Does the
   FVG requirement apply to the BoS as well?
4. **The other four AVWAP types** in the VCL Clarity testing hub — what are they, and is
   the board meant to compare them?
5. **Macro/micro trend** — how is "market structure still intact" determined mechanically?
6. **Rejected setups** — still zero logged. Every row is a trade he took, so there is
   nothing to learn the skip-filter from.

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-08-16 | File created from 32 logged rows, the Notion schema, four screenshots, and this session's verification. | — |
| 2026-08-16 | EVS retired; 50%-off gate moved to the 1-of-fib. | Craig |
| 2026-08-16 | Stop-touch read strict (trade through, not touch). | `tick.js` |
| 2026-08-16 | Break-even confirmed as blended average, not entry price. | `outcomes.js` |
| 2026-08-16 | Fib is *solved*, not drawn: 0 derived from entry and the 1. Retired the belief that fib-0 was a chosen swing low. | Craig + `fibsolve.js` |
| 2026-08-16 | **AVWAP anchor identified: the sweep candle.** Retired my candidate sweep of session/day opens — none fit (best 12/32, `vwapanchor.js`). | SOP |
| 2026-08-16 | Retired "the 5 chart indicators may be decision-relevant" — the SOP states there is no indicator filter at all. | SOP |
| 2026-08-16 | Retired "trend read is daily→1H→15m *only*" as the whole story — the SOP's operative test is macro ≥15m vs micro ≤15m alignment. | SOP |
| 2026-08-16 | **Crypto anchors on an FVG reaction, not a sweep** — sweeps are unreliable on crypto price action. 5m vs 15m FVG is an open A/B. Anchor and execution stay on 1m. | Craig |
| 2026-08-16 | Recorded that the anchor is NOT recoverable by inverting the entry price (median 7 candidates even at 1 tick). Reframed as a validator, not an identifier. | `anchorsolve.js` |
