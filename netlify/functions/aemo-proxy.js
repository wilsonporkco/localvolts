/**
 * aemo-proxy.js — Netlify function
 *
 * Fetches NEM spot prices from AEMO NEMWeb public ZIP files.
 * Fetches P5_Reports only (one ZIP = fastest path, avoids timeout).
 * The P5 pre-dispatch runs every 5 min and covers now + ~1 hour ahead.
 * The first interval in the file is the "current" price; the rest are forecast.
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 * Returns JSON array: [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 *   source: "actual" (current interval) | "forecast" (future intervals)
 *
 * No API key required. ZIP extraction uses native Node zlib.
 */

'use strict';

const zlib = require('node:zlib');

const NEMWEB  = 'https://www.nemweb.com.au';
const P5_DIR  = NEMWEB + '/REPORTS/CURRENT/P5_Reports/';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ── fetch with timeout ─────────────────────────────────────────────── */
async function get(url, asBuffer, timeoutMs) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
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

/* ── resolve latest ZIP URL from NEMWeb directory listing ───────────── */
// NEMWeb hrefs are absolute paths: /REPORTS/CURRENT/P5_Reports/file.zip
function resolveZipUrl(html, pattern) {
  const re   = new RegExp('href="([^"]*' + pattern + '[^"]*\\.zip)"', 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) hits.push(m[1]);
  if (!hits.length) throw new Error('No matching ZIP found in NEMWeb directory listing');
  hits.sort();
  const path = hits[hits.length - 1];
  return path.startsWith('http') ? path : NEMWEB + (path.startsWith('/') ? path : '/' + path);
}

/* ── ZIP extraction (native zlib, no npm) ───────────────────────────── */
function unzipFirst(buf) {
  const SIG  = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const off  = buf.indexOf(SIG);
  if (off === -1) throw new Error('Not a valid ZIP file');
  const method = buf.readUInt16LE(off + 8);
  const fnLen  = buf.readUInt16LE(off + 26);
  const exLen  = buf.readUInt16LE(off + 28);
  const start  = off + 30 + fnLen + exLen;
  let   cSize  = buf.readUInt32LE(off + 18);
  if (cSize === 0) {
    const next = buf.indexOf(SIG, start);
    cSize = (next === -1 ? buf.length : next) - start;
  }
  const data = buf.slice(start, start + cSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error('Unsupported ZIP compression method ' + method);
}

/* ── AEMO MMS CSV parser ────────────────────────────────────────────── */
// I,CATEGORY,TABLE,VERSION,col1,col2,...  ← header row
// D,CATEGORY,TABLE,val1,val2,...          ← data row
function parseMMS(csv, category, table) {
  const rows = [];
  let   cols = null;
  for (const raw of csv.split('\n')) {
    const p = raw.trim().split(',');
    if (p[0] === 'I' && p[1] === category && p[2] === table) {
      cols = p.slice(4);
    } else if (p[0] === 'D' && p[1] === category && p[2] === table && cols) {
      const vals = p.slice(3);
      const row  = {};
      cols.forEach((h, i) => { row[h.trim()] = (vals[i] || '').replace(/"/g, '').trim(); });
      rows.push(row);
    }
  }
  return rows;
}

/* ── handler ────────────────────────────────────────────────────────── */
exports.handler = async function (event) {
  const hdrs = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: hdrs, body: '' };

  const region = ((event.queryStringParameters || {}).region || 'QLD1').toUpperCase();

  try {
    // Step 1: get directory listing (~5 KB HTML, fast)
    const html   = await get(P5_DIR, false, 8000);
    const zipUrl = resolveZipUrl(html, 'PUBLIC_P5MIN');
    console.log('[aemo-proxy] P5 ZIP:', zipUrl);

    // Step 2: download + decompress ZIP (~200-500 KB)
    const buf = await get(zipUrl, true, 18000);
    const csv = unzipFirst(buf);

    // Step 3: parse MMS CSV
    const rows = parseMMS(csv, 'P5MIN', 'REGIONSOLUTION');
    const filtered = rows.filter(r => r.REGIONID === region);

    if (!filtered.length) {
      return { statusCode: 502, headers: hdrs, body: JSON.stringify({ error: 'No data for region ' + region }) };
    }

    // Sort by interval datetime ascending
    filtered.sort((a, b) => a.INTERVAL_DATETIME < b.INTERVAL_DATETIME ? -1 : 1);

    // Label first interval as "actual" (current dispatch period), rest as "forecast"
    const result = filtered.map((r, i) => {
      const v = parseFloat(r.RRP);
      if (isNaN(v)) return null;
      return {
        regionId:          region,
        intervalDatetime:  r.INTERVAL_DATETIME,
        rrp:               +v.toFixed(2),
        rrpCkwh:           +(v / 10).toFixed(3),
        source:            i === 0 ? 'actual' : 'forecast'
      };
    }).filter(Boolean);

    console.log('[aemo-proxy] ' + region + ': ' + result.length + ' intervals (1 actual + ' + (result.length - 1) + ' forecast)');
    return { statusCode: 200, headers: hdrs, body: JSON.stringify(result) };

  } catch (err) {
    console.error('[aemo-proxy] error:', err.message);
    const isTimeout = err.name === 'AbortError' || err.message.includes('abort');
    return {
      statusCode: 502,
      headers: hdrs,
      body: JSON.stringify({ error: isTimeout ? 'NEMWeb request timed out' : err.message })
    };
  }
};
