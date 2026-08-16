// Multi-venue 1m bars, for a consolidated AVWAP.
//
// Craig's own analysis names the mechanism by which the model fails on perps: "one venue's
// partial, liquidation-distorted volume sample. The AVWAP is an average of noise — price
// slices through it because it never represented anyone's real position."
//
// That is a testable claim, not just a reason to quit. If the AVWAP fails on Bybit because
// Bybit is a slice, then weighting the same bars by volume ACROSS venues reconstructs
// something closer to the consolidated basis the model assumes, and it should work better.
// If it does not, the verdict stands on measurement rather than reasoning — which is worth
// having either way.
const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, 'cache');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function binance(sym, startMs, endMs) {
  const out = new Map();
  let cur = startMs;
  while (cur < endMs) {
    const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${cur}&endTime=${endMs}&limit=1500`;
    const r = await (await fetch(u)).json();
    if (!Array.isArray(r) || !r.length) break;
    for (const b of r) out.set(+b[0], { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] });
    const last = +r[r.length - 1][0];
    if (last <= cur) break;
    cur = last + 60_000;
    await sleep(120);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

async function load(venue, sym, startISO, endISO) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${venue}_${sym}_1m_${startISO}_${endISO}.json`.replace(/[:]/g, ''));
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const bars = await binance(sym, Date.parse(startISO), Date.parse(endISO));
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars;
}

/**
 * Consolidated AVWAP: sum price*volume and volume ACROSS venues before dividing, so a
 * venue contributes in proportion to the size actually traded there. Averaging each
 * venue's own VWAP instead would give a thin book equal say with a deep one.
 */
function compositeAVWAP(seriesList, fromT, toT) {
  let pv = 0, vv = 0;
  for (const bars of seriesList)
    for (const b of bars) {
      if (b.t < fromT || b.t > toT) continue;
      pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
    }
  return vv > 0 ? pv / vv : null;
}

module.exports = { load, compositeAVWAP };
