# VCL Clarity Tracker — Deep Audit Findings

**Date:** 2026-05-04
**Scope:** Trade Log v2 R formulas + helpers, AVWAP Stats rollups + formulas, scoreboard refresh.js, GitHub Actions workflow, README.

## ✅ Fixes applied this round

After user clarified the EP/EL1 spec ("EP = entry-only partials, 50/50 on entry, L1 100% back at entry; EL1 = partials on both, entry 50/50, L1 75/25 with stop at L1; loss = both filled"):

1. **EL1 R formula rewritten** — L1 portion's 25% runner now exits at `Full TP Exit Price` (was `Entry + L1 Exit Price`, which is the partial-take price). Stale `(IF FILLED) L1 Price` name refs updated to canonical `L1 Price`. `result_type: number` made explicit.
2. **5m / 10m / 15m HA Partials R rewritten** — user chose EL1-style spec for HA Partials L1 portion. All 3 formulas now mirror EL1 with the HA exit column substituted for the EL1 partial-take column. Each formula went from ~2553 chars (with mis-decomposed `0.75/0.25` blanket multipliers) to ~563 chars (clean per-portion math).
3. **TEST_const, TEST_eFTP renamed** to `🗑️ DELETE_ME (TEST_const)` / `🗑️ DELETE_ME (TEST_eFTP)` — Notion's API blocks programmatic property deletion as a safeguard. Right-click → delete in the schema view to finalize.

## Corrected formula spec (for reference)

**EP** (Entry Partials — only Entry portion partials):
- Entry portion (always 0.5 of full): 50% partial @ EPexit, 50% runner @ FTPexit
- L1 portion (only at Outcome=L1, 0.5 of full): 100% back at Entry
- Stop: -1R (full position because both filled)

**EL1 / 5m HA P / 10m HA P / 15m HA P** (both portions partials):
- Entry portion (always 0.5): 50% partial @ partial-exit-col, 50% runner @ FTPexit
- L1 portion (only at Outcome=L1, 0.5): 75% back at Entry, 25% runner @ FTPexit (stop at L1)
- Stop: -1R

**Status:** EP / EL1 / HA Partials confirmed correct. Items 3-13 below remain pending review.

---

## Severity legend
- 🔴 **Math/correctness issue** — likely produces wrong numbers
- 🟡 **Semantic/convention question** — works, but may not match your intent
- 🟢 **Hygiene** — works, but is dead code, stale docs, or fragile

---

## 🔴 1. EL1 R formula has inconsistent splits between Outcome=Entry and Outcome=L1

**Formula (rendered):**
```
if(Outcome == "Stop", -1,
  if(empty(EL1exit), 0,
    if(empty(FTPexit), 0,
      round(dirM × if(Outcome == "L1",
        ( 0.25 × (FTPexit − Entry)
        + 0.375 × (Entry − L1)
        + 0.25 × (EL1exit − Entry)
        + 0.125 × (EL1exit − L1) ),
        ( 0.25 × (FTPexit − Entry)
        + 0.25 × (EL1exit − Entry) )
      ) / iniR, 2))))
```

**Decoding the L1 branch:**
- Entry portion (0.5 of position): 0.25 runner @ FTP + 0.25 partial @ EL1exit → **50/50 split**
- L1 portion (0.5 of position): 0.375 partial @ Entry + 0.125 runner @ EL1exit → **75/25 split**

**Decoding the Entry branch:**
- Entry portion (0.5 of position): 0.25 runner @ FTP + 0.25 partial @ EL1exit → **50/50 split**

**The question:** Is the Entry portion supposed to be **50/50** (matches Entry Partials) or **75/25** (would match the L1 portion in this same formula)?

Right now Entry-portion behavior changes depending on whether L1 fills, which is internally inconsistent. **Either:**
- (A) Entry portion is always 50/50 — then the L1 branch should use 0.25(Entry−L1) + 0.25(EL1exit−L1) for the L1 portion (also 50/50).
- (B) Entry portion is always 75/25 — then the Entry-only branch should use 0.125(FTPexit−Entry) + 0.375(EL1exit−Entry).

**Need from you:** confirm the intended split for EL1's Entry portion and L1 portion.

---

## 🔴 2. HA Partials R formula loses cost-basis decomposition at Outcome=L1

**Formula (rendered, identical for 5m / 10m / 15m):**
```
if(Outcome == "Stop", -1,
  if(empty(HAexit), 0,
    if(empty(FTPexit), 0,
      round(dirM × (
        if(Outcome=="L1", 0.75, 0.25) × (FTPexit − avgE)
        + 0.25 × (HAexit − if(Outcome=="L1", L1, Entry))
      ) / iniR, 2))))
```

**At Outcome=Entry** the formula expands cleanly to:
- 0.25 × (FTP − Entry) [entry portion runner, 25% of total]
- 0.25 × (HA − Entry) [entry portion trail, 25% of total]
→ Half-size split, 50/50 between TP runner and HA trail. ✓

**At Outcome=L1** the formula expands to:
- 0.75 × (FTP − avgE) where avgE = (Entry + L1) / 2
- 0.25 × (HA − L1)

If the methodology at L1 is "Entry portion 50/50 + L1 portion 50/50" (consistent with Outcome=Entry behavior), the correct decomposition is:
- 0.25 × (FTP − Entry) [entry runner]
- 0.25 × (HA − Entry) [entry trail]
- 0.25 × (FTP − L1) [L1 runner]
- 0.25 × (HA − L1) [L1 trail]

Algebraically this is **NOT** equal to `0.75(FTP − avgE) + 0.25(HA − L1)`:

| Term coefficient | Correct (50/50 each) | Formula |
|---|---|---|
| FTP | 0.5 | 0.75 |
| HA | 0.5 | 0.25 |
| Entry | −0.5 | −0.375 |
| L1 | −0.5 | −0.625 |

The formula **over-weights the FTP runner and under-weights the HA trail by 25 percentage points each** when L1 fills, AND mis-distributes the Entry/L1 cost basis.

**Need from you:** confirm the intended methodology spec at L1 outcome (is it 50/50 on each portion? or some other split?), then we fix all 3 timeframes.

---

## 🟡 3. iniR is outcome-aware, not Convention-A

**Formula:**
```
abs( if(empty(L1), Entry, (Entry + L1) / 2) − SL )
```

The risk denominator only uses planned-avg when L1 actually filled. When Outcome=Entry/Stop, iniR collapses to entry-only risk.

Combined with `posM = if(L1, 1, 0.5)` and `avgE = if(L1, avg(Entry,L1), Entry)`, the entire R math is **outcome-aware**: R measures actual realized PnL ÷ actual risk taken.

You previously chose **Convention A: planned-full-scale risk denominator** (so half-fill wins look smaller). The current formulas are **Reading B (outcome-aware).**

**Two options:**
- (A) Keep current formulas, rename the convention internally to "Reading B" so we don't have a name/code mismatch.
- (B) Switch to Convention A: `iniR = abs( (Entry+L1)/2 − SL )` always (regardless of L1 fill), `posM = 1` always, `avgE = avg(Entry,L1)` always. Half-fill wins/losses then properly look smaller relative to a planned-full position.

**Need from you:** which is the intended math?

---

## 🟡 4. Stop = -1R is hardcoded — clashes with outcome-aware framing

In every R formula: `if(Outcome == "Stop", -1, ...)`.

- Under **outcome-aware** framing (current iniR/posM behavior), a Stop after Entry-only fill should be `-0.5R` (half size at full -1R), not -1R.
- Under **planned-full-scale** framing, -1R is correct regardless of fill.

So the Stop branch is "Convention A" while the win branches are "Reading B." Internal mismatch.

**Tied to #3 — pick one convention and apply consistently.**

---

## 🟡 5. AVWAP Stats formulas all have `result_type: { type: "unknown" }`

All 36 formulas on AVWAP Stats (WR%, AvgR, Exp, Total R × 9 methodologies) ship with `result_type: unknown`. We hit this exact bug on v2 helpers earlier (Task #61) — formulas with `unknown` result type can break downstream chaining and cause empty values.

The current formulas appear to render fine in Notion's UI, but this is fragile. Touching any of them in the formula editor and re-saving would trigger Notion's auto-typer; until then the result_type stays unknown.

**Recommended:** programmatically rewrite all 36 AVWAP Stats formulas with explicit `result_type: { type: "number" }` (where appropriate) or `{ type: "string" }` (for the WR% formulas that emit "X.XX%").

---

## 🟡 6. All R formulas return 0 when FTPexit is blank

Every methodology formula gates: `if(empty([Full TP Exit Price]), 0, ...)`.

This means a trade where Outcome=Entry and we never filled FTPexit (because the trade exited via partial-only and the runner was closed at the partial price too) would record **0R for every methodology**. The trade exists in Total but contributes nothing to wc/ws — silently dragging WR down (since denominator is Total, not wc+lc).

**Question:** What is the data-entry convention when Outcome=Entry?
- (A) Always populate FTPexit with the actual final exit price for the runner portion — even if it's the same as the partial price. (Current formulas assume this.)
- (B) Leave FTPexit blank if FTP wasn't actually hit, and have the formulas use a fallback price.

If the expected convention is (A), no fix needed — just document. If (B), every R formula needs a fallback path.

---

## 🟡 7. WR uses `wc / Total` — vulnerable to dilution

**WR formula on AVWAP Stats (representative, Full TP):**
```
format(round(if(Total == 0, 0, FTPwc / Total) * 100, 2)) + "%"
```

Total = count of ALL trades on that AVWAP × Trader (including ones where R=0 because FTPexit was blank).

**Fix option (cleaner):** add 9 new helper formulas `XXlf = if(R<0, 1, 0)` to v2, 9 new rollups `XXlc = sum(XXlf)` on AVWAP Stats, and rewrite WR as `wc / (wc + lc)`. This excludes 0R trades from the denominator and gives true win-rate-among-decided-trades.

**Cost:** 18 new properties (9 formulas + 9 rollups), 9 WR formulas to rewrite.
**Benefit:** WR is no longer dragged down by trades that haven't fully completed for that methodology.

---

## 🟢 8. ~60 lines of dead code in refresh.js

These leader computations are computed every run but **never written to data.json**:

| Variable | Lines | Status |
|---|---|---|
| `topCumulativeR` | 302 | dead |
| `bottomWinRate` | 305 | dead (old "shame podium") |
| `topExpectancy` | 306 | dead |
| `bottomExpectancy` | 307 | dead |
| `biggestWin` / `biggestLoss` | 336–365 | dead (replaced by topTrades) |
| `bestAvwap` | 379 | dead (was "Best AVWAP" headline) |
| `bestMethodology` | 387 | dead |
| `avwapMethodMatrix` | 370–378 | dead — only feeds bestAvwap |
| `combos[].avgR` | 281 | fetched, never used |
| `combos[].expectancy` | 282 | fetched, never used |

**Recommended:** delete. Reduces refresh.js by ~30%.

---

## 🟢 9. Methodology mapping duplicated in refresh.js

`METHODOLOGIES` array (lines 29–39) lists labels and stat property names. `methodColumnMap` (lines 424–428) lists labels → R column names. Two sources of truth for the same data → drift risk.

**Recommended:** add `rProp` to each `METHODOLOGIES` entry, drop `methodColumnMap`.

---

## 🟢 10. `worstCombo` has no min-sample filter

Selected as `combos.sort((a,b) => b.value − a.value).pop()`. If a methodology has zero trades on some AVWAP (combo.value = 0), it can be flagged as worst combo even though there's no data — only true negatives are "actually weak."

**Recommended:** add `if (sampleSize >= MIN_TRADES_FOR_WORST) ...` filter, e.g. ≥3 trades.

---

## 🟢 11. Test formulas left in v2

Two leftover dev formulas:
- `TEST_const` = `99`
- `TEST_eFTP` = `[Full TP Exit Price]`

Safe to delete.

---

## 🟢 12. README cron is stale

`scoreboard/README.md` says "auto-refresh every 30 minutes" and shows `cron: '*/30 * * * *'`. Actual workflow uses `*/5 * * * *` with a 5-iteration in-run loop, plus the cron-job.org external pinger that calls workflow_dispatch every 60s. README is stale.

**Recommended:** update README to reflect the actual ~1-min cadence and the cron-job.org pinger.

---

## 🟢 13. AvgR / Exp columns computed but unused

You hid these earlier. The formulas still run on every recompute. Worth dropping if you don't plan to surface them anywhere.

**Recommended:** delete the 18 unused formulas (9 AvgR + 9 Exp on AVWAP Stats).

---

# Summary

| # | Severity | Item | Decision needed |
|---|---|---|---|
| 1 | 🔴 | EL1 split inconsistency | Pick: Entry portion 50/50 or 75/25? |
| 2 | 🔴 | HA Partials L1-outcome math | Confirm 50/50 each portion → rewrite 3 formulas |
| 3 | 🟡 | iniR convention | Convention A or Reading B? |
| 4 | 🟡 | Stop = -1 hardcode | Tied to #3 |
| 5 | 🟡 | AVWAP Stats `unknown` result_type | OK to programmatically retype 36 formulas? |
| 6 | 🟡 | FTPexit-blank → 0R semantics | Confirm data-entry convention |
| 7 | 🟡 | WR uses wc/Total | Add `lf` helpers + `lc` rollups for cleaner WR? |
| 8 | 🟢 | refresh.js dead code | OK to delete? |
| 9 | 🟢 | METHODOLOGIES duplication | OK to consolidate? |
| 10 | 🟢 | worstCombo no min-sample | Pick threshold (3?) |
| 11 | 🟢 | TEST_const, TEST_eFTP | OK to delete? |
| 12 | 🟢 | README stale | OK to update? |
| 13 | 🟢 | AvgR / Exp unused | OK to delete? |

**Pending tasks not in this audit:**
- Phase 8: soft-delete old MTL collection (`6b17e541-46b5-8213-a29c-87e41fc02243`) — Task #59 still pending.
