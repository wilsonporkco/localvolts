/**
 * aemo-proxy.js — Netlify function
 *
 * Actuals  → OpenElectricity REST API (fast JSON, last 2 hours of 5-min prices)
 * Forecast → NEMWeb P5_Reports ZIP (pre-dispatch, ~1 hour ahead, every 5 min)
 *
 * Both fetches run in parallel. If P5 fails, actuals still return.
 *
 * Requires env var: OPENELEC_API_KEY
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 * Returns JSON array: [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 *   source: "actual" | "forecast"
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

function unzipFirst(buf) {
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const off  = buf.indexOf(SIG);
  if (off === -1) throw new Error('Not a ZIP');
  const method = buf.readUInt16LE(off + 8);
  const start  = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  let cSize    = buf.readUInt32LE(off + 18);
  if (cSize === 0) { const nxt = buf.indexOf(SIG, start); cSize = (nxt === -1 ? buf.length : nxt) - start; }
  const data = buf.slice(start, start + cSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error('Unknown ZIP method ' + method);
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

/* ── NEMWeb P5: forecast ~1 hour ahead ──────────────────────────────── */
async function fetchForecast(region) {
  const htmlRes = await fetchWith(P5_DIR, { headers: { 'User-Agent': UA } }, 7000);
  if (!htmlRes.ok) throw new Error('NEMWeb listing HTTP ' + htmlRes.status);
  const html   = await htmlRes.text();
  const zipUrl = resolveZipUrl(html, 'PUBLIC_P5MIN');
  console.log('[aemo-proxy] P5 ZIP:', zipUrl);

  const zipRes = await fetchWith(zipUrl, { headers: { 'User-Agent': UA } }, 16000);
  if (!zipRes.ok) throw new Error('P5 ZIP HTTP ' + zipRes.status);
  const buf  = Buffer.from(await zipRes.arrayBuffer());
  const csv  = unzipFirst(buf);
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
