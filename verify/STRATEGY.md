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

### 3a. The AVWAP anchor — SWEEP **INTO** AN FVG

`[CRAIG]` The sweep and the FVG are **not alternatives — they are one condition.** Craig's
earlier framing ("sweeps are hard to identify on crypto, use an FVG instead") is refined by
his markup of 2026-07-20: *"it sweeps and confirms the FVG."* The sweep is still the event;
the FVG is what makes it trustworthy on crypto, where a bare sweep is too noisy to trade.
Neither alone is the setup.

`[CRAIG]` **This requires discretion.** Craig says so directly. Treat any mechanisation as
an approximation of a judgement call, not a replacement for one.

`[VERIFIED]` **WORKED END TO END on 2026-07-20** — the first complete reproduction of one
of his trades from tape alone:

| step | tape |
|---|---|
| prior swing low | 75.54 at 02:53 |
| **sweep** | 03:17–03:18 trades to **75.49**, taking that low out by 5c, and reverses |
| the sweep lands in | the 5m FVG at ~75.50–75.55 — the gap *confirms* the sweep |
| **AVWAP anchored** | the 03:18 candle, the lowest wick of the sweep |
| run | price rallies to 76.04 by 03:30 — this becomes fib 1 |
| **entry** | 03:40, AVWAP reads 75.833, entry one tick above = **75.84** (he marked 75.84) |
| **0 solved** | `(75.84 − 0.382×76.04)/0.618` = **75.716** (he marked 75.72) |
| outcome | 1.618 and 2.272 both paid; price ran to 76.71 |

Every level reproduces to the cent. Test: the chain above is exact, not fitted.

Note the stop lands **23c ABOVE the sweep low** (75.72 vs 75.49). The SOP's "the 0 sits at
or just beyond the AVWAP anchor candle" is loose — the 0 is solved, and on this trade it
came out well inside the anchor candle's wick.

**What replaces it — the full sequence** `[CRAIG]`, stated as a long; mirror for shorts:

1. **Price reacts to an FVG** on the 5m or the 15m.
2. **It must not CLOSE beyond the gap's midpoint.** A wick through is fine — the close is
   what invalidates.
3. **Wait for a BoS or ChoCh** — whichever is present. Validation requires **a full 1m
   candle close** above (long) or below (short) the level. Not a wick, not an intrabar poke.
4. **Anchor the AVWAP to that low** — the reaction low where the FVG was validated.
5. **Anchor the fib's 1 to the high of the BoS/ChoCh.**
6. **Enter at the VWAP on the retrace**, playing the continuation.

`[CRAIG]` **The FVG is found on a higher timeframe — 5m or 15m. The anchor and the
execution are always on the 1m**, either way.

`[CRAIG]` **Volume is an OBSERVATION, not a filter — yet.** The FVG reaction should show
increased volume, but how to measure it, and whether it matters at all, is deliberately
undecided. Record it per setup and report the distribution; **do not gate on it** until the
data says it earns its place. Adding a threshold now would be inventing a parameter.

`[OPEN]` **5m FVG vs 15m FVG — which works better is not yet known.** A defined A/B for the
backtest to settle, not a thing to assume. Treat them as two variants until data decides.

`[OPEN]` Minor tension on where the 1 goes: Craig says "the high of the BoS/ChoCh", the SOP
says "the highest point **after** the BoS". These differ if price keeps running past the
BoS candle before retracing. **Testable** — the logged anchor prices can be compared
against both readings rather than picked between.

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

## 9a. WORKED EXAMPLE — 2026-07-20, and why the detector took the opposite side

`[CRAIG]` Craig marked up the exact window my setup 1 fired in. He went **long**. I went
short. He won; I would have been run over.

His ladder, `[VERIFIED]` as an exact fib — all six of his marked levels reproduce from
0 = 75.72 and 1 = 76.04 to the cent:

| level | price |
|---|---|
| 0 · stop | 75.72 |
| 0.17 · L1 | 75.77 |
| 0.382 · entry | 75.84 |
| 1 · anchor | 76.04 |
| 1.618 | 76.24 |
| 2.272 | 76.45 |

Fib range 0.32, 1R = 0.177. Price ran to 76.71 — **both targets paid.** My short entered
at 76.07 and price reached 77.22 against it.

**The four things his markup exposes:**

1. **THE TREND FILTER IS NOT IMPLEMENTED, AND IT IS THE WHOLE GAME.** SOP criteria 1 and 2
   — macro ≥15m bias, micro aligned — were never built. On his 5m chart the macro is
   clearly UP; the move down into the FVG is the CORRECTION, and the CHoCH ends it. My
   detector has no trend context whatsoever, so it read the correction as a trend and sold
   into a bull continuation. **This is the single highest-priority fix and it explains the
   direction errors, not just this one trade.**
2. **The anchor was the top of his trade.** My "reaction high" at 04:17 is the 76.42 high
   of his winning move. His anchor is the reaction LOW at ~75.72, roughly an hour earlier.
3. **Wrong FVG, wrong side.** He works a BULLISH 5m gap around 75.50–75.55; I used a
   bearish one at 76.37–76.41.
4. **The BoS/ChoCh level is the last swing high of the CORRECTIVE move** — the dashed
   level on his chart at ~75.84 that price closes back above to confirm the change of
   character. That is a real answer to the open question; my "nearest 5-bar pivot within
   90 bars" is not it.

`[OPEN]` One detail not yet settled: the session low was 75.46 at 02:37 and the FVG sits
around 75.50–55, but his anchor is the HIGHER low at ~75.72 around 03:18. So the anchor is
not the bar that touched the gap — it is the low that immediately preceded the ChoCh.
Confirm whether the FVG touch and the anchor low are always allowed to be different swings.

## 9b. Detector status — FAILING, and not to be tuned into working

`detect.js` implements §3a literally. Across a full sweep of the two parameters I had to
invent (minimum FVG size, reaction window) it finds **1–2 of Craig's 32 trades**. It is
wrong, and it is recorded as wrong.

I could reach a high match rate by tuning. That would be fitting the detector to the
answer key and then grading with the answer key, and it would fall apart on 2022 data.
The parameters stay exposed as CLI arguments and unset by default for that reason.

What the failure most likely means — none of these are assumed, they are the questions:

- **The BoS level is mine, not Craig's.** I used "the most recent 5-bar pivot within 90
  bars". Craig specified how a BoS is *confirmed* (a full 1m close beyond) but never what
  level it must close beyond. This is the biggest suspect.
- **"External structure" (SOP, crypto-only) is unimplemented** — my pivot is internal.
- **Minimum FVG size is unspecified.** The median 5m gap on this tape is 4 ticks; at a
  0.08 floor the detector finds nothing at all. Somewhere between is a real number that
  is Craig's to give.

## 10. OPEN QUESTIONS

1. **Targets** — §7. Which is live: the SOP's 2R, or the board's 1.618/2.272?
2. **"Sweep of a consolidation"** — what marks the consolidation, and what counts as an
   *external* structure sweep on crypto specifically?
3. **BoS confirmation** — what separates a confirmed BoS from a fakeout? The SOP grades
   ChoCh templates "decisive, fair value gap present" vs "not decisive, no FVG". Does the
   FVG requirement apply to the BoS as well?
4. **The other four AVWAP types** in the VCL Clarity testing hub — what are they, and is
   the board meant to compare them?
5. **Macro/micro trend.** `[CRAIG]` **Structure = higher highs AND higher lows** (mirrored
   for down). `[CRAIG]` **The 15m matters more than the 1H** — but note his 2026-07-20 long
   has a 15m bias of DOWN, so the 15m is critical as *the structure whose break is the
   signal*, not one that must agree. Not yet resolved into a rule.

   **Reference — Tom Vorwald, "The Ultimate Multi-Timeframe Strategy for Perfect Entries"**
   ([12:20](https://youtu.be/HySZZSjMxF8)), sent by Craig. Same doctrine, and it names two
   things this spec has open:

   - **The disturbance level.** He draws, explicitly, the level *"if we go above this, the
     trend structure is disturbed for now"* — the last lower high in a downtrend. That is
     the ChoCh level, and it is the same answer Craig's markup gave for what a BoS must
     close through. Two independent sources now agree on it.
   - **Volume at the reversal.** *"When a reversal occurs, the volume also increases…
     and when it then trades back down from that increased volume, I've had exhaustion at
     the top. But if it doesn't trade below this volume, I have to wait."* That is a
     concrete, testable form of Craig's "increased volume on the FVG reaction", which is
     currently recorded as observe-don't-gate.
   - **Closing prices.** *"Always keep an eye on the closing prices"* — consistent with the
     full-1m-close rule for confirming a BoS/ChoCh.
   - Sequence: weekly range → daily market phase and rejection → 1H bias → **15m to define
     risk**. Craig's daily → 1H → 15m, with the 15m as the execution/risk frame.

   **The lesson for my `bias()` function.** Vorwald does not compute a binary trend flag.
   He locates *where price sits inside a larger range* and *whether a breakout was
   rejected*. My implementation asks a yes/no question of a market that is usually
   sideways, which is why it returns "none" on ~18 of Craig's 32 trades. A range-position
   read is likely the right shape, not a stricter pivot rule.
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
| 2026-08-16 | Full crypto sequence given: react to FVG, no close beyond midpoint, BoS/ChoCh confirmed by a full 1m close, anchor at the reaction low, fib 1 at the BoS high. Resolved the "highest candle" ambiguity. | Craig |
| 2026-08-16 | Volume demoted from filter to observation — measure and report, do not gate, until it earns a threshold. | Craig |
