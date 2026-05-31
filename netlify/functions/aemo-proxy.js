/**
 * aemo-proxy.js — Netlify function
 *
 * Returns NEM spot prices for a region combining:
 *   • OpenNEM  — last ~12 actual settled prices (historical)
 *   • AEMO P5  — next ~12 pre-dispatch forecast prices (NEMWeb ZIP)
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 *
 * Returns JSON array sorted by time:
 *   [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 *   source: "actual" | "forecast"
 *
 * No API key required.
 */

'use strict';

const zlib = require('node:zlib');

/* ── helpers ─────────────────────────────────────────────────────────── */
function pad(n) { return String(n).padStart(2, '0'); }

function aestDatetimeStr(utcMs) {
  const d = new Date(utcMs + 10 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

function makeRow(region, datetimeStr, rrp, source) {
  const v = parseFloat(rrp);
  if (isNaN(v)) return null;
  return {
    regionId:         region,
    intervalDatetime: datetimeStr,
    rrp:              parseFloat(v.toFixed(2)),
    rrpCkwh:          parseFloat((v / 10).toFixed(3)),
    source
  };
}

async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid);
    return r;
  } catch (e) { clearTimeout(tid); throw e; }
}

/* ── ZIP extraction (native zlib, no npm) ─────────────────────────────── */
function extractFirstFileFromZip(buf) {
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const off  = buf.indexOf(SIG);
  if (off === -1) throw new Error('Not a ZIP');
  const method      = buf.readUInt16LE(off + 8);
  const fnLen       = buf.readUInt16LE(off + 26);
  const exLen       = buf.readUInt16LE(off + 28);
  const dataStart   = off + 30 + fnLen + exLen;
  let   compSize    = buf.readUInt32LE(off + 18);
  if (compSize === 0) {
    const next = buf.indexOf(SIG, dataStart);
    compSize   = (next === -1 ? buf.length : next) - dataStart;
  }
  const compressed = buf.slice(dataStart, dataStart + compSize);
  if (method === 0) return compressed.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(compressed).toString('utf8');
  throw new Error('Unsupported ZIP compression: ' + method);
}

/* ── AEMO MMS CSV parser ──────────────────────────────────────────────── */
// Format: I,CATEGORY,TABLE,VERSION,col1,col2,...   (header)
//         D,CATEGORY,TABLE,val1,val2,...            (data)
function parseAEMOCsv(csv, category, table) {
  const lines   = csv.split('\n');
  let   headers = null;
  const rows    = [];
  for (const line of lines) {
    const p = line.trim().split(',');
    if (p[0] === 'I' && p[1] === category && p[2] === table) {
      headers = p.slice(4); // skip I,CAT,TABLE,VERSION
    } else if (p[0] === 'D' && p[1] === category && p[2] === table && headers) {
      const vals = p.slice(3);
      const row  = {};
      headers.forEach((h, i) => { row[h.trim()] = (vals[i] || '').replace(/"/g, '').trim(); });
      rows.push(row);
    }
  }
  return rows;
}

/* ── Source 1: OpenNEM actuals ─────────────────────────────────────────── */
async function fetchActuals(region) {
  const urls = [
    `https://api.opennem.org.au/v3/stats/price/network/NEM/${region}/`,
    `https://api.opennem.org.au/stats/price/network/NEM/${region}/`
  ];
  for (const url of urls) {
    try {
      const res = await timedFetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'LocalvoltsDashboard/1.0' }
      }, 12000);
      if (!res.ok) continue;
      const json = await res.json();
      const entry = (json.data || [])[0];
      if (!entry?.history?.data) continue;
      const { start, data: prices } = entry.history;
      const startMs = new Date(start).getTime();
      const stepMs  = 5 * 60 * 1000;
      // Last 12 intervals = ~1 hour of actuals
      const slice   = prices.slice(-12);
      const baseIdx = prices.length - slice.length;
      return slice
        .map((p, i) => p == null ? null : makeRow(region, aestDatetimeStr(startMs + (baseIdx+i)*stepMs), p, 'actual'))
        .filter(Boolean);
    } catch (_) { /* try next */ }
  }
  throw new Error('OpenNEM unreachable');
}

/* ── Source 2: AEMO P5 forecast ────────────────────────────────────────── */
const P5_FOLDER = 'https://www.nemweb.com.au/REPORTS/CURRENT/P5_Reports/';

async function fetchForecast(region) {
  // 1. Get directory listing
  const dirRes = await timedFetch(P5_FOLDER, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LocalvoltsDashboard/1.0)',
      'Accept': 'text/html,*/*'
    }
  }, 12000);
  if (!dirRes.ok) throw new Error('P5 dir HTTP ' + dirRes.status);
  const html = await dirRes.text();

  // 2. Pick latest ZIP
  const re   = /href="([^"]*PUBLIC_P5MIN[^"]*\.zip)"/gi;
  const zips = [];
  let m;
  while ((m = re.exec(html)) !== null) zips.push(m[1]);
  if (!zips.length) throw new Error('No P5 ZIP files found');
  zips.sort();
  let zipUrl = zips[zips.length - 1];
  if (!zipUrl.startsWith('http')) zipUrl = P5_FOLDER + zipUrl;

  // 3. Download ZIP
  const zipRes = await timedFetch(zipUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalvoltsDashboard/1.0)' }
  }, 20000);
  if (!zipRes.ok) throw new Error('P5 ZIP HTTP ' + zipRes.status);
  const buf = Buffer.from(await zipRes.arrayBuffer());

  // 4. Extract & parse
  const csv  = extractFirstFileFromZip(buf);
  const rows = parseAEMOCsv(csv, 'P5MIN', 'REGIONSOLUTION');

  return rows
    .filter(r => r.REGIONID === region)
    .map(r => makeRow(region, r.INTERVAL_DATETIME, r.RRP, 'forecast'))
    .filter(Boolean);
}

/* ── Handler ──────────────────────────────────────────────────────────── */
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const region = ((event.queryStringParameters || {}).region) || 'QLD1';

  // Run both in parallel — don't let one failure block the other
  const [actualsResult, forecastResult] = await Promise.allSettled([
    fetchActuals(region),
    fetchForecast(region)
  ]);

  const actuals  = actualsResult.status  === 'fulfilled' ? actualsResult.value  : [];
  const forecast = forecastResult.status === 'fulfilled' ? forecastResult.value : [];

  if (actualsResult.status === 'rejected')
    console.error('[aemo-proxy] actuals failed:', actualsResult.reason?.message);
  if (forecastResult.status === 'rejected')
    console.error('[aemo-proxy] forecast failed:', forecastResult.reason?.message);

  // Merge: for any overlapping time slot, actual wins over forecast
  const byTime = {};
  [...forecast, ...actuals].forEach(r => { byTime[r.intervalDatetime] = r; });

  const merged = Object.values(byTime).sort((a, b) =>
    a.intervalDatetime < b.intervalDatetime ? -1 : 1
  );

  if (merged.length === 0) {
    const err = [
      actualsResult.status  === 'rejected' ? 'actuals: '  + actualsResult.reason?.message  : null,
      forecastResult.status === 'rejected' ? 'forecast: ' + forecastResult.reason?.message : null
    ].filter(Boolean).join(' | ');
    return { statusCode: 502, headers, body: JSON.stringify({ error: err }) };
  }

  console.log(`[aemo-proxy] ${region}: ${actuals.length} actuals + ${forecast.length} forecast = ${merged.length} total`);
  return { statusCode: 200, headers, body: JSON.stringify(merged) };
};
