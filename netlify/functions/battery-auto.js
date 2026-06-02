// ─────────────────────────────────────────────────────────────────────────────
// Netlify scheduled function: /.netlify/functions/battery-auto
// Runs every 5 minutes via netlify.toml cron schedule.
//
// Place this file at:  netlify/functions/battery-auto.js
//
// What it does:
//   1. Reads battery auto-rule settings from Supabase (key: batt_rules)
//   2. If auto-rule is disabled, exits immediately
//   3. Fetches current LocalVolts import price for the configured NMI
//   4. Fetches current battery SOC from Sigenergy energyFlow
//   5. Decides action:
//        • Price ≤ threshold AND SOC < maxSoc  → grid charge the battery
//        • SOC ≥ maxSoc                        → stop charging (return to self-consume)
//        • Price > threshold AND battery was grid-charging → return to self-consume
//   6. Writes a log entry to Supabase (key: batt_auto_log) for dashboard display
//
// Required Netlify env vars:
//   SIGEN_APP_KEY       — Sigenergy API key
//   SIGEN_APP_SECRET    — Sigenergy API secret
//   SUPABASE_URL        — your Supabase project URL
//   SUPABASE_ANON_KEY   — Supabase anon/service key
//   LV_PROXY_URL        — full URL of your LocalVolts proxy function
//                         e.g. https://your-site.netlify.app/.netlify/functions/proxy
//
// Optional:
//   SIGEN_BASE_URL      — override Sigenergy REST base (default: https://api-aus.sigencloud.com)
//   SIGEN_MQTT_HOST     — override MQTT broker host (default: mqtt-aus.sigencloud.com)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL     = process.env.SUPABASE_URL || 'https://zmljvelkbhzalrniebhz.supabase.co';
const SUPABASE_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
const SIGEN_APP_KEY    = process.env.SIGEN_APP_KEY;
const SIGEN_APP_SECRET = process.env.SIGEN_APP_SECRET;
const LV_PROXY_URL     = process.env.LV_PROXY_URL;     // LocalVolts proxy endpoint

// Internal URL of the sigenergy function (same Netlify site)
// Falls back to reading SIGEN_* vars directly if not set.
const SIGEN_PROXY_URL  = process.env.SIGEN_PROXY_URL   // e.g. https://your-site.netlify.app/.netlify/functions/sigenergy
                      || null;

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SB_TABLE  = 'lv_settings';
const SB_KEY_COL = 'key';
const SB_VAL_COL = 'value';

async function sbGet(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${SB_TABLE}?${SB_KEY_COL}=eq.${encodeURIComponent(key)}&select=${SB_VAL_COL}&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows || !rows.length) return null;
  const raw = rows[0][SB_VAL_COL];
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return raw; }
}

async function sbSet(key, value) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const body = JSON.stringify({ [SB_KEY_COL]: key, [SB_VAL_COL]: JSON.stringify(value) });
  await fetch(`${SUPABASE_URL}/rest/v1/${SB_TABLE}`, {
    method:  'POST',
    headers: {
      apikey:          SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      Prefer:          'resolution=merge-duplicates'
    },
    body
  });
}

// ── Sigenergy helpers ─────────────────────────────────────────────────────────
// These call sigenergy.js inline (shared code pattern) rather than over HTTP
// to avoid needing to know the site URL. We import the same logic directly.

const BASE      = process.env.SIGEN_BASE_URL  || 'https://api-aus.sigencloud.com';
const MQTT_HOST = process.env.SIGEN_MQTT_HOST || 'mqtt-aus.sigencloud.com';
const MQTT_PORT = parseInt(process.env.SIGEN_MQTT_PORT || '1883', 10);

let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 300_000) return _cachedToken;

  const keyB64 = Buffer.from(`${SIGEN_APP_KEY}:${SIGEN_APP_SECRET}`).toString('base64');
  const res    = await fetch(`${BASE}/openapi/auth/login/key`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ key: keyB64 })
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`Sigenergy auth failed (code ${json.code}): ${json.msg}`);

  let data = json.data;
  if (typeof data === 'string') data = JSON.parse(data);
  _cachedToken = data.accessToken;
  _tokenExpiry = Date.now() + ((data.expiresIn ?? 43199) * 1000);
  return _cachedToken;
}

async function sigenGet(path, params = {}) {
  const token = await getToken();
  const qs    = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  const res   = await fetch(`${BASE}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 429) throw new Error('Sigenergy rate limit hit');
  return res.json();
}

async function sigenPost(path, body) {
  const token = await getToken();
  const res   = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body)
  });
  if (res.status === 429) throw new Error('Sigenergy rate limit hit');
  return res.json();
}

// ── Consumer API (mySigen app credentials) ────────────────────────────────────
// Uses username/password with AES encryption — bypasses developer API restrictions.
const crypto           = require('crypto');
const CBASE            = process.env.SIGEN_CONSUMER_BASE_URL || 'https://api-aus.sigencloud.com';
const SIGEN_USERNAME   = process.env.SIGEN_USERNAME;
const SIGEN_PASSWORD   = process.env.SIGEN_PASSWORD;
const CONSUMER_STATION = process.env.SIGEN_CONSUMER_STATION_ID;  // numeric stationId

let _consumerToken     = null;
let _consumerExpiry    = 0;
let _consumerStationId = CONSUMER_STATION || null;

function encryptSigenPassword(password) {
  const key    = Buffer.from('sigensigensigenp', 'utf8');
  const iv     = Buffer.from('sigensigensigenp', 'latin1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return cipher.update(password, 'utf8', 'base64') + cipher.final('base64');
}

async function getConsumerToken() {
  if (_consumerToken && Date.now() < _consumerExpiry - 300_000) return _consumerToken;
  if (!SIGEN_USERNAME || !SIGEN_PASSWORD) throw new Error('SIGEN_USERNAME / SIGEN_PASSWORD not set');
  const encPwd = encryptSigenPassword(SIGEN_PASSWORD);
  const res = await fetch(`${CBASE}/auth/oauth/token`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from('sigen:sigen').toString('base64')
    },
    body: new URLSearchParams({ username: SIGEN_USERNAME, password: encPwd, grant_type: 'password' }).toString()
  });
  const json = await res.json();
  if (!json.data || !json.data.access_token) throw new Error(`Consumer auth failed: ${JSON.stringify(json)}`);
  _consumerToken  = json.data.access_token;
  _consumerExpiry = Date.now() + ((json.data.expires_in ?? 3600) * 1000);
  return _consumerToken;
}

async function getConsumerStationId(cToken) {
  if (_consumerStationId) return _consumerStationId;
  const res  = await fetch(`${CBASE}/device/owner/station/home`, {
    headers: { 'Authorization': `Bearer ${cToken}` }
  });
  const json = await res.json();
  const id   = json.data && json.data.stationId;
  if (!id) throw new Error('Could not get consumer stationId: ' + JSON.stringify(json));
  _consumerStationId = id;
  return id;
}

async function consumerSetMode(operationMode) {
  const cToken    = await getConsumerToken();
  const stationId = await getConsumerStationId(cToken);
  const res = await fetch(`${CBASE}/device/energy-profile/mode`, {
    method:  'PUT',
    headers: { 'Authorization': `Bearer ${cToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ stationId, operationMode, profileId: -1 })
  });
  const json = await res.json();
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`Set mode failed (code ${json.code}): ${json.msg || 'unknown'}`);
  }
  return json;
}

// ── LocalVolts price fetch ────────────────────────────────────────────────────
// Returns { importPrice, exportPrice } both in c/kWh
async function getLvPrices(nmi) {
  if (!LV_PROXY_URL) throw new Error('LV_PROXY_URL env var not set');
  const res  = await fetch(`${LV_PROXY_URL}?NMI=${encodeURIComponent(nmi)}`);
  if (!res.ok) throw new Error(`LocalVolts proxy returned ${res.status}`);
  const data = await res.json();
  const row  = (Array.isArray(data) ? data : []).find(r => r.NMI === nmi) || data[0];
  if (!row) throw new Error('No price data returned for NMI ' + nmi);
  return {
    importPrice: parseFloat(row.costsAllVarRate),
    exportPrice: parseFloat(row.earningsAllVarRate)
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Support both scheduled runs and manual HTTP triggers (POST from UI)
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, body: '' };
  const startTime = new Date().toISOString();
  const logEntry  = { ts: startTime, action: 'none', reason: '', error: null };

  try {
    // 1 ── Load rule settings from Supabase
    const rules = await sbGet('batt_rules');
    if (!rules || !rules.enabled) {
      logEntry.reason = 'Auto-rule disabled';
      await sbSet('batt_auto_log', logEntry);
      return { statusCode: 200 };
    }

    const threshold     = parseFloat(rules.threshold     ?? 5);    // c/kWh buy threshold
    const minSoc        = parseFloat(rules.minSoc        ?? 15);   // % discharge floor
    const maxSoc        = parseFloat(rules.maxSoc        ?? 90);   // % stop charging
    const sellThreshold = parseFloat(rules.sellThreshold ?? 20);   // c/kWh sell threshold
    const sellMinSoc    = parseFloat(rules.sellMinSoc    ?? 20);   // % min SOC before selling
    const sellStopSoc   = parseFloat(rules.sellStopSoc   ?? 20);   // % stop selling below this
    const chargeKw      = rules.chargeKw != null ? parseFloat(rules.chargeKw) : null;
    const sellKw        = rules.sellKw   != null ? parseFloat(rules.sellKw)   : null;

    // 2 ── Identify system + NMI
    // batt_rules may contain systemId and nmi saved from the UI
    const systemId = rules.systemId || null;
    const nmi      = rules.nmi      || null;

    if (!systemId) {
      logEntry.reason = 'No systemId in batt_rules — save settings from Battery panel first';
      logEntry.error  = 'missing_system_id';
      await sbSet('batt_auto_log', logEntry);
      return { statusCode: 200 };
    }

    if (!nmi) {
      logEntry.reason = 'No NMI mapped to this system — set it in Battery → Settings';
      logEntry.error  = 'missing_nmi';
      await sbSet('batt_auto_log', logEntry);
      return { statusCode: 200 };
    }

    // 3 ── Get current SOC via consumer API (avoids developer API access restrictions)
    const cTok      = await getConsumerToken();
    const cStation  = await getConsumerStationId(cTok);
    const flowRes   = await fetch(`${CBASE}/device/sigen/station/energyflow?id=${cStation}`, {
      headers: { 'Authorization': `Bearer ${cTok}` }
    });
    const flowText  = await flowRes.text();
    let flowJson;
    try { flowJson = JSON.parse(flowText); } catch(e) {
      throw new Error('energyFlow JSON parse error: ' + flowText.slice(0, 100));
    }
    let flow = flowJson.data || flowJson;
    if (typeof flow === 'string') flow = JSON.parse(flow);
    const soc = parseFloat(flow.batterySoc ?? flow.soc ?? flow.storageSoc ?? -1);

    logEntry.soc = soc;

    if (soc < 0) {
      logEntry.reason = 'Could not read SOC from energyFlow response';
      logEntry.error  = 'soc_unavailable';
      await sbSet('batt_auto_log', logEntry);
      return { statusCode: 200 };
    }

    // 4 ── Get current LocalVolts prices
    const { importPrice, exportPrice } = await getLvPrices(nmi);
    logEntry.price        = importPrice;
    logEntry.exportPrice  = exportPrice;
    logEntry.threshold    = threshold;
    logEntry.sellThreshold = sellThreshold;

    const isCheap    = importPrice <= threshold;
    const socTooHigh = soc >= maxSoc;
    const socTooLow  = soc <= minSoc;
    const canSell    = !isNaN(exportPrice) && exportPrice >= sellThreshold && soc > sellMinSoc;
    const sellFloor  = soc <= sellStopSoc;

    // 5 ── Decide action
    // Load previous action from log so we know the previous state
    const prevLog     = await sbGet('batt_auto_log') || {};
    const wasCharging = prevLog.action === 'grid_charge';
    const wasSelling  = prevLog.action === 'feed_in';

    if (canSell && !sellFloor) {
      // ── FEED-IN / SELL ────────────────────────────────────────────────────
      // Sell rule has priority — export price is above threshold and battery has enough charge
      logEntry.action = 'feed_in';
      logEntry.reason = `Export ${exportPrice.toFixed(2)} c/kWh ≥ sell threshold ${sellThreshold} c/kWh, SOC ${soc.toFixed(1)}% > floor ${sellMinSoc}%`;

      const modeResult = await consumerSetMode(5);  // 5 = Fully Fed to Grid
      logEntry.cmdResult = modeResult;

    } else if (isCheap && !socTooHigh && !socTooLow) {
      // ── GRID CHARGE ──────────────────────────────────────────────────────
      logEntry.action = 'grid_charge';
      logEntry.reason = `Import ${importPrice.toFixed(2)} c/kWh ≤ threshold ${threshold} c/kWh, SOC ${soc.toFixed(1)}% < max ${maxSoc}%`;

      // Grid charge: find the 'GridCharge' custom energy profile and activate it
      const cTok3       = await getConsumerToken();
      const cStation3   = await getConsumerStationId(cTok3);
      const modesRes    = await fetch(`${CBASE}/device/energy-profile/mode/all/${cStation3}`, {
        headers: { 'Authorization': `Bearer ${cTok3}` }
      });
      const modesJson   = await modesRes.json();
      const profiles    = (modesJson.data && modesJson.data.energyProfileItems) || [];
      const gcProfile   = profiles.find(function(p) {
        return p.name && p.name.toLowerCase().replace(/\s/g,'') === 'gridcharge';
      });
      let cmdResult;
      if (gcProfile) {
        // Activate GridCharge custom profile (operationMode 9 = custom, profileId from app)
        cmdResult = await fetch(`${CBASE}/device/energy-profile/mode`, {
          method:  'PUT',
          headers: { 'Authorization': `Bearer ${cTok3}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ stationId: cStation3, operationMode: 9, profileId: gcProfile.profileId })
        }).then(function(r){ return r.json(); });
        logEntry.profileId = gcProfile.profileId;
      } else {
        // Fallback: TOU mode
        cmdResult = await consumerSetMode(2);
        logEntry.reason += ' (GridCharge profile not found — used TOU fallback)';
      }
      logEntry.cmdResult = cmdResult;

    } else if ((wasCharging || wasSelling) && (!isCheap || socTooHigh) && (!canSell || sellFloor)) {
      // ── RETURN TO SELF-CONSUMPTION ───────────────────────────────────────
      logEntry.action = 'self_consume';
      if (socTooHigh) {
        logEntry.reason = `SOC ${soc.toFixed(1)}% reached max ${maxSoc}% — stopping grid charge`;
      } else if (sellFloor) {
        logEntry.reason = `SOC ${soc.toFixed(1)}% dropped to sell floor ${sellStopSoc}% — stopping feed-in`;
      } else {
        logEntry.reason = `Conditions no longer met — returning to self-consumption`;
      }

      const modeResult = await consumerSetMode(0);  // 0 = Maximum Self-Powered
      logEntry.cmdResult = modeResult;

    } else {
      // ── NO ACTION ────────────────────────────────────────────────────────
      logEntry.action = 'none';
      if (socTooHigh) {
        logEntry.reason = `SOC ${soc.toFixed(1)}% at/above max ${maxSoc}% — no action needed`;
      } else if (!isCheap) {
        logEntry.reason = `Price ${importPrice.toFixed(2)} c/kWh > threshold ${threshold} c/kWh — not charging`;
      } else {
        logEntry.reason = `No action required`;
      }
    }

  } catch (err) {
    logEntry.action = 'error';
    logEntry.error  = err.message;
    console.error('[battery-auto]', err.message);
  }

  // 6 ── Write log to Supabase (also keeps last-run visible in dashboard)
  await sbSet('batt_auto_log', logEntry);

  return { statusCode: 200 };
};
