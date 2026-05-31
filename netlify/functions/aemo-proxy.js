/**
 * aemo-proxy.js — Netlify function
 *
 * Fetches AEMO 5-minute pre-dispatch price forecasts (P5_Reports) and actual
 * dispatch prices (DispatchIS_Reports) from AEMO NEMWeb public ZIP files.
 * No API key required — NEMWeb is a public data service.
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 *
 * Returns JSON array (ascending datetime):
 *   [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 *   source is "P5" (forecast) or "DISPATCH" (actual)
 *
 * ZIP extraction uses Node's built-in zlib — no npm packages needed.
 */

'use strict';

const zlib = require('node:zlib');

/* ── URL roots ─────────────────────────────────────────────────────────── */
const P5_FOLDER       = 'https://www.nemweb.com.au/REPORTS/CURRENT/P5_Reports/';
const DISPATCH_FOLDER = 'https://www.nemweb.com.au/REPORTS/CURRENT/DispatchIS_Reports/';

/* ── Fetch helpers ─────────────────────────────────────────────────────── */
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalvoltsDashboard/1.0; +https://wilsonporkco.com.au)',
        'Accept':     'text/html,application/xhtml+xml,*/*'
      }
    });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
    return await r.text();
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

async function fetchBinary(url, timeoutMs) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalvoltsDashboard/1.0; +https://wilsonporkco.com.au)'
      }
    });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ZIP');
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

/* ── ZIP parsing (native Node zlib, no npm) ────────────────────────────── */
function extractFirstCsvFromZip(buf) {
  // Find local file header signature: PK\x03\x04
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const offset = buf.indexOf(SIG);
  if (offset === -1) throw new Error('Not a ZIP file');

  const method       = buf.readUInt16LE(offset + 8);   // 0=stored, 8=deflated
  const fileNameLen  = buf.readUInt16LE(offset + 26);
  const extraLen     = buf.readUInt16LE(offset + 28);
  const dataStart    = offset + 30 + fileNameLen + extraLen;

  // Compressed size from local header (may be 0 if data descriptor used).
  // Fall back to reading until the next PK header if size is unknown.
  let compressedSize = buf.readUInt32LE(offset + 18);
  if (compressedSize === 0) {
    // Scan for next signature (data descriptor or next local file)
    const next = buf.indexOf(SIG, dataStart);
    compressedSize = (next === -1 ? buf.length : next) - dataStart;
  }

  const compressed = buf.slice(dataStart, dataStart + compressedSize);

  if (method === 0) return compressed.toString('utf8');         // stored
  if (method === 8) return zlib.inflateRawSync(compressed).toString('utf8'); // deflate
  throw new Error('Unsupported ZIP compression method: ' + method);
}

/* ── AEMO MMS CSV parsing ──────────────────────────────────────────────── */
/**
 * Parses AEMO's MMS CSV format.
 * Rows: C (comment), I (header), D (data)
 * I row: I,CATEGORY,TABLE,VERSION,col1,col2,...
 * D row: D,CATEGORY,TABLE,val1,val2,...
 *
 * Returns array of plain objects for the first matching table.
 */
function parseAEMOCsv(csvText, category, table) {
  const lines   = csvText.split('\n');
  let headers   = null;
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const raw   = lines[i].trim();
    if (!raw) continue;
    const parts = raw.split(',');

    if (parts[0] === 'I' && parts[1] === category && parts[2] === table) {
      // Header columns start at index 4 (after I,CATEGORY,TABLE,VERSION)
      headers = parts.slice(4);
      continue;
    }

    if (parts[0] === 'D' && parts[1] === category && parts[2] === table && headers) {
      const vals = parts.slice(3); // skip D,CATEGORY,TABLE
      const row  = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j].trim()] = (vals[j] || '').replace(/"/g, '').trim();
      }
      results.push(row);
    }
  }

  return results;
}

/* ── Directory listing: pick latest ZIP ───────────────────────────────── */
function latestZipUrl(html, folderUrl) {
  // HREF values from <a href="..."> that end in .zip (case insensitive)
  const re    = /href="([^"]+\.zip)"/gi;
  const found = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    found.push(m[1]);
  }
  if (!found.length) throw new Error('No ZIP files found in directory listing');
  found.sort();
  const latest = found[found.length - 1];
  // May be relative or absolute
  return latest.startsWith('http') ? latest : folderUrl + latest;
}

/* ── Format a single price row ─────────────────────────────────────────── */
function makeRow(regionId, datetimeStr, rrpStr, source) {
  const rrp = parseFloat(rrpStr);
  if (isNaN(rrp)) return null;
  // AEMO datetime format: "2024/01/15 00:05:00" — keep as-is for frontend
  return {
    regionId:         regionId,
    intervalDatetime: datetimeStr,
    rrp:              parseFloat(rrp.toFixed(2)),
    rrpCkwh:          parseFloat((rrp / 10).toFixed(3)),
    source:           source
  };
}

/* ── Main handler ──────────────────────────────────────────────────────── */
exports.handler = async function(event) {
  const respHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: respHeaders, body: '' };
  }

  const region = ((event.queryStringParameters || {}).region) || 'QLD1';
  const rows   = [];
  const errors = [];

  /* ── 1. P5 pre-dispatch forecast (1 hour ahead, updated every 5 min) ── */
  try {
    const dirHtml  = await fetchText(P5_FOLDER, 10000);
    const zipUrl   = latestZipUrl(dirHtml, P5_FOLDER);
    console.log('[aemo-proxy] P5 ZIP:', zipUrl);

    const zipBuf   = await fetchBinary(zipUrl, 20000);
    const csvText  = extractFirstCsvFromZip(zipBuf);

    // P5MIN table: I,P5MIN,REGIONSOLUTION,VERSION,RUN_DATETIME,INTERVAL_DATETIME,REGIONID,...,RRP,...
    const p5Rows   = parseAEMOCsv(csvText, 'P5MIN', 'REGIONSOLUTION');
    console.log('[aemo-proxy] P5 rows total:', p5Rows.length);

    p5Rows
      .filter(function(r) { return r.REGIONID === region; })
      .forEach(function(r) {
        const row = makeRow(region, r.INTERVAL_DATETIME, r.RRP, 'P5');
        if (row) rows.push(row);
      });

    console.log('[aemo-proxy] P5 rows for', region + ':', rows.length);
  } catch (err) {
    errors.push('P5: ' + err.message);
    console.error('[aemo-proxy] P5 error:', err.message);
  }

  /* ── 2. DispatchIS actual dispatch price (most recent 5-min interval) ── */
  try {
    const dirHtml  = await fetchText(DISPATCH_FOLDER, 10000);
    const zipUrl   = latestZipUrl(dirHtml, DISPATCH_FOLDER);
    console.log('[aemo-proxy] DispatchIS ZIP:', zipUrl);

    const zipBuf   = await fetchBinary(zipUrl, 20000);
    const csvText  = extractFirstCsvFromZip(zipBuf);

    // DISPATCH table: I,DISPATCH,PRICE,2,SETTLEMENTDATE,RUNNO,REGIONID,...,RRP,...
    const dRows    = parseAEMOCsv(csvText, 'DISPATCH', 'PRICE');
    console.log('[aemo-proxy] DISPATCH rows total:', dRows.length);

    dRows
      .filter(function(r) { return r.REGIONID === region && r.INTERVENTION === '0'; })
      .forEach(function(r) {
        const row = makeRow(region, r.SETTLEMENTDATE, r.RRP, 'DISPATCH');
        if (row) rows.push(row);
      });

    console.log('[aemo-proxy] DISPATCH rows for', region + ':', rows.filter(function(r){ return r.source === 'DISPATCH'; }).length);
  } catch (err) {
    errors.push('DISPATCH: ' + err.message);
    console.error('[aemo-proxy] DISPATCH error:', err.message);
  }

  if (rows.length === 0) {
    return {
      statusCode: 502,
      headers: respHeaders,
      body: JSON.stringify({ error: 'No data retrieved. ' + errors.join(' | ') })
    };
  }

  // Deduplicate by intervalDatetime, keep DISPATCH over P5 for same slot
  const seen = {};
  rows.forEach(function(r) {
    if (!seen[r.intervalDatetime] || r.source === 'DISPATCH') {
      seen[r.intervalDatetime] = r;
    }
  });

  const sorted = Object.values(seen).sort(function(a, b) {
    return a.intervalDatetime < b.intervalDatetime ? -1 : 1;
  });

  return { statusCode: 200, headers: respHeaders, body: JSON.stringify(sorted) };
};
