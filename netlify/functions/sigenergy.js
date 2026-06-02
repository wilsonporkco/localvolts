// ─────────────────────────────────────────────────────────────────────────────
// Netlify function: /.netlify/functions/sigenergy
// Sigenergy Cloud OpenAPI proxy — Localvolts Energy Dashboard
//
// Developer API credentials (for data/read):
//   SIGEN_APP_KEY / SIGEN_APP_SECRET  (or pass in request body)
//
// Consumer API credentials (for mode control — uses mySigen app login):
//   SIGEN_USERNAME / SIGEN_PASSWORD
//
// Region default: ANZ — https://api-aus.sigencloud.com
// Consumer API base: https://api-apac.sigencloud.com (override: SIGEN_CONSUMER_BASE_URL)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto    = require('crypto');
const BASE      = process.env.SIGEN_BASE_URL          || 'https://api-aus.sigencloud.com';
const CBASE     = process.env.SIGEN_CONSUMER_BASE_URL || 'https://api-aus.sigencloud.com';
const MQTT_HOST = process.env.SIGEN_MQTT_HOST         || 'mqtt-aus.sigencloud.com';
const MQTT_PORT = parseInt(process.env.SIGEN_MQTT_PORT || '1883', 10);

// ── Consumer API: AES-CBC password encryption (key/IV = "sigensigensigenp") ──
function encryptSigenPassword(password) {
  const key    = Buffer.from('sigensigensigenp', 'utf8');
  const iv     = Buffer.from('sigensigensigenp', 'latin1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return cipher.update(password, 'utf8', 'base64') + cipher.final('base64');
}

// ── Consumer API token + stationId cache ─────────────────────────────────────
let _consumerToken     = null;
let _consumerExpiry    = 0;
let _consumerStationId = null;   // cached after first lookup

async function getConsumerToken(username, password) {
  if (_consumerToken && Date.now() < _consumerExpiry - 300_000) return _consumerToken;
  const encPwd = encryptSigenPassword(password);
  console.log('[sigenergy] consumer auth URL:', `${CBASE}/auth/oauth/token`, 'user:', username);
  const res = await fetch(`${CBASE}/auth/oauth/token`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from('sigen:sigen').toString('base64')
    },
    body: new URLSearchParams({ username, password: encPwd, grant_type: 'password' }).toString()
  });
  const json = await res.json();
  if (!json.data || !json.data.access_token) throw new Error(`Consumer auth failed: ${JSON.stringify(json)}`);
  _consumerToken  = json.data.access_token;
  _consumerExpiry = Date.now() + ((json.data.expires_in ?? 3600) * 1000);
  return _consumerToken;
}

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
function sendMqttBatteryCommand(token, commandPayload, appKey, appSecret) {
  return new Promise((resolve, reject) => {
    let mqtt;
    try { mqtt = require('mqtt'); } catch (e) {
      return reject(new Error('mqtt package not available — add it to netlify/functions/package.json'));
    }

    const clientId  = `sigen-proxy-${Date.now()}`;
    // mqtts (MQTT over TLS) on port 8883 — confirmed from Sigenergy subscription details
    const mqttPort  = parseInt(process.env.SIGEN_MQTT_PORT || '8883', 10);
    const brokerUrl = `mqtts://${MQTT_HOST}:${mqttPort}`;
    // Use appKey/appSecret as MQTT credentials (same as data subscription connection)
    const mqttUser  = appKey  || process.env.SIGEN_APP_KEY  || token;
    const mqttPass  = appSecret || process.env.SIGEN_APP_SECRET || '';
    console.log('[sigenergy] MQTT connecting:', brokerUrl, 'user:', mqttUser);
    const client    = mqtt.connect(brokerUrl, {
      clientId,
      username:  mqttUser,
      password:  mqttPass,
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

      case 'energyFlow': {
        // Consumer API: GET device/sigen/station/energyflow?id={stationId} (no rate limit)
        if (!systemId) throw new Error('systemId required for action=energyFlow');
        const efUser = process.env.SIGEN_USERNAME || params.sigenUsername;
        const efPass = process.env.SIGEN_PASSWORD || params.sigenPassword;
        if (efUser && efPass) {
          const efToken   = await getConsumerToken(efUser, efPass);
          const efStation = process.env.SIGEN_CONSUMER_STATION_ID || _consumerStationId;
          const efId      = efStation || systemId;
          const efRes     = await fetch(`${CBASE}/device/sigen/station/energyflow?id=${efId}`, {
            headers: { 'Authorization': `Bearer ${efToken}` }
          });
          const efJson    = await efRes.json();
          // Normalise consumer fields to match developer API field names the UI expects
          const d = efJson.data || efJson;
          result = { code: 0, data: {
            batterySoc:   d.batterySoc  ?? d.soc,
            batteryPower: d.batteryPower ?? d.storagePower,
            gridPower:    d.gridPower   ?? d.buySellPower,
            pvPower:      d.pvPower,
            loadPower:    d.loadPower   ?? d.acPower
          }};
        } else {
          // Fallback to developer API
          result = await sigenGet(token, `/openapi/systems/${systemId}/energyFlow`, { systemId });
        }
        break;
      }

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
      case 'getMode': {
        // Consumer API: GET device/energy-profile/mode/current/{stationId}
        // Uses mySigen username/password (SIGEN_USERNAME / SIGEN_PASSWORD env vars)
        if (!systemId) throw new Error('systemId required for action=getMode');
        const sigenUser = process.env.SIGEN_USERNAME || params.sigenUsername;
        const sigenPass = process.env.SIGEN_PASSWORD || params.sigenPassword;
        if (!sigenUser || !sigenPass) throw new Error('SIGEN_USERNAME / SIGEN_PASSWORD not set — needed for getMode');
        const cToken = await getConsumerToken(sigenUser, sigenPass);
        const gmRes  = await fetch(`${CBASE}/device/energy-profile/mode/current/${systemId}`, {
          headers: { 'Authorization': `Bearer ${cToken}` }
        });
        const gmJson = await gmRes.json();
        console.log('[sigenergy] getMode response:', JSON.stringify(gmJson));
        // Normalise: map consumer currentMode to energyStorageOperationMode for UI compatibility
        const CONSUMER_TO_UI = { 0: 0, 5: 1, 7: 3 };  // 0=self-use, 5=feed-in, 7=backup
        const currentMode = gmJson.data ? gmJson.data.currentMode : null;
        result = { code: 0, data: { energyStorageOperationMode: CONSUMER_TO_UI[currentMode] ?? currentMode } };
        break;
      }

      case 'setMode': {
        // Consumer API: PUT device/energy-profile/mode
        // Uses mySigen username/password — bypasses developer API access restrictions.
        // UI mode → consumer operationMode: 0→0 (self-use), 1→5 (feed-in), 3→7 (backup/EMS)
        if (!systemId) throw new Error('systemId required for action=setMode');
        if (mode === undefined || mode === null) throw new Error('mode required for action=setMode');
        const modeInt = parseInt(mode, 10);
        if (isNaN(modeInt)) throw new Error('mode must be a number (0, 1, or 3)');

        const UI_TO_CONSUMER = { 0: 0, 1: 5, 2: 1, 3: 7, 4: 2 };  // 2=Sigen AI, 4=TOU (consumer operationMode 2)
        const operationMode  = UI_TO_CONSUMER[modeInt];
        if (operationMode === undefined) throw new Error(`Mode ${modeInt} is not supported`);

        const sigenUser2 = process.env.SIGEN_USERNAME || params.sigenUsername;
        const sigenPass2 = process.env.SIGEN_PASSWORD || params.sigenPassword;
        if (!sigenUser2 || !sigenPass2) throw new Error('SIGEN_USERNAME / SIGEN_PASSWORD not set — needed for setMode');

        const cToken2 = await getConsumerToken(sigenUser2, sigenPass2);

        // Consumer stationId: use env var, in-memory cache, or fetch from API.
        let consumerStationId = process.env.SIGEN_CONSUMER_STATION_ID || _consumerStationId;
        if (!consumerStationId) {
          const stationRes  = await fetch(`${CBASE}/device/owner/station/home`, {
            headers: { 'Authorization': `Bearer ${cToken2}` }
          });
          const stationJson = await stationRes.json();
          consumerStationId = stationJson.data && stationJson.data.stationId;
          if (!consumerStationId) throw new Error('Could not get consumer stationId: ' + JSON.stringify(stationJson));
          _consumerStationId = consumerStationId;   // cache for subsequent calls
        }
        console.log('[sigenergy] consumerStationId:', consumerStationId);

        const smPayload = { stationId: consumerStationId, operationMode, profileId: -1 };
        console.log('[sigenergy] setMode consumer PUT:', JSON.stringify(smPayload));
        const smRes  = await fetch(`${CBASE}/device/energy-profile/mode`, {
          method:  'PUT',
          headers: { 'Authorization': `Bearer ${cToken2}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(smPayload)
        });
        const smJson = await smRes.json();
        console.log('[sigenergy] setMode response:', JSON.stringify(smJson));
        if (smJson.code !== 0 && smJson.code !== undefined) {
          throw new Error(`Set mode failed (code ${smJson.code}): ${smJson.msg || 'unknown'}`);
        }
        result = { code: 0, msg: 'success', data: smJson };
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
