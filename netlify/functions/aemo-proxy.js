/**
 * aemo-proxy.js — Netlify function
 *
 * Fetches 5-minute NEM spot prices via the OpenElectricity REST API.
 * Returns the last 2 hours of settled dispatch prices for a region.
 *
 * Requires env var: OPENELEC_API_KEY
 * Get a free key at: https://platform.openelectricity.org.au
 *
 * GET /.netlify/functions/aemo-proxy?region=QLD1
 * Returns JSON array: [{ regionId, intervalDatetime, rrp, rrpCkwh, source }]
 */

'use strict';

const API_BASE = 'https://api.openelectricity.org.au/v4';

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
    return {
      statusCode: 502,
      headers: hdrs,
      body: JSON.stringify({ error: 'OPENELEC_API_KEY not set — add it in Netlify environment variables' })
    };
  }

  const region = ((event.queryStringParameters || {}).region || 'QLD1').toUpperCase();

  // Fetch last 2 hours of 5-min price data
  const now       = new Date();
  const twoHrsAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const dateStart = twoHrsAgo.toISOString().slice(0, 19); // drop ms

  const url = `${API_BASE}/market/network/NEM`
    + `?metrics=price`
    + `&interval=5m`
    + `&network_region=${encodeURIComponent(region)}`
    + `&primary_grouping=network_region`
    + `&date_start=${encodeURIComponent(dateStart)}`;

  console.log('[aemo-proxy] GET', url);

  let raw;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    const res  = await fetch(url, {
      signal:  ctrl.signal,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept':        'application/json'
      }
    });
    clearTimeout(tid);
    raw = await res.json();
    if (!res.ok) {
      const msg = (raw && raw.error) ? JSON.stringify(raw.error) : 'HTTP ' + res.status;
      throw new Error(msg);
    }
  } catch (err) {
    console.error('[aemo-proxy] fetch error:', err.message);
    return {
      statusCode: 502,
      headers: hdrs,
      body: JSON.stringify({ error: err.message || 'OpenElectricity request failed' })
    };
  }

  // Parse response: data[] → each item has a history object with start, interval, data[]
  try {
    const items = (raw.data || []);
    const priceItem = items.find(function(d) {
      return d.metric === 'price' || d.data_type === 'price';
    }) || items[0];

    if (!priceItem || !priceItem.history) {
      throw new Error('No price data in response');
    }

    const history  = priceItem.history;
    const values   = history.data  || [];
    const start    = new Date(history.start);
    const intrvlMs = parseInterval(history.interval || '5m');

    const result = values.map(function(val, i) {
      if (val === null || val === undefined) return null;
      const dt = new Date(start.getTime() + i * intrvlMs);
      const v  = parseFloat(val);
      if (isNaN(v)) return null;
      return {
        regionId:         region,
        intervalDatetime: formatAEST(dt),
        rrp:              +v.toFixed(2),
        rrpCkwh:          +(v / 10).toFixed(3),
        source:           'actual'
      };
    }).filter(Boolean);

    if (!result.length) throw new Error('Empty price series for ' + region);

    console.log('[aemo-proxy] ' + region + ': ' + result.length + ' intervals');
    return { statusCode: 200, headers: hdrs, body: JSON.stringify(result) };

  } catch (err) {
    console.error('[aemo-proxy] parse error:', err.message);
    return {
      statusCode: 502,
      headers: hdrs,
      body: JSON.stringify({ error: 'Parse error: ' + err.message })
    };
  }
};

/* ── helpers ─────────────────────────────────────────────────────────── */
function parseInterval(s) {
  // e.g. "5m" → 300000 ms
  const m = s.match(/^(\d+)([mhd])$/i);
  if (!m) return 5 * 60 * 1000;
  const n = parseInt(m[1]);
  switch (m[2].toLowerCase()) {
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default:  return n * 60 * 1000;
  }
}

function formatAEST(date) {
  // Return datetime string in AEST (UTC+10), no timezone suffix
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().slice(0, 19).replace('T', ' ');
}
