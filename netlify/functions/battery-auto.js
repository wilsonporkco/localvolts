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
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_ANON_KEY;
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

// MQTT battery command (duplicated from sigenergy.js so this function is self-contained)
function sendMqttCommand(token, commandPayload) {
  return new Promise((resolve, reject) => {
    let mqtt;
    try { mqtt = require('mqtt'); } catch (e) {
      return reject(new Error('mqtt package not installed in netlify/functions/package.json'));
    }

    const clientId = `sigen-auto-${Date.now()}`;
    const client   = mqtt.connect({
      host:            MQTT_HOST,
      port:            MQTT_PORT,
      protocol:        'mqtt',
      clientId,
      username:        token,
      password:        '',
      clean:           true,
      connectTimeout:  10_000,
      reconnectPeriod: 0
    });

    const TOPIC_PUB = 'openapi/instruction/command';
    const TOPIC_SUB = `openapi/instruction/command/reply/${clientId}`;
    let   timer     = null;
    let   settled   = false;

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      if (err) reject(err);
      else     resolve(data || { success: true });
    };

    client.on('error',   (err) => finish(new Error(`MQTT error: ${err.message}`)));
    client.on('offline', ()    => finish(new Error(`MQTT broker unreachable (${MQTT_HOST}:${MQTT_PORT})`)));

    client.on('connect', () => {
      client.subscribe(TOPIC_SUB, { qos: 1 }, (err) => {
        if (err) return finish(new Error(`MQTT subscribe: ${err.message}`));

        client.publish(TOPIC_PUB, JSON.stringify({
          accessToken: token,
          replyTopic:  TOPIC_SUB,
          commands:    [commandPayload]
        }), { qos: 1 }, (err) => {
          if (err) return finish(new Error(`MQTT publish: ${err.message}`));
          timer = setTimeout(() => {
            finish(null, { success: true, warning: 'No reply within timeout — command likely accepted' });
          }, 15_000);
        });
      });
    });

    client.on('message', (topic, msg) => {
      if (topic !== TOPIC_SUB) return;
      try {
        const reply = JSON.parse(msg.toString());
        if (reply.code !== 0 && reply.code !== undefined) {
          finish(new Error(`Command rejected (code ${reply.code}): ${reply.msg}`));
        } else {
          finish(null, { success: true, reply });
        }
      } catch {
        finish(null, { success: true, rawReply: msg.toString() });
      }
    });
  });
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
exports.handler = async () => {
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

    // 3 ── Get current SOC from Sigenergy
    const flowJson = await sigenGet(`/openapi/systems/${systemId}/energyFlow`, { systemId });
    if (flowJson.code !== 0) throw new Error(`energyFlow error (code ${flowJson.code}): ${flowJson.msg}`);

    let flow = flowJson.data;
    if (typeof flow === 'string') flow = JSON.parse(flow);
    const soc = parseFloat(flow.batterySoc ?? flow.soc ?? -1);

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

      const modeResult = await sigenPost(
        `/openapi/systems/${systemId}/ems/energyStorageOperationMode`,
        { systemId, energyStorageOperationMode: 1 }  // 1 = Full Feed-in
      );
      logEntry.cmdResult = modeResult;

    } else if (isCheap && !socTooHigh && !socTooLow) {
      // ── GRID CHARGE ──────────────────────────────────────────────────────
      logEntry.action = 'grid_charge';
      logEntry.reason = `Import ${importPrice.toFixed(2)} c/kWh ≤ threshold ${threshold} c/kWh, SOC ${soc.toFixed(1)}% < max ${maxSoc}%`;

      const token  = await getToken();
      const cmd    = {
        systemId,
        activeMode:        'charge',
        startTime:         Math.floor(Date.now() / 1000),
        duration:          10,
        chargePriorityType: 'GRID'
      };
      if (chargeKw) cmd.chargingPower = chargeKw;
      const cmdResult = await sendMqttCommand(token, cmd);
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

      const modeResult = await sigenPost(
        `/openapi/systems/${systemId}/ems/energyStorageOperationMode`,
        { systemId, energyStorageOperationMode: 0 }  // 0 = Max Self-Consumption
      );
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
