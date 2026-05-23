/**
 * price-alert.js — Netlify scheduled function
 * Runs every 30 minutes. Checks Localvolts forecast prices for each
 * configured NMI and sends email via SMTP2GO when cost < threshold.
 *
 * Required env vars (set in Netlify site → Environment variables):
 *   SMTP2GO_API_KEY    — your SMTP2GO API key
 *   ALERT_FROM_EMAIL   — verified sender in SMTP2GO, e.g. "alerts@yourdomain.com"
 *
 * Schedule: every 30 minutes (configured in netlify.toml)
 */

exports.handler = async function (event, context) {
  const SMTP2GO_KEY = process.env.SMTP2GO_API_KEY;
  const FROM_EMAIL  = process.env.ALERT_FROM_EMAIL;
  const SITE_URL    = (process.env.URL || '').replace(/\/$/, '');

  if (!SMTP2GO_KEY) {
    console.error('[price-alert] SMTP2GO_API_KEY not set — aborting');
    return { statusCode: 500, body: 'SMTP2GO_API_KEY not configured' };
  }
  if (!FROM_EMAIL) {
    console.error('[price-alert] ALERT_FROM_EMAIL not set — aborting');
    return { statusCode: 500, body: 'ALERT_FROM_EMAIL not configured' };
  }

  // ── Load alert config from LV_ALERTS_CONFIG env var ──────────────────────
  var config;
  try {
    config = JSON.parse(process.env.LV_ALERTS_CONFIG || '{"alerts":[]}');
  } catch (e) {
    config = null;
  }

  if (!config || !Array.isArray(config.alerts) || !config.alerts.length) {
    console.log('[price-alert] No alerts configured — nothing to do');
    return { statusCode: 200, body: 'No alerts configured' };
  }

  // ── Sent-alert deduplication (in-memory per invocation) ──────────────────
  // Note: since we no longer use Blobs, deduplication resets each run.
  // The window key check below still prevents multiple sends within one run.
  var sentAlerts = {};
  const now = Date.now();

  const results = [];

  // ── Process each alert rule ───────────────────────────────────────────────
  for (var i = 0; i < config.alerts.length; i++) {
    var alert = config.alerts[i];
    var nmi       = alert.nmi;
    var nmiName   = alert.nmiName || nmi;
    var emails    = alert.emails  || [];
    var threshold = typeof alert.threshold === 'number' ? alert.threshold : 5;
    var partner   = alert.partner;
    var apikey    = alert.apikey;

    if (!emails.length || !apikey || !partner || !nmi) {
      console.log('[price-alert] Skipping incomplete rule for NMI:', nmi);
      continue;
    }

    try {
      // Fetch next 24 hours of forecast intervals via our own proxy
      var fromTs = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      var toTs   = new Date(now + 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

      var params = new URLSearchParams({
        NMI:      nmi,
        from:     fromTs,
        to:       toTs,
        _partner: partner,
        _apikey:  apikey
      });

      var apiUrl = SITE_URL + '/.netlify/functions/proxy?' + params.toString();
      console.log('[price-alert] Fetching forecast for', nmi);

      var res  = await fetch(apiUrl);
      var body = await res.text();
      var data;
      try { data = JSON.parse(body); } catch (e) { throw new Error('Bad JSON from proxy: ' + body.slice(0, 120)); }
      if (!res.ok) throw new Error('Proxy error ' + res.status + ': ' + body.slice(0, 120));
      if (!Array.isArray(data) || !data.length) {
        console.log('[price-alert] No forecast data for', nmi);
        continue;
      }

      // Filter to intervals below the threshold
      var cheap = data.filter(function (r) {
        var rate = parseFloat(r.costsAllVarRate);
        return !isNaN(rate) && rate < threshold;
      });

      if (!cheap.length) {
        console.log('[price-alert] No cheap intervals for', nmi, '(threshold', threshold + 'c)');
        continue;
      }

      // ── Find contiguous cheap windows ─────────────────────────────────────
      var windows = [];
      var wStart  = null, wEnd = null, wMin = Infinity;

      for (var j = 0; j < cheap.length; j++) {
        var interval = cheap[j];
        var rate     = parseFloat(interval.costsAllVarRate);
        if (!wStart) {
          wStart = interval; wEnd = interval; wMin = rate;
        } else {
          var prevMs = new Date(wEnd.intervalEnd).getTime();
          var thisMs = new Date(interval.intervalEnd).getTime();
          if (thisMs - prevMs <= 35 * 60 * 1000) {   // contiguous (within 35 min)
            wEnd = interval;
            if (rate < wMin) wMin = rate;
          } else {
            windows.push({ start: wStart, end: wEnd, minRate: wMin });
            wStart = interval; wEnd = interval; wMin = rate;
          }
        }
      }
      if (wStart) windows.push({ start: wStart, end: wEnd, minRate: wMin });

      // ── Send an email for each new window ─────────────────────────────────
      for (var k = 0; k < windows.length; k++) {
        var win = windows[k];
        var windowKey = nmi + '|' + win.start.intervalEnd;
        if (sentAlerts[windowKey]) {
          console.log('[price-alert] Already alerted for window', windowKey);
          continue;
        }

        // Duration
        var startMs = new Date(win.start.intervalEnd).getTime() - 30 * 60 * 1000;
        var endMs   = new Date(win.end.intervalEnd).getTime();
        var durMins = Math.round((endMs - startMs) / 60000);
        var hours   = Math.floor(durMins / 60);
        var mins    = durMins % 60;
        var durStr  = hours > 0
          ? hours + 'h' + (mins > 0 ? ' ' + mins + 'm' : '')
          : mins + 'm';

        // AEST formatter (UTC+10)
        function fmtAEST(ms) {
          var d = new Date(ms + 10 * 3600 * 1000);
          return d.toISOString().replace('T', ' ').slice(0, 16) + ' AEST';
        }

        var subject = '⚡ Cheap power alert: ' + nmiName + ' — ' +
                      win.minRate.toFixed(1) + '¢/kWh for ' + durStr;

        var html = [
          '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:0 auto;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">',
          '  <div style="background:#0f172a;padding:28px 24px;text-align:center;">',
          '    <div style="font-size:11px;letter-spacing:0.18em;color:#38bdf8;text-transform:uppercase;margin-bottom:6px;">Energy Monitor</div>',
          '    <div style="font-size:24px;color:#fff;font-weight:600;">⚡ Cheap Power Window</div>',
          '  </div>',
          '  <div style="padding:24px;">',
          '    <p style="margin:0 0 18px;color:#334155;font-size:15px;">A cheap electricity window has been forecast for <strong>' + nmiName + '</strong>:</p>',
          '    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:16px;display:flex;gap:32px;">',
          '      <div>',
          '        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Min price</div>',
          '        <div style="font-size:32px;font-weight:700;color:#10b981;line-height:1;">' + win.minRate.toFixed(1) + '<span style="font-size:16px;font-weight:400;color:#64748b;">¢/kWh</span></div>',
          '      </div>',
          '      <div>',
          '        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Duration</div>',
          '        <div style="font-size:32px;font-weight:700;color:#0ea5e9;line-height:1;">' + durStr + '</div>',
          '      </div>',
          '    </div>',
          '    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;font-size:13px;color:#475569;line-height:2;">',
          '      <div>🕐 <strong>Starts:</strong> ' + fmtAEST(startMs) + '</div>',
          '      <div>🕐 <strong>Ends:</strong> ' + fmtAEST(endMs) + '</div>',
          '      <div>📍 <strong>NMI:</strong> ' + nmi + '</div>',
          '      <div>🎯 <strong>Alert threshold:</strong> below ' + threshold + '¢/kWh</div>',
          '    </div>',
          '    <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;text-align:center;">',
          '      Forecast only — actual prices may vary slightly.<br>Sent by your Localvolts Energy Monitor.',
          '    </p>',
          '  </div>',
          '</div>'
        ].join('\n');

        // Send via SMTP2GO API
        var emailRes = await fetch('https://api.smtp2go.com/v3/email/send', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key:   SMTP2GO_KEY,
            to:        emails,
            sender:    FROM_EMAIL,
            subject:   subject,
            html_body: html
          })
        });

        var emailBody = await emailRes.json();
        if (emailRes.ok && emailBody.data && emailBody.data.succeeded > 0) {
          sentAlerts[windowKey] = now;
          var msg = 'Sent alert for ' + nmi + ' — ' + win.minRate.toFixed(1) + 'c for ' + durStr + ' starting ' + fmtAEST(startMs);
          results.push(msg);
          console.log('[price-alert]', msg);
        } else {
          console.error('[price-alert] SMTP2GO error for', nmi, ':', JSON.stringify(emailBody));
        }
      }
    } catch (e) {
      console.error('[price-alert] Error processing NMI', nmi, ':', e.message);
    }
  }

  var summary = 'Checked ' + config.alerts.length + ' NMI(s). ' +
                (results.length ? 'Sent ' + results.length + ' alert(s).' : 'No new alerts.');
  console.log('[price-alert]', summary);
  return { statusCode: 200, body: JSON.stringify({ summary: summary, results: results }) };
};
