// ─────────────────────────────────────────────────────────────────────────────
// Netlify function: /.netlify/functions/sigenergy
// Sigenergy Cloud OpenAPI proxy — Localvolts Energy Dashboard
//
// Place this file at:  netlify/functions/sigenergy.js
//
// Credentials can be supplied two ways (function checks env vars first):
//   • Netlify env vars (preferred):  SIGEN_APP_KEY  /  SIGEN_APP_SECRET
//   • POST body params:              appKey         /  appSecret
//
// Region default: ANZ (Australia & New Zealand) — https://api-aus.sigencloud.com
// Override via env var: SIGEN_BASE_URL
//
// Rate limits: Sigenergy allows ~1 req/endpoint/5 min for third-party keys.
// The function caches the bearer token in memory for warm invocations.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const BASE = process.env.SIGEN_BASE_URL || 'https://api-aus.sigencloud.com';

// ── In-memory token cache (survives warm Netlify function instances) ──────────
let _cachedToken  = null;
let _tokenExpiry  = 0;   // Unix ms

async function getToken(appKey, appSecret) {
  // Return cached token if still valid with a 5-minute buffer
  if (_cachedToken && Date.now() < _tokenExpiry - 300_000) {
    return _cachedToken;
  }

  const keyB64 = Buffer.from(`${appKey}:${appSecret}`).toString('base64');
  const res    = await fetch(`${BASE}/openapi/auth/login/key`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ key: keyB64 })
  });

  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`Sigenergy auth failed (code ${json.code}): ${json.msg || 'unknown error'}`);
  }

  // API sometimes returns data as a JSON string
  let data = json.data;
  if (typeof data === 'string') data = JSON.parse(data);

  _cachedToken = data.accessToken;
  _tokenExpiry = Date.now() + ((data.expiresIn ?? 43199) * 1000);
  return _cachedToken;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function sigenGet(token, path, params = {}) {
  const qs  = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(`${BASE}${path}${qs}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok && res.status === 429) throw new Error('Sigenergy rate limit hit — wait ~5 minutes and retry');
  return res.json();
}

async function sigenPost(token, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok && res.status === 429) throw new Error('Sigenergy rate limit hit — wait ~5 minutes and retry');
  return res.json();
}

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Content-Type':                 'application/json',
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    // Accept both GET (query params) and POST (JSON body)
    let params = {};
    if (event.httpMethod === 'POST') {
      try { params = JSON.parse(event.body || '{}'); } catch { params = {}; }
    } else {
      params = event.queryStringParameters || {};
    }

    // Credentials: env vars take priority over request params
    const appKey    = process.env.SIGEN_APP_KEY    || params.appKey;
    const appSecret = process.env.SIGEN_APP_SECRET || params.appSecret;

    if (!appKey || !appSecret) {
      return {
        statusCode: 400,
        headers:    CORS,
        body:       JSON.stringify({ error: 'Sigenergy credentials missing — set SIGEN_APP_KEY / SIGEN_APP_SECRET in Netlify env vars, or pass appKey/appSecret in the request' })
      };
    }

    const { action, systemId, serialNumber, mode } = params;

    // Authenticate (cached)
    const token = await getToken(appKey, appSecret);

    let result;

    switch (action) {

      // ── Inventory ────────────────────────────────────────────────────────
      case 'systems':
        // GET /openapi/system  — list all onboarded systems on this account
        result = await sigenGet(token, '/openapi/system');
        break;

      case 'devices':
        // GET /openapi/system/{systemId}/devices
        if (!systemId) throw new Error('systemId required for action=devices');
        result = await sigenGet(token, `/openapi/system/${systemId}/devices`, { systemId });
        break;

      // ── Real-time data ───────────────────────────────────────────────────
      case 'summary':
        // GET /openapi/systems/{systemId}/summary
        // Returns: pvPower, gridPower, batteryPower, loadPower, batterySoc, operationMode, etc.
        if (!systemId) throw new Error('systemId required for action=summary');
        result = await sigenGet(token, `/openapi/systems/${systemId}/summary`, { systemId });
        break;

      case 'energyFlow':
        // GET /openapi/systems/{systemId}/energyFlow
        if (!systemId) throw new Error('systemId required for action=energyFlow');
        result = await sigenGet(token, `/openapi/systems/${systemId}/energyFlow`, { systemId });
        break;

      case 'deviceRealtime':
        // GET /openapi/systems/{systemId}/devices/{serialNumber}/realtimeInfo
        if (!systemId || !serialNumber) throw new Error('systemId and serialNumber required');
        result = await sigenGet(
          token,
          `/openapi/systems/${systemId}/devices/${serialNumber}/realtimeInfo`,
          { systemId, serialNumber }
        );
        break;

      // ── Control ──────────────────────────────────────────────────────────
      case 'setMode': {
        // Switch operating mode
        // mode values: 0 = Max Self-Consumption, 1 = Full Feed-in to Grid
        //              2 = Time of Use,          3 = Backup / Emergency
        if (!systemId) throw new Error('systemId required for action=setMode');
        if (mode === undefined || mode === null) throw new Error('mode required for action=setMode');
        const modeInt = parseInt(mode, 10);
        if (isNaN(modeInt)) throw new Error('mode must be a number (0–3)');

        // NOTE: If this returns a 404/error, the control endpoint URL may differ
        // for your API key type. Check developer.sigencloud.com for the correct path.
        result = await sigenPost(
          token,
          `/openapi/systems/${systemId}/ems/energyStorageOperationMode`,
          { systemId, energyStorageOperationMode: modeInt }
        );
        break;
      }

      case 'onboard':
        // POST /openapi/board/onboard — pair a system with this API key
        if (!systemId) throw new Error('systemId required for action=onboard');
        result = await sigenPost(token, '/openapi/board/onboard', [systemId]);
        break;

      case 'offboard':
        // POST /openapi/board/offboard — unpair a system from this API key
        if (!systemId) throw new Error('systemId required for action=offboard');
        result = await sigenPost(token, '/openapi/board/offboard', [systemId]);
        break;

      default:
        return {
          statusCode: 400,
          headers:    CORS,
          body:       JSON.stringify({ error: `Unknown action: "${action}". Valid: systems, devices, summary, energyFlow, deviceRealtime, setMode, onboard, offboard` })
        };
    }

    return {
      statusCode: 200,
      headers:    CORS,
      body:       JSON.stringify(result)
    };

  } catch (err) {
    console.error('[sigenergy]', err.message);
    // Invalidate cached token on auth errors so next call re-authenticates
    if (err.message && err.message.includes('auth failed')) {
      _cachedToken = null;
      _tokenExpiry = 0;
    }
    return {
      statusCode: 500,
      headers:    CORS,
      body:       JSON.stringify({ error: err.message })
    };
  }
};
