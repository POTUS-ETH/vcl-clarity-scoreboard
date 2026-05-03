// scoreboard/refresh.js
// Runs in GitHub Actions. Fetches AVWAP Stats + Trade Log v2 from Notion,
// computes leaderboard stats, writes scoreboard/data.json.

const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN env var');
  process.exit(1);
}

// IDs from your Notion workspace (public-API database IDs, i.e. page IDs as shown in URLs)
const AVWAP_DB = '92b9ba93-1e73-4533-bede-c70f7e7a492e';
// Trade Log v2 — the new master trade log with structured price inputs and convention-A R math.
// (This is the inline-view block id on VCL Clarity, which doubles as the public-API database id.)
const MTL_DB = 'edba84db-7e45-4f54-8b23-d8d7c9059c6e';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const headers = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

const METHODOLOGIES = [
  { code: 'FTP',  label: 'Full TP',           wrProp: 'Full TP WR%',           avgRProp: 'Full TP AvgR',           expProp: 'Full TP Exp',           totalRProp: 'Full TP Total R' },
  { code: 'EP',   label: 'Entry Partials',    wrProp: 'Entry Partials WR%',    avgRProp: 'Entry Partials AvgR',    expProp: 'Entry Partials Exp',    totalRProp: 'Entry Partials Total R' },
  { code: 'EL1',  label: 'Entry + L1',        wrProp: 'Entry + L1 WR%',        avgRProp: 'Entry + L1 AvgR',        expProp: 'Entry + L1 Exp',        totalRProp: 'Entry + L1 Total R' },
  { code: '5T',   label: '5m HA Trail',       wrProp: '5m HA Trail WR%',       avgRProp: '5m HA Trail AvgR',       expProp: '5m HA Trail Exp',       totalRProp: '5m HA Trail Total R' },
  { code: '5P',   label: '5m HA Partials',    wrProp: '5m HA Partials WR%',    avgRProp: '5m HA Partials AvgR',    expProp: '5m HA Partials Exp',    totalRProp: '5m HA Partials Total R' },
  { code: '10T',  label: '10m HA Trail',      wrProp: '10m HA Trail WR%',      avgRProp: '10m HA Trail AvgR',      expProp: '10m HA Trail Exp',      totalRProp: '10m HA Trail Total R' },
  { code: '10P',  label: '10m HA Partials',   wrProp: '10m HA Partials WR%',   avgRProp: '10m HA Partials AvgR',   expProp: '10m HA Partials Exp',   totalRProp: '10m HA Partials Total R' },
  { code: '15T',  label: '15m HA Trail',      wrProp: '15m HA Trail WR%',      avgRProp: '15m HA Trail AvgR',      expProp: '15m HA Trail Exp',      totalRProp: '15m HA Trail Total R' },
  { code: '15P',  label: '15m HA Partials',   wrProp: '15m HA Partials WR%',   avgRProp: '15m HA Partials AvgR',   expProp: '15m HA Partials Exp',   totalRProp: '15m HA Partials Total R' },
];

const MIN_TRADES_FOR_WR = 5; // ignore rows with fewer trades when ranking by win rate

async function queryAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Query failed for ${dbId}: ${r.status} ${text}`);
    }
    const j = await r.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function getProp(page, name) {
  return page.properties?.[name];
}

function getPropValue(page, name) {
  const p = getProp(page, name);
  if (!p) return null;
  switch (p.type) {
    case 'title':       return p.title.map(t => t.plain_text).join('');
    case 'rich_text':   return p.rich_text.map(t => t.plain_text).join('');
    case 'number':      return p.number;
    case 'select':      return p.select?.name || null;
    case 'rollup':      return rollupValue(p.rollup);
    case 'formula':     return formulaValue(p.formula);
    case 'relation':    return p.relation.map(r => r.id);
    case 'checkbox':    return p.checkbox;
    case 'date':        return p.date?.start || null;
    default:            return null;
  }
}

function rollupValue(rollup) {
  if (!rollup) return null;
  switch (rollup.type) {
    case 'number': return rollup.number;
    case 'date':   return rollup.date?.start || null;
    case 'array':  return rollup.array;
    default:       return null;
  }
}

function formulaValue(f) {
  if (!f) return null;
  switch (f.type) {
    case 'number':  return f.number;
    case 'string':  return f.string;
    case 'boolean': return f.boolean;
    case 'date':    return f.date?.start || null;
    default:        return null;
  }
}

// Convert a value that may be either a numeric percentage rate (0-1) or a
// formatted string like "88.89%" into a 0-1 rate for ranking comparisons.
function toRate(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const m = val.match(/(-?\d+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    // Strings with "%" come pre-multiplied by 100; convert back to rate.
    return val.includes('%') ? n / 100 : n;
  }
  return 0;
}

async function getPageTitle(pageId) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, { headers });
  if (!r.ok) return null;
  const j = await r.json();
  return getPropValue(j, 'AVWAP') || getPropValue(j, 'Title') || pageId;
}

async function patchTradesRelation(pageId, tradeIds) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      properties: { Trades: { relation: tradeIds.map(id => ({ id })) } },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`PATCH failed for ${pageId}: ${r.status} ${text}`);
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function scrubAvwapStats(avwapRows, allAliveTradeIds, byAvwap, byAvwapTrader) {
  console.log('Scrubbing AVWAP Stats relations...');
  const idLookup = {};
  for (const r of avwapRows) idLookup[r.id] = r;

  const updates = [];
  for (const row of avwapRows) {
    const title = getPropValue(row, 'AVWAP');
    const trader = getPropValue(row, 'Trader');
    const parentItem = getPropValue(row, 'Parent item');
    const isSubRow = parentItem && parentItem.length > 0;

    let correctIds;
    if (!isSubRow) {
      // Parent or ALL aggregate row
      if (title && /ALL/i.test(title)) {
        correctIds = allAliveTradeIds.slice();
      } else {
        correctIds = (byAvwap[title] || []).slice();
      }
    } else {
      // Sub-row: filter by parent's AVWAP × this row's Trader
      const parentRow = idLookup[parentItem[0]];
      const parentTitle = parentRow ? getPropValue(parentRow, 'AVWAP') : null;
      correctIds = (byAvwapTrader[`${parentTitle}|${trader}`] || []).slice();
    }

    const currentRel = getPropValue(row, 'Trades') || [];
    if (!setsEqual(new Set(currentRel), new Set(correctIds))) {
      updates.push({ pageId: row.id, ids: correctIds, label: title || `${trader} sub-row` });
    }
  }

  console.log(`${updates.length} of ${avwapRows.length} rows need scrubbing`);

  // Notion API rate-limits to ~3 requests/sec; batch with small concurrency + brief pauses
  const BATCH = 3;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await Promise.all(batch.map(async u => {
      try {
        await patchTradesRelation(u.pageId, u.ids);
        console.log(`  scrubbed ${u.label} → ${u.ids.length} trades`);
      } catch (e) {
        console.error(`  failed to scrub ${u.label}: ${e.message}`);
      }
    }));
    if (i + BATCH < updates.length) await new Promise(r => setTimeout(r, 400));
  }

  if (updates.length > 0) {
    console.log('Waiting 8s for Notion to recompute formulas/rollups...');
    await new Promise(r => setTimeout(r, 8000));
  }
  console.log('Scrub complete.');
  return updates.length;  // caller can decide if a re-fetch is needed
}

(async () => {
  console.log('Fetching Trade Log v2...');
  const trades = await queryAll(MTL_DB);
  console.log(`Got ${trades.length} trades`);

  // Build (avwap, trader) groupings from the source-of-truth (alive MTL rows)
  const byAvwap = {};
  const byAvwapTrader = {};
  const allAliveTradeIds = [];
  for (const t of trades) {
    const avwap = getPropValue(t, 'AVWAP TYPE');
    const trader = getPropValue(t, 'Trader');
    allAliveTradeIds.push(t.id);
    if (avwap) {
      (byAvwap[avwap] = byAvwap[avwap] || []).push(t.id);
      if (trader) {
        const k = `${avwap}|${trader}`;
        (byAvwapTrader[k] = byAvwapTrader[k] || []).push(t.id);
      }
    }
  }

  console.log('Fetching AVWAP Stats DB (pre-scrub)...');
  let avwapRows = await queryAll(AVWAP_DB);
  console.log(`Got ${avwapRows.length} AVWAP Stats rows`);

  // Scrub stale Trades relations against the source-of-truth
  const scrubbedCount = await scrubAvwapStats(avwapRows, allAliveTradeIds, byAvwap, byAvwapTrader);

  // Only re-fetch if the scrub actually changed something — otherwise we already have
  // valid formula/rollup values from the first query, and avoiding a second query
  // sidesteps Notion's flaky permission cache.
  if (scrubbedCount > 0) {
    console.log('Re-fetching AVWAP Stats DB (post-scrub)...');
    try {
      avwapRows = await queryAll(AVWAP_DB);
    } catch (e) {
      console.error(`post-scrub re-fetch failed (${e.message}); using pre-scrub data`);
    }
  } else {
    console.log('No scrub changes — using pre-scrub data for leaders');
  }

  // Identify sub-rows (have a Parent item) and parents (don't)
  const subRows = [];
  const parentRows = {};
  for (const row of avwapRows) {
    const parentItem = getPropValue(row, 'Parent item');
    const trader = getPropValue(row, 'Trader');
    if (parentItem && parentItem.length > 0 && trader) {
      subRows.push({ row, parentId: parentItem[0], trader });
    } else if (!parentItem || parentItem.length === 0) {
      const title = getPropValue(row, 'AVWAP');
      parentRows[row.id] = { row, title };
    }
  }
  console.log(`Sub-rows: ${subRows.length}, Parent rows: ${Object.keys(parentRows).length}`);

  // Build leaderboard structures
  // Each sub-row × each methodology = one (Trader × AVWAP × Methodology) combo
  const combos = [];
  for (const sub of subRows) {
    const trader = sub.trader;
    const avwapTitle = parentRows[sub.parentId]?.title || '?';
    const totalTrades = getPropValue(sub.row, 'Total') || 0;
    for (const m of METHODOLOGIES) {
      combos.push({
        trader,
        avwap: avwapTitle,
        methodology: m.label,
        methodologyCode: m.code,
        totalTrades,
        winRate: toRate(getPropValue(sub.row, m.wrProp)),
        avgR: getPropValue(sub.row, m.avgRProp) || 0,
        expectancy: getPropValue(sub.row, m.expProp) || 0,
        totalR: getPropValue(sub.row, m.totalRProp) || 0,
      });
    }
  }

  // Compute leaders
  const safeMax = (arr, by) => {
    if (!arr.length) return null;
    let best = arr[0];
    for (const x of arr) if ((by(x) ?? -Infinity) > (by(best) ?? -Infinity)) best = x;
    return best;
  };

  const safeMin = (arr, by) => {
    if (!arr.length) return null;
    let worst = arr[0];
    for (const x of arr) if ((by(x) ?? Infinity) < (by(worst) ?? Infinity)) worst = x;
    return worst;
  };

  const topCumulativeR = safeMax(combos, c => c.totalR);
  const winRateCombos = combos.filter(c => c.totalTrades >= MIN_TRADES_FOR_WR);
  const topWinRate = safeMax(winRateCombos, c => c.winRate);
  const bottomWinRate = safeMin(winRateCombos, c => c.winRate);
  const topExpectancy = safeMax(combos, c => c.expectancy);
  const bottomExpectancy = safeMin(combos.filter(c => c.totalTrades > 0), c => c.expectancy);

  // Most trades by trader×AVWAP (not per methodology — methodology doesn't change Total)
  const traderAvwapTotals = {};
  for (const sub of subRows) {
    const key = `${sub.trader} on ${parentRows[sub.parentId]?.title || '?'}`;
    traderAvwapTotals[key] = getPropValue(sub.row, 'Total') || 0;
  }
  let mostTradesKey = null, mostTradesValue = -Infinity;
  for (const [k, v] of Object.entries(traderAvwapTotals)) {
    if (v > mostTradesValue) { mostTradesKey = k; mostTradesValue = v; }
  }

  // Biggest single trade — find the max-magnitude R across all 9 methodology
  // outcomes on each trade, then pick the trade with the highest such value.
  // v2's R formulas return real Convention-A R; we just scan the 9 of them.
  const TRADE_R_PROPS = [
    'Full TP R',
    'Entry Partials R',
    'Entry + L1 R',
    '5m HA Trail R',
    '5m HA Partials R',
    '10m HA Trail R',
    '10m HA Partials R',
    '15m HA Trail R',
    '15m HA Partials R',
  ];
  // Biggest single win (most positive R) and biggest single loss (most negative R)
  // — scan all 9 methodology R columns on every trade, track positive & negative extrema.
  let biggestWin = null, biggestWinR = -Infinity;
  let biggestLoss = null, biggestLossR = Infinity;
  for (const t of trades) {
    const tradeTrader = getPropValue(t, 'Trader');
    const tradeAvwap = getPropValue(t, 'AVWAP TYPE');
    let bestPos = null, bestPosMethod = null;
    let bestNeg = null, bestNegMethod = null;
    for (const p of TRADE_R_PROPS) {
      const v = getPropValue(t, p);
      if (v === null || v === undefined) continue;
      const num = typeof v === 'number' ? v : parseFloat(v);
      if (isNaN(num)) continue;
      if (num > 0 && (bestPos === null || num > bestPos)) {
        bestPos = num;
        bestPosMethod = p.replace(/ R$/, '');
      }
      if (num < 0 && (bestNeg === null || num < bestNeg)) {
        bestNeg = num;
        bestNegMethod = p.replace(/ R$/, '');
      }
    }
    if (bestPos !== null && bestPos > biggestWinR) {
      biggestWinR = bestPos;
      biggestWin = { r: bestPos, method: bestPosMethod, trader: tradeTrader, avwap: tradeAvwap, date: getPropValue(t, 'Date') };
    }
    if (bestNeg !== null && bestNeg < biggestLossR) {
      biggestLossR = bestNeg;
      biggestLoss = { r: bestNeg, method: bestNegMethod, trader: tradeTrader, avwap: tradeAvwap, date: getPropValue(t, 'Date') };
    }
  }

  // Best AVWAP — for each AVWAP, find the methodology that yields the highest aggregate
  // Total R across all traders for that AVWAP, then pick the AVWAP whose best score is highest.
  // (Avoids the double-counting of summing total R across all 9 methodologies for one AVWAP.)
  const avwapMethodMatrix = {}; // avwap -> methodology -> sum of totalR across traders
  for (const c of combos) {
    if (!avwapMethodMatrix[c.avwap]) avwapMethodMatrix[c.avwap] = {};
    avwapMethodMatrix[c.avwap][c.methodology] = (avwapMethodMatrix[c.avwap][c.methodology] || 0) + (c.totalR || 0);
  }
  const avwapBestScores = Object.entries(avwapMethodMatrix).map(([avwap, methods]) => {
    const [bestMethodology, bestR] = Object.entries(methods).sort((a, b) => b[1] - a[1])[0] || ['(none)', 0];
    return { avwap, bestMethodology, bestR };
  });
  const bestAvwap = avwapBestScores.sort((a, b) => b.bestR - a.bestR)[0] || { avwap: '(no data)', bestMethodology: '', bestR: 0 };

  // Best Methodology — for each methodology, sum total R across all (trader × AVWAP) combos
  // using that methodology. Each trade is counted once per methodology (no double counting).
  const methodTotals = {};
  for (const c of combos) {
    methodTotals[c.methodology] = (methodTotals[c.methodology] || 0) + (c.totalR || 0);
  }
  const bestMethodology = Object.entries(methodTotals).sort((a, b) => b[1] - a[1])[0] || ['(no data)', 0];

  // Per-AVWAP trade counts (used for sample-size badges on combos)
  const avwapTradeCount = {};
  for (const a of Object.keys(byAvwap)) avwapTradeCount[a] = byAvwap[a].length;

  // All (AVWAP × Methodology) combos sorted by total R
  const avwapMethodTotals = {}; // "avwap||methodology" -> sum
  for (const c of combos) {
    const k = `${c.avwap}||${c.methodology}`;
    avwapMethodTotals[k] = (avwapMethodTotals[k] || 0) + (c.totalR || 0);
  }
  const allCombosSorted = Object.entries(avwapMethodTotals)
    .map(([k, value]) => {
      const [avwap, methodology] = k.split('||');
      return { avwap, methodology, value, sampleSize: avwapTradeCount[avwap] || 0 };
    })
    .sort((a, b) => b.value - a.value);
  const top1 = allCombosSorted[0] || null;            // champion (#1 by total R)
  const worstCombo = allCombosSorted.length ? allCombosSorted[allCombosSorted.length - 1] : null;

  // Champion enrichment: weighted win-rate + best single trade for that AVWAP × Methodology
  let championWinRate = null;
  let championBestTrade = null;
  if (top1) {
    // Weighted win rate across all trader sub-rows for the champion combo
    let wins = 0, totalTradesInCombo = 0;
    for (const c of combos) {
      if (c.avwap === top1.avwap && c.methodology === top1.methodology) {
        wins += (c.winRate || 0) * (c.totalTrades || 0);
        totalTradesInCombo += c.totalTrades || 0;
      }
    }
    championWinRate = totalTradesInCombo > 0 ? (wins / totalTradesInCombo) : null;

    // Best single trade R for this combo's specific methodology column
    const methodCode = METHODOLOGIES.find(m => m.label === top1.methodology)?.code;
    const methodColumnMap = {
      FTP: 'Full TP R', EP: 'Entry Partials R', EL1: 'Entry + L1 R',
      '5T': '5m HA Trail R', '5P': '5m HA Partials R',
      '10T': '10m HA Trail R', '10P': '10m HA Partials R',
      '15T': '15m HA Trail R', '15P': '15m HA Partials R',
    };
    const methodColumn = methodColumnMap[methodCode];
    if (methodColumn) {
      let best = null;
      for (const t of trades) {
        if (getPropValue(t, 'AVWAP TYPE') !== top1.avwap) continue;
        const v = getPropValue(t, methodColumn);
        const num = typeof v === 'number' ? v : parseFloat(v);
        if (!isNaN(num) && (best === null || num > best)) best = num;
      }
      championBestTrade = best;
    }
  }

  // Top 3 single trades (one row per trade — each trade's best methodology R)
  const tradeBestPositives = [];
  for (const t of trades) {
    const tradeTrader = getPropValue(t, 'Trader');
    const tradeAvwap = getPropValue(t, 'AVWAP TYPE');
    let bestPos = null, bestPosMethod = null;
    for (const p of TRADE_R_PROPS) {
      const v = getPropValue(t, p);
      if (v === null || v === undefined) continue;
      const num = typeof v === 'number' ? v : parseFloat(v);
      if (isNaN(num)) continue;
      if (num > 0 && (bestPos === null || num > bestPos)) {
        bestPos = num;
        bestPosMethod = p.replace(/ R$/, '');
      }
    }
    if (bestPos !== null) {
      tradeBestPositives.push({ r: bestPos, method: bestPosMethod, trader: tradeTrader, avwap: tradeAvwap, date: getPropValue(t, 'Date') });
    }
  }
  const topTrades = tradeBestPositives.sort((a, b) => b.r - a.r).slice(0, 3);

  // Best win rate combo (already filtered to MIN_TRADES_FOR_WR upstream)
  const bestWinRate = topWinRate;

  // Most active trader×AVWAP — same as before
  const mostActive = mostTradesKey ? {
    label: mostTradesKey,
    sublabel: '',
    value: `${mostTradesValue}`,
  } : null;

  const data = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    leaders: {
      // Champion hero — full multi-stat block
      champion: top1 ? {
        avwap: top1.avwap,
        methodology: top1.methodology,
        label: `${top1.avwap} × ${top1.methodology}`,
        totalR: `${top1.value >= 0 ? '+' : ''}${top1.value.toFixed(2)}R`,
        winRate: championWinRate !== null ? `${(championWinRate * 100).toFixed(1)}%` : '—',
        bestTrade: championBestTrade !== null ? `${championBestTrade >= 0 ? '+' : ''}${championBestTrade.toFixed(2)}R` : '—',
        sampleSize: top1.sampleSize,
      } : null,

      // Top 3 single biggest trades (any combo)
      topTrades: topTrades.map(t => ({
        value: `+${t.r.toFixed(2)}R`,
        trader: t.trader || '?',
        avwap: t.avwap || '?',
        methodology: t.method || '',
        date: t.date || '',
      })),

      // Best win rate combo (different leader than champion most of the time)
      bestWinRate: bestWinRate ? {
        avwap: bestWinRate.avwap,
        methodology: bestWinRate.methodology,
        label: `${bestWinRate.avwap} × ${bestWinRate.methodology}`,
        sublabel: `${bestWinRate.trader} · n=${bestWinRate.totalTrades}`,
        value: `${(bestWinRate.winRate * 100).toFixed(1)}%`,
      } : null,

      // Most active trader × AVWAP
      mostActive,

      // Small accountability panel — single weakest combo
      worstCombo: worstCombo ? {
        avwap: worstCombo.avwap,
        methodology: worstCombo.methodology,
        label: `${worstCombo.avwap} × ${worstCombo.methodology}`,
        sublabel: `n=${worstCombo.sampleSize}`,
        value: `${worstCombo.value >= 0 ? '+' : ''}${worstCombo.value.toFixed(2)}R`,
      } : null,
    },
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
