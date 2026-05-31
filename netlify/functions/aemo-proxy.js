/**
 * aemo-proxy.js — Netlify function
 * Proxies AEMO 5-minute pre-dispatch regional prices from NEMWEB.
 * Avoids CORS issues and keeps the API call server-side.
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 *
 * Returns JSON array of { regionId, intervalDatetime, rrp, totalDemand }
 * RRP is in $/MWh — divide by 10 to get c/kWh.
 *
 * No env vars required — AEMO NEMWEB is a public API.
 */

'use strict';

const AEMO_URL = 'https://visualisations.nemweb.com.au/api/current/5MPD_REGIONSOLUTION';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const region = (event.queryStringParameters || {}).region || null;

  try {
    const res = await fetch(AEMO_URL, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'LocalvoltsDashboard/1.0'
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `AEMO API returned ${res.status}` }) };
    }

    const json = await res.json();

    // NEMWEB returns { "5MPD_REGIONSOLUTION": [ {...}, ... ] }
    // Each row: REGIONID, INTERVAL_DATETIME, RRP, TOTALDEMAND, AVAILABLEGENERATION, ...
    const rows = json['5MPD_REGIONSOLUTION'] || json['5MPD_RegionSolution'] || [];

    const filtered = rows
      .filter(function(r) { return !region || r.REGIONID === region; })
      .map(function(r) {
        return {
          regionId:          r.REGIONID,
          intervalDatetime:  r.INTERVAL_DATETIME,
          rrp:               parseFloat(r.RRP),           // $/MWh
          rrpCkwh:           parseFloat(r.RRP) / 10,      // c/kWh
          totalDemand:       parseFloat(r.TOTALDEMAND),
          availableGen:      parseFloat(r.AVAILABLEGENERATION)
        };
      })
      .sort(function(a, b) { return a.intervalDatetime > b.intervalDatetime ? 1 : -1; });

    return { statusCode: 200, headers, body: JSON.stringify(filtered) };

  } catch (err) {
    console.error('[aemo-proxy]', err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
