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
// Override via env var:  SIGEN_BASE_URL
// MQTT broker override:  SIGEN_MQTT_HOST  (default: mqtt-aus.sigencloud.com)
//
// Rate limits: Sigenergy allows ~1 req/endpoint/5 min for third-party keys.
// The function caches the bearer token in memory for warm invocations.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const BASE      = process.env.SIGEN_BASE_URL  || 'https://api-aus.sigencloud.com';
const MQTT_HOST = process.env.SIGEN_MQTT_HOST || 'mqtt-aus.sigencloud.com';
const MQTT_PORT = parseInt(process.env.SIGEN_MQTT_PORT || '1883', 10);

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

async function sigenPut(token, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'PUT',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok && res.status === 429) throw new Error('Sigenergy rate limit hit — wait ~5 minutes and retry');
  return res.json();
}

// ── MQTT battery command ─────────────────────────────────────────────────────
// Sends a single battery command over MQTT and waits for a response (or times out).
// Returns a Promise<object> — resolves with { success: true } or rejects with an Error.
//
// commandPayload example:
//   { systemId, activeMode: 'charge', startTime: <unix_s>, duration: 30,
//     chargingPower: 25.0, chargePriorityType: 'GRID' }
//
// For mode changes (charge/discharge/self-consume) set activeMode to:
//   'charge'        — force grid charge (chargePriorityType: 'GRID' or 'SOLAR')
//   'discharge'     — force discharge to loads/grid
//   'selfConsume'   — return to normal self-consumption mode
function sendMqttBatteryCommand(token, commandPayload) {
  return new Promise((resolve, reject) => {
    let mqtt;
    try { mqtt = require('mqtt'); } catch (e) {
      return reject(new Error('mqtt package not available — add it to netlify/functions/package.json'));
    }

    const clientId = `sigen-proxy-${Date.now()}`;
    const client   = mqtt.connect({
      host:      MQTT_HOST,
      port:      MQTT_PORT,
      protocol:  'mqtt',
      clientId,
      username:  token,        // Bearer token used as MQTT username
      password:  '',
      clean:     true,
      connectTimeout: 10_000,
      reconnectPeriod: 0       // no auto-reconnect in a serverless context
    });

    const TIMEOUT_MS  = 15_000;
    const TOPIC_PUB   = 'openapi/instruction/command';
    const TOPIC_SUB   = `openapi/instruction/command/reply/${clientId}`;
    let   timer       = null;
    let   settled     = false;

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      if (err) reject(err);
      else     resolve(data || { success: true });
    };

    client.on('error',   (err) => finish(new Error(`MQTT connection error: ${err.message}`)));
    client.on('offline', ()    => finish(new Error('MQTT broker unreachable — check SIGEN_MQTT_HOST')));

    client.on('connect', () => {
      // Subscribe to reply topic first
      client.subscribe(TOPIC_SUB, { qos: 1 }, (err) => {
        if (err) return finish(new Error(`MQTT subscribe error: ${err.message}`));

        const message = JSON.stringify({
          accessToken: token,
          commands:    [commandPayload]
        });

        client.publish(TOPIC_PUB, message, { qos: 1 }, (err) => {
          if (err) return finish(new Error(`MQTT publish error: ${err.message}`));
          // Start timeout after publish
          timer = setTimeout(() => {
            // Timeout is non-fatal — the command may still have been accepted.
            // Resolve with a warning rather than hard-failing.
            finish(null, { success: true, warning: 'No MQTT reply received within timeout — command sent but acknowledgement not confirmed' });
          }, TIMEOUT_MS);
        });
      });
    });

    client.on('message', (topic, msg) => {
      if (topic !== TOPIC_SUB) return;
      try {
        const reply = JSON.parse(msg.toString());
        if (reply.code !== 0 && reply.code !== undefined) {
          finish(new Error(`Battery command rejected (code ${reply.code}): ${reply.msg || 'unknown'}`));
        } else {
          finish(null, { success: true, reply });
        }
      } catch (e) {
        finish(null, { success: true, rawReply: msg.toString() });
      }
    });
  });
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
      case 'getMode':
        // GET /openapi/instruction/{systemId}/settings
        // Returns: { data: { energyStorageOperationMode: 0|1|2|3 } }
        // Rate limit: once per 5 minutes per station
        if (!systemId) throw new Error('systemId required for action=getMode');
        result = await sigenGet(token, `/openapi/instruction/${systemId}/settings`, { systemId });
        break;

      case 'setMode': {
        // Uses REST battery command: POST /openapi/system/battery/command
        // Maps integer mode → activeMode string:
        //   0 = Max Self-Consumption → selfConsumption
        //   1 = Full Feed-in to Grid → selfConsumption-grid
        //   3 = Backup / Emergency   → idle
        if (!systemId) throw new Error('systemId required for action=setMode');
        if (mode === undefined || mode === null) throw new Error('mode required for action=setMode');
        const modeInt = parseInt(mode, 10);
        if (isNaN(modeInt)) throw new Error('mode must be a number (0–3)');

        const MODE_MAP = { 0: 'selfConsumption', 1: 'selfConsumption-grid', 3: 'idle' };
        const activeMode = MODE_MAP[modeInt];
        if (!activeMode) throw new Error(`Mode ${modeInt} is not supported via battery command`);

        const cmd = {
          systemId,
          activeMode,
          startTime: Math.floor(Date.now() / 1000),
          duration:  1440   // 24 hours — reapply via auto-rules or manual if needed sooner
        };

        console.log('[sigenergy] setMode → batteryCommand:', JSON.stringify(cmd));
        const body = { accessToken: token, commands: [cmd] };
        const res = await fetch(`${BASE}/openapi/system/battery/command`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body:    JSON.stringify(body)
        });
        if (res.status === 429) throw new Error('Sigenergy rate limit hit — wait and retry');
        const text = await res.text();
        console.log('[sigenergy] setMode response:', res.status, text.slice(0, 300));
        if (!text || !text.trim()) {
          result = res.ok ? { code: 0, data: { success: true } } : (() => { throw new Error(`Battery command failed (HTTP ${res.status})`); })();
        } else {
          result = JSON.parse(text);
          if (result.code !== 0 && result.code !== undefined) {
            throw new Error(`Battery command rejected (code ${result.code}): ${result.msg || 'unknown'}`);
          }
        }
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

      // ── MQTT battery command ─────────────────────────────────────────────
      case 'batteryCommand': {
        // Send a direct battery command over MQTT.
        // Required params: systemId
        // Optional params:
        //   activeMode          — charge | discharge | idle | selfConsumption | selfConsumption-grid (default: 'charge')
        //   duration            — minutes (default: 60)
        //   startTime           — unix seconds (default: now)
        //   chargingPower       — KW max charge/discharge power
        //   pvPower             — KW max PV charging power
        //   maxSellPower        — KW max export to grid
        //   maxPurchasePower    — KW max import from grid
        //   chargePriorityType  — PV | GRID  (only relevant for activeMode=charge)
        //   dischargePriorityType — PV | BATTERY  (only relevant for activeMode=discharge)
        if (!systemId) throw new Error('systemId required for action=batteryCommand');

        const activeMode = params.activeMode || 'charge';
        const duration   = parseInt(params.duration || '60', 10);   // minutes
        const startTime  = params.startTime ? parseInt(params.startTime, 10) : Math.floor(Date.now() / 1000);

        const cmd = {
          systemId,
          activeMode,
          startTime,
          duration
        };

        // Optional power limits — only include if explicitly supplied
        const optionalNumbers = ['chargingPower', 'pvPower', 'maxSellPower', 'maxPurchasePower'];
        for (const field of optionalNumbers) {
          if (params[field] !== undefined && params[field] !== null && params[field] !== '') {
            cmd[field] = parseFloat(params[field]);
          }
        }

        // Priority fields — only include when relevant to the active mode
        if (activeMode === 'charge' && params.chargePriorityType) {
          cmd.chargePriorityType = params.chargePriorityType;
        }
        if (activeMode === 'discharge' && params.dischargePriorityType) {
          cmd.dischargePriorityType = params.dischargePriorityType;
        }

        result = await sendMqttBatteryCommand(token, cmd);
        break;
      }

      default:
        return {
          statusCode: 400,
          headers:    CORS,
          body:       JSON.stringify({ error: `Unknown action: "${action}". Valid actions: systems, devices, summary, energyFlow, deviceRealtime, setMode, onboard, offboard, batteryCommand` })
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
