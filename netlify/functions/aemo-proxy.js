/**
 * aemo-proxy.js — Netlify function
 *
 * Fetches NEM spot prices from AEMO NEMWeb public ZIP files.
 * Both endpoints are on www.nemweb.com.au which is reachable from Netlify.
 *
 *   Actuals  → DispatchIS_Reports  (latest settled 5-min dispatch price)
 *   Forecast → P5_Reports          (P5 pre-dispatch, ~1 hour ahead, every 5 min)
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 * Returns JSON array: [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 *   source: "actual" | "forecast"
 *
 * No API key required. ZIP extraction uses native Node zlib.
 */

'use strict';

const zlib = require('node:zlib');

const NEMWEB      = 'https://www.nemweb.com.au';
const P5_DIR      = NEMWEB + '/REPORTS/CURRENT/P5_Reports/';
const DISPATCH_DIR = NEMWEB + '/REPORTS/CURRENT/DispatchIS_Reports/';

/* ── fetch helpers ───────────────────────────────────────────────────── */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function get(url, asBuffer, timeoutMs) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': asBuffer ? '*/*' : 'text/html,*/*' }
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
    return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } catch (e) { clearTimeout(tid); throw e; }
}

/* ── resolve ZIP URL from directory listing ─────────────────────────── */
// hrefs in NEMWEB listings are absolute paths: /REPORTS/CURRENT/.../file.zip
function resolveZipUrl(html, pattern) {
  const re   = new RegExp('href="([^"]*' + pattern + '[^"]*\\.zip)"', 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) hits.push(m[1]);
  if (!hits.length) throw new Error('No matching ZIP in directory listing');
  hits.sort();
  const path = hits[hits.length - 1]; // latest = last alphabetically
  return path.startsWith('http') ? path : NEMWEB + (path.startsWith('/') ? path : '/' + path);
}

/* ── ZIP extraction (native zlib, no npm) ────────────────────────────── */
function unzipFirst(buf) {
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const off  = buf.indexOf(SIG);
  if (off === -1) throw new Error('Not a valid ZIP file');
  const method   = buf.readUInt16LE(off + 8);
  const fnLen    = buf.readUInt16LE(off + 26);
  const exLen    = buf.readUInt16LE(off + 28);
  const start    = off + 30 + fnLen + exLen;
  let   cSize    = buf.readUInt32LE(off + 18);
  if (cSize === 0) {
    const next = buf.indexOf(SIG, start);
    cSize = (next === -1 ? buf.length : next) - start;
  }
  const data = buf.slice(start, start + cSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error('Unsupported ZIP compression method ' + method);
}

/* ── AEMO MMS CSV parser ─────────────────────────────────────────────── */
// I,CATEGORY,TABLE,VERSION,col1,col2,...   ← header
// D,CATEGORY,TABLE,val1,val2,...           ← data
function parseMMS(csv, category, table) {
  const rows = [];
  let   cols = null;
  for (const raw of csv.split('\n')) {
    const p = raw.trim().split(',');
    if (p[0] === 'I' && p[1] === category && p[2] === table) {
      cols = p.slice(4); // skip I,CAT,TABLE,VERSION
    } else if (p[0] === 'D' && p[1] === category && p[2] === table && cols) {
      const vals = p.slice(3);
      const row  = {};
      cols.forEach((h, i) => { row[h.trim()] = (vals[i] || '').replace(/"/g, '').trim(); });
      rows.push(row);
    }
  }
  return rows;
}

/* ── row factory ─────────────────────────────────────────────────────── */
function mkRow(region, dt, rrpStr, source) {
  const v = parseFloat(rrpStr);
  if (isNaN(v) || !dt) return null;
  return { regionId: region, intervalDatetime: dt, rrp: +v.toFixed(2), rrpCkwh: +(v/10).toFixed(3), source };
}

/* ── sources ─────────────────────────────────────────────────────────── */
async function fetchActuals(region) {
  const html   = await get(DISPATCH_DIR, false, 12000);
  const zipUrl = resolveZipUrl(html, 'PUBLIC_DISPATCHIS');
  console.log('[aemo-proxy] DispatchIS ZIP:', zipUrl);
  const buf    = await get(zipUrl, true, 20000);
  const csv    = unzipFirst(buf);
  const rows   = parseMMS(csv, 'DISPATCH', 'PRICE');
  return rows
    .filter(r => r.REGIONID === region && r.INTERVENTION === '0')
    .map(r => mkRow(region, r.SETTLEMENTDATE, r.RRP, 'actual'))
    .filter(Boolean);
}

async function fetchForecast(region) {
  const html   = await get(P5_DIR, false, 12000);
  const zipUrl = resolveZipUrl(html, 'PUBLIC_P5MIN');
  console.log('[aemo-proxy] P5 ZIP:', zipUrl);
  const buf    = await get(zipUrl, true, 20000);
  const csv    = unzipFirst(buf);
  const rows   = parseMMS(csv, 'P5MIN', 'REGIONSOLUTION');
  return rows
    .filter(r => r.REGIONID === region)
    .map(r => mkRow(region, r.INTERVAL_DATETIME, r.RRP, 'forecast'))
    .filter(Boolean);
}

/* ── handler ─────────────────────────────────────────────────────────── */
exports.handler = async function (event) {
  const hdrs = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: hdrs, body: '' };

  const region = ((event.queryStringParameters || {}).region) || 'QLD1';

  const [aRes, fRes] = await Promise.allSettled([fetchActuals(region), fetchForecast(region)]);

  const actuals  = aRes.status === 'fulfilled' ? aRes.value  : [];
  const forecast = fRes.status === 'fulfilled' ? fRes.value : [];

  if (aRes.status === 'rejected') console.error('[aemo-proxy] actuals:', aRes.reason?.message);
  if (fRes.status === 'rejected') console.error('[aemo-proxy] forecast:', fRes.reason?.message);

  // Merge — actual beats forecast for same time slot
  const byTime = {};
  [...forecast, ...actuals].forEach(r => { byTime[r.intervalDatetime] = r; });
  const merged = Object.values(byTime).sort((a, b) => a.intervalDatetime < b.intervalDatetime ? -1 : 1);

  if (!merged.length) {
    const err = [
      aRes.status === 'rejected' ? 'actuals: ' + aRes.reason?.message : null,
      fRes.status === 'rejected' ? 'forecast: ' + fRes.reason?.message : null
    ].filter(Boolean).join(' | ');
    return { statusCode: 502, headers: hdrs, body: JSON.stringify({ error: err }) };
  }

  console.log(`[aemo-proxy] ${region}: ${actuals.length} actual + ${forecast.length} forecast`);
  return { statusCode: 200, headers: hdrs, body: JSON.stringify(merged) };
};
