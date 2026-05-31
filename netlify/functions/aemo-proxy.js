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

  // Debug mode: return raw API response so we can inspect the structure
  const debug = (event.queryStringParameters || {}).debug === '1';
  if (debug) {
    return { statusCode: 200, headers: hdrs, body: JSON.stringify(raw, null, 2) };
  }

  // Parse response:
  // raw.data → INetworkTimeSeries[]
  //   .metric = "price"
  //   .results → ITimeSeriesResult[]
  //     .name = region code e.g. "QLD1"
  //     .data = [[datetime_string, value|null], ...]
  try {
    const series = (raw.data || []);
    const priceSeries = series.find(function(d) { return d.metric === 'price'; }) || series[0];

    if (!priceSeries) {
      throw new Error('No series in response. Top-level keys: ' + Object.keys(raw).join(','));
    }

    const results = priceSeries.results || [];
    // Find matching region result, or fall back to first
    const regionResult = results.find(function(r) {
      return r.name && r.name.toUpperCase() === region;
    }) || results[0];

    if (!regionResult || !Array.isArray(regionResult.data) || !regionResult.data.length) {
      throw new Error('No result data for ' + region + '. Available: ' + results.map(function(r){ return r.name; }).join(','));
    }

    // data is array of [datetime_string, value|null] tuples
    const result = regionResult.data.map(function(tuple) {
      const dt  = tuple[0];
      const val = tuple[1];
      if (val === null || val === undefined || !dt) return null;
      const v = parseFloat(val);
      if (isNaN(v)) return null;
      return {
        regionId:         region,
        intervalDatetime: dt.replace('T', ' ').slice(0, 19),
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

