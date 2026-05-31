/**
 * aemo-proxy.js — Netlify function
 *
 * Actuals  → OpenElectricity REST API
 * Forecast → NEMWeb P5_Reports ZIP via 2 Range requests:
 *   1. Range: bytes=-4096  → EOCD + Central Directory
 *                           → compSize, lhOffset, fnLen  (exact, even for streaming ZIPs)
 *   2. Range: lhOffset … lhOffset+30+fnLen+64+compSize-1
 *                           → local header (gives exact lhExLen) + compressed data
 *                           → inflateRaw → CSV
 *
 * No HEAD request needed. Falls back to full download if Range not supported.
 *
 * Requires env var: OPENELEC_API_KEY
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 */

'use strict';

const zlib   = require('node:zlib');
const OE_BASE = 'https://api.openelectricity.org.au/v4';
const NEMWEB  = 'https://www.nemweb.com.au';
const P5_DIR  = NEMWEB + '/REPORTS/CURRENT/P5_Reports/';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

/* ── fetch with timeout ─────────────────────────────────────────────── */
async function fetchWith(url, opts, ms) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try   { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(tid); return r; }
  catch (e) { clearTimeout(tid); throw e; }
}

/* ── OpenElectricity: last 2 hrs of actuals ─────────────────────────── */
async function fetchActuals(region, apiKey) {
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 19);
  const url   = OE_BASE + '/market/network/NEM'
    + '?metrics=price&interval=5m'
    + '&network_region=' + encodeURIComponent(region)
    + '&primary_grouping=network_region'
    + '&date_start=' + encodeURIComponent(since);

  const res = await fetchWith(url, {
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }
  }, 10000);
  const raw = await res.json();
  if (!res.ok) throw new Error('OE ' + res.status + ': ' + JSON.stringify(raw.error || raw));

  const series = (raw.data || []).find(d => d.metric === 'price') || (raw.data || [])[0];
  if (!series) throw new Error('No price series in OE response');
  const reg = (series.results || []).find(r => r.name && r.name.toUpperCase() === region)
           || (series.results || [])[0];
  if (!reg || !Array.isArray(reg.data)) throw new Error('No result data for ' + region);

  return reg.data.map(t => {
    const v = parseFloat(t[1]);
    if (!t[0] || isNaN(v)) return null;
    return { regionId: region, intervalDatetime: t[0].replace('T', ' ').slice(0, 19),
             rrp: +v.toFixed(2), rrpCkwh: +(v / 10).toFixed(3), source: 'actual' };
  }).filter(Boolean);
}

/* ── NEMWeb helpers ─────────────────────────────────────────────────── */
function resolveZipUrl(html, pattern) {
  const re   = new RegExp('href="([^"]*' + pattern + '[^"]*\\.zip)"', 'gi');
  const hits = []; let m;
  while ((m = re.exec(html)) !== null) hits.push(m[1]);
  if (!hits.length) throw new Error('No P5 ZIP in NEMWeb listing');
  hits.sort();
  const path = hits[hits.length - 1];
  return path.startsWith('http') ? path : NEMWEB + (path.startsWith('/') ? path : '/' + path);
}

function parseMMS(csv, cat, tbl) {
  const rows = []; let cols = null;
  for (const line of csv.split('\n')) {
    const p = line.trim().split(',');
    if      (p[0] === 'I' && p[1] === cat && p[2] === tbl) cols = p.slice(4);
    else if (p[0] === 'D' && p[1] === cat && p[2] === tbl && cols) {
      const row = {}, vals = p.slice(3);
      cols.forEach((h, i) => { row[h.trim()] = (vals[i] || '').replace(/"/g, '').trim(); });
      rows.push(row);
    }
  }
  return rows;
}

/* ── Full ZIP download fallback ─────────────────────────────────────── */
function inflateZipBuffer(buf) {
  const SIG  = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const off  = buf.indexOf(SIG);
  if (off === -1) throw new Error('Not a valid ZIP');
  const method = buf.readUInt16LE(off + 8);
  const start  = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  let   cSize  = buf.readUInt32LE(off + 18);
  if (cSize === 0) { const nxt = buf.indexOf(SIG, start); cSize = (nxt < 0 ? buf.length : nxt) - start; }
  const data = buf.slice(start, start + cSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error('Unknown compression method ' + method);
}

/* ── Smart ZIP downloader: 2 Range requests, no HEAD needed ─────────── */
async function downloadAndUnzip(zipUrl) {
  const hdrs = { 'User-Agent': UA };

  // ── Request 1: last 4096 bytes  →  EOCD + Central Directory ─────────
  // Using suffix range (bytes=-N) avoids needing a HEAD request first.
  // The 206 response's Content-Range header tells us the total file size.
  const tailRes = await fetchWith(zipUrl, {
    headers: { ...hdrs, Range: 'bytes=-4096' }
  }, 8000);

  if (tailRes.status !== 206) {
    // Server doesn't support Range — download the whole ZIP
    console.log('[aemo-proxy] Range not supported (HTTP ' + tailRes.status + '), full download fallback');
    const buf = Buffer.from(await (tailRes.ok ? tailRes : fetchWith(zipUrl, { headers: hdrs }, 18000)).arrayBuffer());
    return inflateZipBuffer(buf);
  }

  // Parse total file size from Content-Range: bytes START-END/TOTAL
  const cr          = tailRes.headers.get('content-range') || '';
  const totalMatch  = cr.match(/\/(\d+)$/);
  if (!totalMatch)  throw new Error('No total size in Content-Range: "' + cr + '"');
  const totalSize   = parseInt(totalMatch[1]);
  const tailFileOff = Math.max(0, totalSize - 4096);   // file offset where our tail buffer starts
  const tail        = Buffer.from(await tailRes.arrayBuffer());

  // Find End-of-Central-Directory signature (scan from end in case of ZIP comment)
  const EOCD_SIG  = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdBufPos = tail.lastIndexOf(EOCD_SIG);
  if (eocdBufPos === -1) throw new Error('EOCD not found in last ' + tail.length + ' bytes');

  const cdOffset  = tail.readUInt32LE(eocdBufPos + 16);   // file offset of Central Directory
  const cdBufPos  = cdOffset - tailFileOff;               // position within our tail buffer
  if (cdBufPos < 0 || cdBufPos + 46 > tail.length) {
    throw new Error('CD at file-offset ' + cdOffset + ' is outside tail buffer (tailStart=' + tailFileOff + ')');
  }

  // Verify Central Directory entry signature
  if (tail[cdBufPos] !== 0x50 || tail[cdBufPos+1] !== 0x4b ||
      tail[cdBufPos+2] !== 0x01 || tail[cdBufPos+3] !== 0x02) {
    throw new Error('Central Directory signature mismatch');
  }

  const compMethod = tail.readUInt16LE(cdBufPos + 10);
  const compSize   = tail.readUInt32LE(cdBufPos + 20);   // accurate even for streaming ZIPs
  const fnLen      = tail.readUInt16LE(cdBufPos + 28);
  const lhOffset   = tail.readUInt32LE(cdBufPos + 42);   // file offset of local header

  console.log('[aemo-proxy] CD: method=' + compMethod + ' compSize=' + compSize
    + ' fnLen=' + fnLen + ' lhOffset=' + lhOffset);

  if (compMethod !== 8) throw new Error('Unexpected compression method: ' + compMethod);
  if (compSize   === 0) throw new Error('Central Directory shows compSize=0');

  // ── Request 2: local header + compressed data in one fetch ───────────
  // We don't know lhExLen yet, so we fetch 64 extra bytes as a safety margin.
  // Once we have the buffer we read lhExLen directly from the local header.
  const fetchEnd = lhOffset + 30 + fnLen + 64 + compSize - 1;
  const dataRes  = await fetchWith(zipUrl, {
    headers: { ...hdrs, Range: 'bytes=' + lhOffset + '-' + fetchEnd }
  }, 13000);

  if (dataRes.status !== 206) throw new Error('Data range returned HTTP ' + dataRes.status);
  const data = Buffer.from(await dataRes.arrayBuffer());

  // Validate local header signature
  if (data[0] !== 0x50 || data[1] !== 0x4b || data[2] !== 0x03 || data[3] !== 0x04) {
    throw new Error('Local header signature mismatch in fetched data');
  }

  // Read actual local header field lengths
  const lhFnLen  = data.readUInt16LE(26);
  const lhExLen  = data.readUInt16LE(28);
  const dataOff  = 30 + lhFnLen + lhExLen;    // exact offset of compressed data within buffer
  console.log('[aemo-proxy] LH: fnLen=' + lhFnLen + ' exLen=' + lhExLen + ' → dataOff=' + dataOff);

  if (dataOff + compSize > data.length) {
    throw new Error('Compressed data extends beyond fetched buffer (dataOff=' + dataOff
      + ' compSize=' + compSize + ' bufLen=' + data.length + ')');
  }

  return zlib.inflateRawSync(data.slice(dataOff, dataOff + compSize)).toString('utf8');
}

/* ── P5 forecast fetch ──────────────────────────────────────────────── */
async function fetchForecast(region) {
  const htmlRes = await fetchWith(P5_DIR, { headers: { 'User-Agent': UA } }, 7000);
  if (!htmlRes.ok) throw new Error('NEMWeb listing HTTP ' + htmlRes.status);
  const zipUrl = resolveZipUrl(await htmlRes.text(), 'PUBLIC_P5MIN');
  console.log('[aemo-proxy] ZIP:', zipUrl);

  const csv  = await downloadAndUnzip(zipUrl);
  const rows = parseMMS(csv, 'P5MIN', 'REGIONSOLUTION');

  return rows
    .filter(r => r.REGIONID === region)
    .map(r => {
      const v = parseFloat(r.RRP);
      if (isNaN(v) || !r.INTERVAL_DATETIME) return null;
      return { regionId: region,
               intervalDatetime: r.INTERVAL_DATETIME.replace('T', ' ').slice(0, 19),
               rrp: +v.toFixed(2), rrpCkwh: +(v / 10).toFixed(3), source: 'forecast' };
    })
    .filter(Boolean);
}

/* ── Netlify handler ────────────────────────────────────────────────── */
exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':  'application/json',
    'Cache-Control': 'no-cache',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const apiKey = process.env.OPENELEC_API_KEY;
  if (!apiKey) return { statusCode: 502, headers: cors,
    body: JSON.stringify({ error: 'OPENELEC_API_KEY not configured' }) };

  const region = ((event.queryStringParameters || {}).region || 'QLD1').toUpperCase();

  const [aRes, fRes] = await Promise.allSettled([
    fetchActuals(region, apiKey),
    fetchForecast(region),
  ]);

  if (aRes.status === 'rejected') console.error('[aemo-proxy] actuals:', aRes.reason?.message);
  if (fRes.status === 'rejected') console.warn( '[aemo-proxy] forecast:', fRes.reason?.message);

  const actuals  = aRes.status === 'fulfilled' ? aRes.value : [];
  const forecast = fRes.status === 'fulfilled' ? fRes.value : [];

  if (!actuals.length && !forecast.length) {
    const msg = [
      aRes.status === 'rejected' ? 'actuals: '  + aRes.reason?.message : null,
      fRes.status === 'rejected' ? 'forecast: ' + fRes.reason?.message : null,
    ].filter(Boolean).join(' | ');
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: msg }) };
  }

  // Merge: actuals win over forecast at same timestamp
  const byTime = {};
  [...forecast, ...actuals].forEach(r => { byTime[r.intervalDatetime] = r; });
  const merged = Object.values(byTime).sort((a, b) =>
    a.intervalDatetime < b.intervalDatetime ? -1 : 1);

  console.log('[aemo-proxy] ' + region + ': ' + actuals.length + ' actual + ' + forecast.length + ' forecast → ' + merged.length + ' total');
  return { statusCode: 200, headers: cors, body: JSON.stringify(merged) };
};
