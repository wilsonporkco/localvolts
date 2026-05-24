/**
 * price-alert.js — Netlify scheduled function
 * Runs every 30 minutes. Queries Supabase lv_intervals directly (same source
 * as the dashboard 24-hour forecast chart) for each configured NMI and sends
 * email via SMTP2GO when forecast cost < threshold.
 *
 * Required env vars:
 *   SMTP2GO_API_KEY       — your SMTP2GO API key
 *   ALERT_FROM_EMAIL      — verified sender, e.g. alerts@wilsonporkco.com.au
 *   SUPABASE_SERVICE_KEY  — from Supabase → Settings → API → service_role key
 *
 * Schedule: every 30 minutes (configured in netlify.toml)
 */

const SUPABASE_URL = 'https://zmljvelkbhzalrniebhz.supabase.co';

function sbHeaders() {
  var key = process.env.SUPABASE_SERVICE_KEY;
  return { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' };
}

async function sbGet(key) {
  var res  = await fetch(SUPABASE_URL + '/rest/v1/lv_config?key=eq.' + key + '&select=value', { headers: sbHeaders() });
  var rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0].value;
}

async function sbSet(key, value) {
  await fetch(SUPABASE_URL + '/rest/v1/lv_config', {
    method:  'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }, sbHeaders()),
    body:    JSON.stringify({ key: key, value: value })
  });
}

// Query lv_intervals for a given NMI over the next 24 hours
async function fetchForecast(nmi, now) {
  var fromTs = new Date(now).toISOString();
  var toTs   = new Date(now + 24 * 3600 * 1000).toISOString();

  // Supabase lv_intervals uses snake_case column names
  var url = SUPABASE_URL + '/rest/v1/lv_intervals' +
    '?select=nmi,interval_end,costs_rate' +
    '&nmi=eq.' + encodeURIComponent(nmi) +
    '&interval_end=gte.' + encodeURIComponent(fromTs) +
    '&interval_end=lt.'  + encodeURIComponent(toTs) +
    '&order=interval_end.asc' +
    '&limit=1000';

  var res  = await fetch(url, { headers: sbHeaders() });
  var data = await res.json();
  if (!Array.isArray(data)) {
    console.error('[price-alert] Supabase error for', nmi, ':', JSON.stringify(data));
    return [];
  }

  return data.map(function(r) {
    return {
      intervalEnd:     r.interval_end,
      costsAllVarRate: r.costs_rate
    };
  }).filter(function(r) { return r.intervalEnd; });
}

// Build a 24-hour price chart as a base64-encoded SVG image.
// Embedding as <img src="data:image/svg+xml;base64,..."> works in all email clients
// that strip inline SVG but still render images (Gmail, Outlook, Apple Mail, etc).
function buildPriceChart(data, threshold, winStartMs, winEndMs) {
  var pts = data.filter(function(r) {
    return r.costsAllVarRate != null && !isNaN(parseFloat(r.costsAllVarRate));
  });
  if (pts.length < 2) return '';

  var W = 452, H = 130;
  var padL = 36, padR = 10, padT = 14, padB = 28;
  var cW = W - padL - padR;
  var cH = H - padT - padB;

  var t0 = new Date(pts[0].intervalEnd).getTime();
  var t1 = new Date(pts[pts.length - 1].intervalEnd).getTime();
  var tRange = t1 - t0 || 1;

  var rates = pts.map(function(r) { return parseFloat(r.costsAllVarRate); });
  var yMin  = Math.min(0, Math.min.apply(null, rates));
  var yMax  = Math.max.apply(null, rates.concat([threshold * 1.2])) * 1.1;
  var yRange = yMax - yMin || 1;

  function xPx(ms) { return padL + (ms - t0) / tRange * cW; }
  function yPx(v)  { return padT + (1 - (v - yMin) / yRange) * cH; }

  // Price line + area fill
  var lineD = pts.map(function(r, i) {
    var x = xPx(new Date(r.intervalEnd).getTime()).toFixed(1);
    var y = yPx(parseFloat(r.costsAllVarRate)).toFixed(1);
    return (i === 0 ? 'M' : 'L') + x + ',' + y;
  }).join(' ');
  var areaD = lineD +
    ' L' + xPx(t1).toFixed(1) + ',' + (padT + cH).toFixed(1) +
    ' L' + padL + ',' + (padT + cH).toFixed(1) + ' Z';

  // Cheap window highlight
  var shadeRect = '';
  if (winStartMs && winEndMs) {
    var sx0 = Math.max(padL, xPx(winStartMs));
    var sx1 = Math.min(padL + cW, xPx(winEndMs));
    if (sx1 > sx0) {
      shadeRect = '<rect x="' + sx0.toFixed(1) + '" y="' + padT + '" width="' +
        (sx1 - sx0).toFixed(1) + '" height="' + cH + '" fill="#10b981" fill-opacity="0.18" rx="2"/>';
    }
  }

  // Threshold line
  var tyPx = yPx(threshold).toFixed(1);

  // Y axis ticks (4 evenly spaced)
  var rawStep  = (yMax - yMin) / 4;
  var mag      = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  var step     = Math.ceil(rawStep / mag) * mag || 5;
  var yStart   = Math.floor(yMin / step) * step;
  var yTicks   = [];
  for (var v = yStart; v <= yMax + step * 0.01; v += step) {
    if (v >= yMin - 0.01) yTicks.push(v);
  }

  // X axis labels every 6 hours AEST
  var xLabels    = [];
  var sixH       = 6 * 3600 * 1000;
  var aestOff    = 10 * 3600 * 1000;
  var firstLabel = Math.ceil((t0 + aestOff) / sixH) * sixH - aestOff;
  for (var lt = firstLabel; lt <= t1; lt += sixH) {
    var d  = new Date(lt + aestOff);
    var hr = d.getUTCHours();
    xLabels.push({ x: xPx(lt), label: String(hr).padStart(2, '0') + ':00' });
  }

  var svgStr = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">',
    '<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>',
    // Y grid lines
    yTicks.map(function(tv) {
      return '<line x1="' + padL + '" y1="' + yPx(tv).toFixed(1) + '" x2="' + (padL + cW) + '" y2="' + yPx(tv).toFixed(1) + '" stroke="#f1f5f9" stroke-width="1"/>';
    }).join(''),
    // Cheap window shade
    shadeRect,
    // Area under price line
    '<path d="' + areaD + '" fill="#0ea5e9" fill-opacity="0.07"/>',
    // Threshold dashed line
    '<line x1="' + padL + '" y1="' + tyPx + '" x2="' + (padL + cW) + '" y2="' + tyPx + '" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.8"/>',
    '<text x="' + (padL + cW - 2) + '" y="' + (parseFloat(tyPx) - 4) + '" fill="#ef4444" font-size="9" font-family="Arial,sans-serif" text-anchor="end">' + threshold + 'c limit</text>',
    // Price line
    '<path d="' + lineD + '" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
    // X baseline
    '<line x1="' + padL + '" y1="' + (padT + cH) + '" x2="' + (padL + cW) + '" y2="' + (padT + cH) + '" stroke="#e2e8f0" stroke-width="1"/>',
    // Y tick labels
    yTicks.map(function(tv) {
      return '<text x="' + (padL - 4) + '" y="' + (parseFloat(yPx(tv).toFixed(1)) + 3) + '" fill="#94a3b8" font-size="9" font-family="Arial,sans-serif" text-anchor="end">' + tv.toFixed(0) + 'c</text>';
    }).join(''),
    // X time labels
    xLabels.map(function(l) {
      return '<text x="' + l.x.toFixed(1) + '" y="' + (H - 6) + '" fill="#94a3b8" font-size="9" font-family="Arial,sans-serif" text-anchor="middle">' + l.label + '</text>';
    }).join(''),
    '</svg>'
  ].join('');

  // Encode as base64 image so it renders in all email clients (Gmail strips inline SVG)
  var b64 = Buffer.from(svgStr).toString('base64');
  return '<img src="data:image/svg+xml;base64,' + b64 + '" width="' + W + '" height="' + H + '" style="display:block;border-radius:8px;" alt="24-hour price forecast"/>';
}

exports.handler = async function (event, context) {
  const SMTP2GO_KEY = process.env.SMTP2GO_API_KEY;
  const FROM_EMAIL  = process.env.ALERT_FROM_EMAIL;

  if (!SMTP2GO_KEY) { console.error('[price-alert] SMTP2GO_API_KEY not set'); return { statusCode: 500, body: 'SMTP2GO_API_KEY not configured' }; }
  if (!FROM_EMAIL)  { console.error('[price-alert] ALERT_FROM_EMAIL not set');  return { statusCode: 500, body: 'ALERT_FROM_EMAIL not configured' }; }
  if (!process.env.SUPABASE_SERVICE_KEY) { console.error('[price-alert] SUPABASE_SERVICE_KEY not set'); return { statusCode: 500, body: 'SUPABASE_SERVICE_KEY not configured' }; }

  var config = await sbGet('alerts');
  if (!config || !Array.isArray(config.alerts) || !config.alerts.length) {
    console.log('[price-alert] No alerts configured');
    return { statusCode: 200, body: 'No alerts configured' };
  }

  var sentAlerts = (await sbGet('sent-alerts')) || {};
  const now = Date.now();
  Object.keys(sentAlerts).forEach(function(k) {
    if (sentAlerts[k] < now - 48 * 3600 * 1000) delete sentAlerts[k];
  });

  var results = [];

  for (var i = 0; i < config.alerts.length; i++) {
    var alert     = config.alerts[i];
    var nmi       = alert.nmi;
    var nmiName   = alert.nmiName || nmi;
    var emails    = alert.emails  || [];
    var threshold = typeof alert.threshold === 'number' ? alert.threshold : 5;

    if (!emails.length || !nmi) { console.log('[price-alert] Skipping incomplete rule for NMI:', nmi); continue; }

    try {
      console.log('[price-alert] Querying Supabase forecast for', nmi);
      var data = await fetchForecast(nmi, now);
      console.log('[price-alert] Got', data.length, 'intervals for', nmi);

      if (!data.length) { console.log('[price-alert] No forecast data for', nmi); continue; }

      var sample = data.slice(0, 3).map(function(r) { return r.costsAllVarRate; });
      console.log('[price-alert] Sample costs_rate for', nmi, ':', JSON.stringify(sample));

      var cheap = data.filter(function(r) {
        var rate = parseFloat(r.costsAllVarRate);
        return !isNaN(rate) && rate < threshold;
      });

      if (!cheap.length) {
        var minRate = Math.min.apply(null, data.map(function(r){ return parseFloat(r.costsAllVarRate) || 999; }));
        console.log('[price-alert] No cheap intervals for', nmi, '(threshold', threshold + 'c, min rate:', minRate.toFixed(2) + 'c)');
        continue;
      }

      // Find contiguous cheap windows
      var windows = [], wStart = null, wEnd = null, wMin = Infinity;
      for (var j = 0; j < cheap.length; j++) {
        var interval = cheap[j];
        var rate     = parseFloat(interval.costsAllVarRate);
        if (!wStart) {
          wStart = interval; wEnd = interval; wMin = rate;
        } else {
          var prevMs = new Date(wEnd.intervalEnd).getTime();
          var thisMs = new Date(interval.intervalEnd).getTime();
          if (thisMs - prevMs <= 35 * 60 * 1000) {
            wEnd = interval; if (rate < wMin) wMin = rate;
          } else {
            windows.push({ start: wStart, end: wEnd, minRate: wMin });
            wStart = interval; wEnd = interval; wMin = rate;
          }
        }
      }
      if (wStart) windows.push({ start: wStart, end: wEnd, minRate: wMin });

      for (var k = 0; k < windows.length; k++) {
        var win       = windows[k];
        var windowKey = nmi + '|' + win.start.intervalEnd;
        if (sentAlerts[windowKey]) { console.log('[price-alert] Already alerted for window', windowKey); continue; }

        var startMs = new Date(win.start.intervalEnd).getTime() - 30 * 60 * 1000;
        var endMs   = new Date(win.end.intervalEnd).getTime();
        var durMins = Math.round((endMs - startMs) / 60000);
        var hours   = Math.floor(durMins / 60);
        var mins    = durMins % 60;
        var durStr  = hours > 0 ? hours + 'h' + (mins > 0 ? ' ' + mins + 'm' : '') : mins + 'm';

        function fmtAEST(ms) {
          var d = new Date(ms + 10 * 3600 * 1000);
          return d.toISOString().replace('T', ' ').slice(0, 16) + ' AEST';
        }

        var chartSVG = buildPriceChart(data, threshold, startMs, endMs);

        var subject = '⚡ Cheap power alert: ' + nmiName + ' — ' + win.minRate.toFixed(1) + '¢/kWh for ' + durStr;

        var html = [
          '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:0 auto;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">',
          '  <div style="background:#0f172a;padding:28px 24px;text-align:center;">',
          '    <div style="font-size:11px;letter-spacing:0.18em;color:#38bdf8;text-transform:uppercase;margin-bottom:6px;">Energy Monitor</div>',
          '    <div style="font-size:24px;color:#fff;font-weight:600;">⚡ Cheap Power Window</div>',
          '  </div>',
          '  <div style="padding:24px;">',
          '    <p style="margin:0 0 18px;color:#334155;font-size:15px;">A cheap electricity window has been forecast for <strong>' + nmiName + '</strong>:</p>',

          // Stats row — two cards side by side with a clear gap
          '    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">',
          '      <tr>',
          '        <td width="48%" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;vertical-align:top;">',
          '          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Min price</div>',
          '          <div style="font-size:34px;font-weight:700;color:#10b981;line-height:1;">' + win.minRate.toFixed(1) + '<span style="font-size:16px;font-weight:400;color:#64748b;">¢/kWh</span></div>',
          '        </td>',
          '        <td width="4%"></td>',
          '        <td width="48%" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;vertical-align:top;">',
          '          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Duration</div>',
          '          <div style="font-size:34px;font-weight:700;color:#0ea5e9;line-height:1;">' + durStr + '</div>',
          '        </td>',
          '      </tr>',
          '    </table>',

          // 24-hour price chart
          chartSVG ? (
            '    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 14px 10px;margin-bottom:16px;">' +
            '      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;">24-hour price forecast · AEST <span style="color:#10b981;">█</span> cheap window &nbsp; <span style="color:#ef4444;">- -</span> your limit</div>' +
            chartSVG +
            '    </div>'
          ) : '',

          // Details
          '    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;font-size:13px;color:#475569;line-height:2;">',
          '      <div>🕐 <strong>Starts:</strong> ' + fmtAEST(startMs) + '</div>',
          '      <div>🕐 <strong>Ends:</strong> ' + fmtAEST(endMs) + '</div>',
          '      <div>📍 <strong>NMI:</strong> ' + nmi + '</div>',
          '      <div>🎯 <strong>Alert threshold:</strong> below ' + threshold + '¢/kWh</div>',
          '    </div>',
          '    <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;text-align:center;">Forecast only — actual prices may vary slightly.<br>Sent by your Localvolts Energy Monitor.</p>',
          '  </div>',
          '</div>'
        ].join('\n');

        var emailRes = await fetch('https://api.smtp2go.com/v3/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: SMTP2GO_KEY, to: emails, sender: FROM_EMAIL, subject: subject, html_body: html })
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

  await sbSet('sent-alerts', sentAlerts);

  var summary = 'Checked ' + config.alerts.length + ' NMI(s). ' +
                (results.length ? 'Sent ' + results.length + ' alert(s).' : 'No new alerts.');
  console.log('[price-alert]', summary);
  return { statusCode: 200, body: JSON.stringify({ summary: summary, results: results }) };
};
