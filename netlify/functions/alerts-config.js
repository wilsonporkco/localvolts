/**
 * alerts-config.js — Netlify Function
 * Stores alert rules in Supabase (lv_config table).
 *
 * Required env var:
 *   SUPABASE_SERVICE_KEY — from Supabase → Settings → API → service_role key
 *
 * GET  /.netlify/functions/alerts-config  → returns current config
 * POST /.netlify/functions/alerts-config  → saves config
 */

const SUPABASE_URL = 'https://zmljvelkbhzalrniebhz.supabase.co';
const CONFIG_KEY   = 'alerts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sbHeaders() {
  var key = process.env.SUPABASE_SERVICE_KEY;
  return {
    'apikey':        key,
    'Authorization': 'Bearer ' + key,
    'Content-Type':  'application/json'
  };
}

async function sbGet() {
  var res  = await fetch(SUPABASE_URL + '/rest/v1/lv_config?key=eq.' + CONFIG_KEY + '&select=value', {
    headers: sbHeaders()
  });
  var rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return { alerts: [] };
  return rows[0].value;
}

async function sbSet(value) {
  await fetch(SUPABASE_URL + '/rest/v1/lv_config', {
    method:  'POST',
    headers: Object.assign({ 'Prefer': 'resolution=merge-duplicates' }, sbHeaders()),
    body:    JSON.stringify({ key: CONFIG_KEY, value: value })
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (!process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not set' }) };
  }

  if (event.httpMethod === 'GET') {
    try {
      var config = await sbGet();
      return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(config) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: e.message };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      var body = JSON.parse(event.body || '{}');
      if (!Array.isArray(body.alerts)) {
        return { statusCode: 400, headers: CORS, body: 'alerts must be an array' };
      }
      await sbSet(body);
      return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: e.message };
    }
  }

  return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
};
