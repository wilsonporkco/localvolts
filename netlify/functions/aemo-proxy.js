/**
 * aemo-proxy.js — Netlify function
 *
 * Actuals  → OpenElectricity REST API (fast JSON, last 2 hours of 5-min prices)
 * Forecast → NEMWeb P5_Reports ZIP via HTTP Range requests using EOCD approach:
 *            1. HEAD → get total ZIP size
 *            2. Range: last 4096 bytes → parse EOCD + Central Directory → get
 *               accurate compressed size & data offset (works even for streaming ZIPs
 *               where local file header has cSize=0)
 *            3. Range: compressed data only → inflateRaw
 *
 * Both fetches run in parallel. If P5 fails, actuals still return.
 *
 * Requires env var: OPENELEC_API_KEY
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 * Returns JSON array: [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 */

'use strict';

const zlib    = require('node:zlib');
const OE_BASE = 'https://api.openelectricity.org.au/v4';
const NEMWEB  = 'https://www.nemweb.com.au';
const P5_DIR  = NEMWEB + '/REPORTS/CURRENT/P5_Reports/';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

/* ── generic fetch with timeout ─────────────────────────────────────── */
async function fetchWith(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid);
    return res;
  } catch (e) { clearTimeout(tid); throw e; }
}

/* ── OpenElectricity: last 2 hours of actuals ───────────────────────── */
async function fetchActuals(region, apiKey) {
  const twoHrsAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const url = OE_BASE + '/market/network/NEM'
    + '?metrics=price&interval=5m'
    + '&network_region=' + encodeURIComponent(region)
    + '&primary_grouping=network_region'
    + '&date_start=' + encodeURIComponent(twoHrsAgo);

  const res = await fetchWith(url, {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
  }, 10000);
  const raw = await res.json();
  if (!res.ok) throw new Error('OE HTTP ' + res.status + ': ' + JSON.stringify(raw.error || raw));

  const priceSeries = (raw.data || []).find(function(d) { return d.metric === 'price'; }) || (raw.data || [])[0];
  if (!priceSeries) throw new Error('No price series in OE response');

  const regionResult = (priceSeries.results || []).find(function(r) {
    return r.name && r.name.toUpperCase() === region;
  }) || (priceSeries.results || [])[0];

  if (!regionResult || !Array.isArray(regionResult.data)) throw new Error('No result data for ' + region);

  return regionResult.data.map(function(tuple) {
    const v = parseFloat(tuple[1]);
    if (!tuple[0] || isNaN(v)) return null;
    return { regionId: region, intervalDatetime: tuple[0].replace('T', ' ').slice(0, 19), rrp: +v.toFixed(2), rrpCkwh: +(v/10).toFixed(3), source: 'actual' };
  }).filter(Boolean);
}

/* ── NEMWeb ZIP helpers ──────────────────────────────────────────────── */
function resolveZipUrl(html, pattern) {
  const re = new RegExp('href="([^"]*' + pattern + '[^"]*\\.zip)"', 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) hits.push(m[1]);
  if (!hits.length) throw new Error('No P5 ZIP in NEMWeb listing');
  hits.sort();
  const path = hits[hits.length - 1];
  return path.startsWith('http') ? path : NEMWEB + (path.startsWith('/') ? path : '/' + path);
}

function parseMMS(csv, cat, tbl) {
  const rows = []; let cols = null;
  for (const raw of csv.split('\n')) {
    const p = raw.trim().split(',');
    if (p[0] === 'I' && p[1] === cat && p[2] === tbl) cols = p.slice(4);
    else if (p[0] === 'D' && p[1] === cat && p[2] === tbl && cols) {
      const row = {}; const vals = p.slice(3);
      cols.forEach(function(h, i) { row[h.trim()] = (vals[i] || '').replace(/"/g, '').trim(); });
      rows.push(row);
    }
  }
  return rows;
}

/* ── Download ZIP using EOCD + Range requests ───────────────────────── */
// AEMO often uses streaming compression: cSize=0 in local file header.
// Solution: read the Central Directory from the tail of the ZIP — it always
// has the correct compressed size, even for streaming ZIPs.
//
// Steps:
//   1. HEAD → Content-Length (total ZIP size)
//   2. Range: last 4096 bytes → EOCD + Central Directory → compSize + dataOffset
//   3. Range: compressed bytes → inflateRaw
async function downloadAndUnzip(zipUrl) {
  const hdrs = { 'User-Agent': UA };

  // ── Step 1: HEAD to get total file size ─────────────────────────────
  const headRes = await fetchWith(zipUrl, { method: 'HEAD', headers: hdrs }, 5000);
  const totalSize = parseInt(headRes.headers.get('content-length') || '0');
  if (!totalSize) throw new Error('No Content-Length from HEAD request');
  console.log('[aemo-proxy] ZIP total size:', totalSize, 'bytes');

  // ── Step 2: Fetch last 4096 bytes (EOCD + Central Directory) ────────
  const tailStart = Math.max(0, totalSize - 4096);
  const tailRes = await fetchWith(zipUrl, {
    headers: { ...hdrs, 'Range': 'bytes=' + tailStart + '-' + (totalSize - 1) }
  }, 7000);

  if (tailRes.status !== 206) {
    // Server doesn't support Range — fall back to full download
    console.log('[aemo-proxy] Range not supported (HTTP ' + tailRes.status + '), full download');
    const buf = Buffer.from(await tailRes.arrayBuffer());
    return inflateZipBuffer(buf);
  }

  const tail = Buffer.from(await tailRes.arrayBuffer());

  // Find End of Central Directory signature (search from end for safety)
  const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdPos  = tail.lastIndexOf(EOCD_SIG);
  if (eocdPos === -1) throw new Error('EOCD signature not found in ZIP tail');

  const cdOffset = tail.readUInt32LE(eocdPos + 16); // offset of CD from start of file
  const cdBufPos = cdOffset - tailStart;             // position within our tail buffer

  if (cdBufPos < 0 || cdBufPos >= tail.length) {
    throw new Error('Central Directory not in tail buffer (cdOffset=' + cdOffset + ' tailStart=' + tailStart + ')');
  }

  // Parse first Central Directory entry
  const CD_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  if (!tail.slice(cdBufPos, cdBufPos + 4).equals(CD_SIG)) {
    throw new Error('Central Directory signature mismatch at offset ' + cdBufPos);
  }

  const compMethod = tail.readUInt16LE(cdBufPos + 10);
  const compSize   = tail.readUInt32LE(cdBufPos + 20);
  const fnLen      = tail.readUInt16LE(cdBufPos + 28);
  const cdExLen    = tail.readUInt16LE(cdBufPos + 30);
  const lhOffset   = tail.readUInt32LE(cdBufPos + 42); // local header offset from file start

  console.log('[aemo-proxy] CD entry: method=' + compMethod + ' compSize=' + compSize + ' lhOffset=' + lhOffset);

  if (compSize === 0) throw new Error('Central Directory shows compSize=0 — unexpected');
  if (compMethod !== 8) throw new Error('Unexpected compression method: ' + compMethod);

  // Compute data start: local header (30) + filename (fnLen) + extra field
  // Use CD extra field length as approximation for local extra field (safe for non-ZIP64)
  const dataStart = lhOffset + 30 + fnLen + cdExLen;
  const dataEnd   = dataStart + compSize - 1;
  console.log('[aemo-proxy] P5 data range: bytes ' + dataStart + '-' + dataEnd + ' (' + compSize + ' compressed)');

  // ── Step 3: Fetch compressed data only ──────────────────────────────
  const dataRes = await fetchWith(zipUrl, {
    headers: { ...hdrs, 'Range': 'bytes=' + dataStart + '-' + dataEnd }
  }, 12000);

  if (dataRes.status !== 206) throw new Error('Data range request returned HTTP ' + dataRes.status);

  const compressed = Buffer.from(await dataRes.arrayBuffer());

  // Try inflateRaw; if it fails (off-by-a-few on extra field), retry with ±4 byte offset
  try {
    return zlib.inflateRawSync(compressed).toString('utf8');
  } catch (e) {
    // Local extra field length might differ from CD — try small offsets
    for (const delta of [4, -4, 8, -8, 12, -12]) {
      const adjustedStart = dataStart + delta;
      if (adjustedStart < 0 || adjustedStart + compSize > totalSize) continue;
      try {
        const retry = await fetchWith(zipUrl, {
          headers: { ...hdrs, 'Range': 'bytes=' + adjustedStart + '-' + (adjustedStart + compSize - 1) }
        }, 8000);
        if (retry.status === 206) {
          const comp2 = Buffer.from(await retry.arrayBuffer());
          return zlib.inflateRawSync(comp2).toString('utf8');
        }
      } catch (_) { /* try next delta */ }
    }
    throw new Error('inflateRaw failed after retries: ' + e.message);
  }
}

/* ── Full ZIP download + parse (fallback) ───────────────────────────── */
function inflateZipBuffer(buf) {
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const off  = buf.indexOf(SIG);
  if (off === -1) throw new Error('Not a valid ZIP');
  const method = buf.readUInt16LE(off + 8);
  const start  = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  let cSize    = buf.readUInt32LE(off + 18);
  if (cSize === 0) { const nxt = buf.indexOf(SIG, start); cSize = (nxt === -1 ? buf.length : nxt) - start; }
  const data   = buf.slice(start, start + cSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error('Unknown ZIP compression method ' + method);
}

/* ── NEMWeb P5: forecast ~1 hour ahead ──────────────────────────────── */
async function fetchForecast(region) {
  // Get directory listing to find current ZIP URL
  const htmlRes = await fetchWith(P5_DIR, { headers: { 'User-Agent': UA } }, 7000);
  if (!htmlRes.ok) throw new Error('NEMWeb listing HTTP ' + htmlRes.status);
  const zipUrl  = resolveZipUrl(await htmlRes.text(), 'PUBLIC_P5MIN');
  console.log('[aemo-proxy] P5 ZIP:', zipUrl);

  const csv  = await downloadAndUnzip(zipUrl);
  const rows = parseMMS(csv, 'P5MIN', 'REGIONSOLUTION');

  return rows.filter(function(r) { return r.REGIONID === region; })
    .map(function(r) {
      const v = parseFloat(r.RRP);
      if (isNaN(v) || !r.INTERVAL_DATETIME) return null;
      return { regionId: region, intervalDatetime: r.INTERVAL_DATETIME.replace('T', ' ').slice(0, 19), rrp: +v.toFixed(2), rrpCkwh: +(v/10).toFixed(3), source: 'forecast' };
    }).filter(Boolean);
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

  const apiKey = process.env.OPENELEC_API_KEY;
  if (!apiKey) {
    return { statusCode: 502, headers: hdrs, body: JSON.stringify({ error: 'OPENELEC_API_KEY not set in Netlify environment variables' }) };
  }

  const region = ((event.queryStringParameters || {}).region || 'QLD1').toUpperCase();

  // Run both in parallel — forecast failure is non-fatal
  const [aRes, fRes] = await Promise.allSettled([
    fetchActuals(region, apiKey),
    fetchForecast(region)
  ]);

  const actuals  = aRes.status === 'fulfilled' ? aRes.value : [];
  const forecast = fRes.status === 'fulfilled' ? fRes.value : [];

  if (aRes.status === 'rejected') console.error('[aemo-proxy] actuals error:', aRes.reason?.message);
  if (fRes.status === 'rejected') console.warn('[aemo-proxy] forecast error (non-fatal):', fRes.reason?.message);

  if (!actuals.length && !forecast.length) {
    const err = [
      aRes.status === 'rejected' ? 'actuals: ' + aRes.reason?.message : null,
      fRes.status === 'rejected' ? 'forecast: ' + fRes.reason?.message : null
    ].filter(Boolean).join(' | ');
    return { statusCode: 502, headers: hdrs, body: JSON.stringify({ error: err }) };
  }

  // Merge: actuals win over forecast for same timestamp
  const byTime = {};
  [...forecast, ...actuals].forEach(function(r) { byTime[r.intervalDatetime] = r; });
  const merged = Object.values(byTime).sort(function(a, b) {
    return a.intervalDatetime < b.intervalDatetime ? -1 : 1;
  });

  console.log('[aemo-proxy] ' + region + ': ' + actuals.length + ' actual + ' + forecast.length + ' forecast');
  return { statusCode: 200, headers: hdrs, body: JSON.stringify(merged) };
};
