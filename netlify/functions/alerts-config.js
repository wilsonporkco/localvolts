/**
 * alerts-config.js — Netlify Function
 * Stores and retrieves price-alert configuration in Netlify Blobs.
 *
 * GET  /.netlify/functions/alerts-config        → returns current config JSON
 * POST /.netlify/functions/alerts-config        → saves config JSON (body)
 *
 * Config shape:
 * {
 *   alerts: [
 *     {
 *       nmi:       "3000000001",
 *       nmiName:   "Wilson Home",
 *       partner:   "140046",
 *       apikey:    "abc123...",
 *       threshold: 5,          // c/kWh — alert when forecast cost < this
 *       emails:    ["you@example.com", "other@example.com"]
 *     },
 *     ...
 *   ]
 * }
 */

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const store = getStore('lv-alerts');

  // ── GET: return current config ──────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      var config = await store.get('config', { type: 'json' });
      return {
        statusCode: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
        body: JSON.stringify(config || { alerts: [] })
      };
    } catch (e) {
      return {
        statusCode: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
        body: JSON.stringify({ alerts: [] })
      };
    }
  }

  // ── POST: save config ───────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      var body = JSON.parse(event.body || '{}');
      // Basic validation
      if (!Array.isArray(body.alerts)) {
        return { statusCode: 400, headers: CORS, body: 'alerts must be an array' };
      }
      await store.set('config', JSON.stringify(body));
      return {
        statusCode: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
        body: JSON.stringify({ ok: true, count: body.alerts.length })
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: e.message };
    }
  }

  return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
};
