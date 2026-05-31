/**
 * aemo-proxy.js — Netlify function
 * Proxies AEMO 5-minute pre-dispatch regional prices from NEMWEB.
 * Avoids CORS issues and keeps the API call server-side.
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 *
 * Returns JSON array of { regionId, intervalDatetime, rrp, rrpCkwh, totalDemand }
 * RRP is in $/MWh — divide by 10 to get c/kWh.
 *
 * No env vars required — AEMO NEMWEB is a public API.
 * Tries two AEMO endpoints; Referer/Origin headers needed for the viz portal.
 */

'use strict';

// Primary: AEMO visualisations portal (requires browser-like headers)
const AEMO_PRIMARY = 'https://visualisations.nemweb.com.au/api/current/5MPD_REGIONSOLUTION';
// Fallback: AEMO apps API
const AEMO_FALLBACK = 'https://aemo.com.au/aemo/apps/api/report/5MPD_REGIONSOLUTION';

const BROWSER_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Cache-Control':   'no-cache',
  'Origin':          'https://visualisations.nemweb.com.au',
  'Referer':         'https://visualisations.nemweb.com.au/',
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

async function tryFetch(url, hdrs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: hdrs, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function parseRows(json, region) {
  // NEMWEB wraps data: { "5MPD_REGIONSOLUTION": [...] }  or  { "5MPD_RegionSolution": [...] }
  // Some endpoints wrap further: { "data": { "5MPD_REGIONSOLUTION": [...] } }
  let raw = json['5MPD_REGIONSOLUTION'] || json['5MPD_RegionSolution']
          || (json.data && (json.data['5MPD_REGIONSOLUTION'] || json.data['5MPD_RegionSolution']))
          || [];

  if (!Array.isArray(raw)) raw = [];

  return raw
    .filter(function(r) { return !region || r.REGIONID === region; })
    .map(function(r) {
      return {
        regionId:         r.REGIONID,
        intervalDatetime: r.INTERVAL_DATETIME,
        rrp:              parseFloat(r.RRP),
        rrpCkwh:          parseFloat(r.RRP) / 10,
        totalDemand:      parseFloat(r.TOTALDEMAND),
        availableGen:     parseFloat(r.AVAILABLEGENERATION)
      };
    })
    .sort(function(a, b) { return a.intervalDatetime > b.intervalDatetime ? 1 : -1; });
}

exports.handler = async (event) => {
  const respHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: respHeaders, body: '' };
  }

  const region = (event.queryStringParameters || {}).region || null;
  const errors = [];

  // --- Try primary URL ---
  try {
    const res = await tryFetch(AEMO_PRIMARY, BROWSER_HEADERS);
    if (res.ok) {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch(e) { throw new Error('Primary: non-JSON response (' + text.slice(0, 80) + ')'); }
      const rows = parseRows(json, region);
      if (rows.length > 0) {
        return { statusCode: 200, headers: respHeaders, body: JSON.stringify(rows) };
      }
      throw new Error('Primary: empty dataset for region ' + (region || 'ALL'));
    }
    errors.push('Primary HTTP ' + res.status);
  } catch (err) {
    errors.push('Primary: ' + err.message);
    console.error('[aemo-proxy primary]', err.message);
  }

  // --- Try fallback URL ---
  try {
    const res2 = await tryFetch(AEMO_FALLBACK, {
      'Accept': 'application/json',
      'Referer': 'https://aemo.com.au/',
      'User-Agent': BROWSER_HEADERS['User-Agent']
    });
    if (res2.ok) {
      const text2 = await res2.text();
      let json2;
      try { json2 = JSON.parse(text2); } catch(e) { throw new Error('Fallback: non-JSON response (' + text2.slice(0, 80) + ')'); }
      const rows2 = parseRows(json2, region);
      if (rows2.length > 0) {
        return { statusCode: 200, headers: respHeaders, body: JSON.stringify(rows2) };
      }
      throw new Error('Fallback: empty dataset');
    }
    errors.push('Fallback HTTP ' + res2.status);
  } catch (err2) {
    errors.push('Fallback: ' + err2.message);
    console.error('[aemo-proxy fallback]', err2.message);
  }

  return {
    statusCode: 502,
    headers: respHeaders,
    body: JSON.stringify({ error: 'AEMO data unavailable. ' + errors.join(' | ') })
  };
};
