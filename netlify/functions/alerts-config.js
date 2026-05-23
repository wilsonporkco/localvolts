/**
 * alerts-config.js — Netlify Function
 * GET  → returns the current alert config from the LV_ALERTS_CONFIG env var
 * POST → not used (config is saved manually as an env var in Netlify)
 *
 * To update your alert rules:
 *   1. Click "Save & sync alerts" in the dashboard — it shows you the JSON
 *   2. Copy that JSON
 *   3. In Netlify → Site configuration → Environment variables, set LV_ALERTS_CONFIG to that JSON
 *   4. Trigger a redeploy (Deploys → Trigger deploy → Deploy site)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod === 'GET') {
    var raw = process.env.LV_ALERTS_CONFIG || '{"alerts":[]}';
    var config;
    try { config = JSON.parse(raw); } catch (e) { config = { alerts: [] }; }
    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
      body: JSON.stringify(config)
    };
  }

  return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
};
