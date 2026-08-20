// Pull historical 1m bars out of TradingView Desktop via the local CDP bridge.
//
// Why this exists: the free 1m sources cap at ~30 days, and the trades being audited are
// older than that. TradingView holds minute data for years, but only exposes it through
// Bar Replay — ohlcv always returns the bars ENDING at the replay cursor, never a
// requested range.
//
// TWO ORDERING RULES, both found by testing and both silent when violated:
//   1. The timeframe must be set while replay is STOPPED. Changing it mid-replay leaves
//      the session pinned at its old cursor and ohlcv keeps serving the old resolution's
//      data — it looks like it worked and returns the wrong bars.
//   2. ohlcv returns at most ~300 bars (6h at 1m) per cursor position, so a full futures
//      session needs several cursor placements walked backwards.
//
// This is a READ of the user's own licensed session. It changes chart state while running
// (symbol, timeframe, replay) and restores it at the end.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = path.join(process.env.HOME, 'tools/tradingview-mcp/src/cli/index.js');
const CACHE = path.join(__dirname, 'cache');

const tv = (...args) => {
  const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(out); } catch { return { success: false, raw: out.slice(0, 300) }; }
};
const sleep = s => execFileSync('sleep', [String(s)]);

/** Place the replay cursor at an instant, respecting rule 1 above. */
function seek(symbol, timeframe, iso) {
  tv('replay', 'stop');            sleep(2);
  tv('symbol', '--set', symbol);   sleep(3);
  tv('timeframe', '--set', timeframe); sleep(3);
  const st = tv('state');
  if (String(st.resolution) !== String(timeframe)) {
    throw new Error(`timeframe did not take: wanted ${timeframe}, chart says ${st.resolution}`);
  }
  tv('replay', 'start', '--date', iso); sleep(5);
  return tv('replay', 'status');
}

/**
 * Walk the replay cursor backwards across a date, collecting 1m bars.
 * `stops` are ISO instants, latest first; each yields up to ~300 bars ending there.
 */
function pullDay(symbol, dateISO, stops) {
  const seen = new Map();
  const dayStart = Date.parse(dateISO + 'T00:00:00Z') / 1000;
  const dayEnd = dayStart + 86400;
  for (const s of stops) {
    try {
      seek(symbol, '1', s);
      const r = tv('ohlcv', '--count', '500');
      const bars = r.bars || [];
      // GUARD. A seek that lands outside its requested date does NOT error — it silently
      // serves whatever the cursor actually reached (in practice the seconds-data clamp
      // point, ~30 days back). Without this check those bars merge in and the day looks
      // like it has data it does not. Keep only bars inside the requested date.
      const kept = bars.filter(b => b.time >= dayStart && b.time < dayEnd);
      if (bars.length && !kept.length) {
        const got = new Date(bars.at(-1).time * 1000).toISOString().slice(0, 10);
        console.error(`  ! ${dateISO} @ ${s}: seek landed on ${got}, discarding ${bars.length} bars`);
        continue;
      }
      for (const b of kept) seen.set(b.time, b);
    } catch (e) {
      console.error(`  ! ${dateISO} @ ${s}: ${e.message}`);
    }
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

/** Restore the chart to how a session was found. */
function restore(symbol, timeframe) {
  tv('replay', 'stop'); sleep(2);
  tv('symbol', '--set', symbol); sleep(3);
  tv('timeframe', '--set', timeframe); sleep(2);
}

module.exports = { tv, seek, pullDay, restore, CACHE };

if (require.main === module) {
  const [, , dateArg] = process.argv;
  if (!dateArg) { console.error('usage: node tv_pull.js YYYY-MM-DD'); process.exit(1); }
  fs.mkdirSync(CACHE, { recursive: true });
  // Four cursors across a CME session (17:00 ET prior day -> 16:00 ET), in UTC.
  const stops = ['T23:59', 'T18:00', 'T13:00', 'T08:00', 'T03:00'].map(t => dateArg + t);
  const bars = pullDay('CME_MINI:MNQ1!', dateArg, stops);
  const f = path.join(CACHE, `tv_MNQ_1m_${dateArg}.json`);
  fs.writeFileSync(f, JSON.stringify(bars));
  const iso = t => new Date(t * 1000).toISOString();
  console.log(`${dateArg}: ${bars.length} bars  ${bars.length ? iso(bars[0].time) + ' -> ' + iso(bars.at(-1).time) : ''}`);
  restore('CME_MINI:MNQ1!', '15S');
}
