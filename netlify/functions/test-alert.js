/**
 * test-alert.js — Netlify Function
 * POST /.netlify/functions/test-alert
 *
 * Body: { emails: ["you@example.com"], nmi: "QB00014931", nmiName: "Wilson Home" }
 *
 * Sends a test email via SMTP2GO to confirm everything is wired up correctly.
 * Uses the same SMTP2GO_API_KEY and ALERT_FROM_EMAIL env vars as price-alert.js.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  const SMTP2GO_KEY = process.env.SMTP2GO_API_KEY;
  const FROM_EMAIL  = process.env.ALERT_FROM_EMAIL;

  if (!SMTP2GO_KEY) return { statusCode: 500, headers: CORS, body: 'SMTP2GO_API_KEY not configured' };
  if (!FROM_EMAIL)  return { statusCode: 500, headers: CORS, body: 'ALERT_FROM_EMAIL not configured' };

  var body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { body = {}; }

  var emails  = Array.isArray(body.emails) ? body.emails : [];
  var nmi     = body.nmi     || '—';
  var nmiName = body.nmiName || nmi;

  if (!emails.length) {
    return { statusCode: 400, headers: CORS, body: 'No email addresses provided' };
  }

  var html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:0 auto;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">',
    '  <div style="background:#0f172a;padding:28px 24px;text-align:center;">',
    '    <div style="font-size:11px;letter-spacing:0.18em;color:#38bdf8;text-transform:uppercase;margin-bottom:6px;">Energy Monitor</div>',
    '    <div style="font-size:24px;color:#fff;font-weight:600;">✅ Test Alert</div>',
    '  </div>',
    '  <div style="padding:24px;">',
    '    <p style="margin:0 0 18px;color:#334155;font-size:15px;">',
    '      Your price alert is working correctly for <strong>' + nmiName + '</strong>.',
    '    </p>',
    '    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;font-size:13px;color:#475569;line-height:2;">',
    '      <div>📍 <strong>NMI:</strong> ' + nmi + '</div>',
    '      <div>📧 <strong>Recipients:</strong> ' + emails.join(', ') + '</div>',
    '      <div>🕐 <strong>Sent:</strong> ' + new Date().toISOString() + '</div>',
    '    </div>',
    '    <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;text-align:center;">',
    '      When cheap electricity is forecast, a real alert will look similar to this.<br>',
    '      Sent by your Localvolts Energy Monitor.',
    '    </p>',
    '  </div>',
    '</div>'
  ].join('\n');

  try {
    var res = await fetch('https://api.smtp2go.com/v3/email/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:   SMTP2GO_KEY,
        to:        emails,
        sender:    FROM_EMAIL,
        subject:   '✅ Test alert: ' + nmiName + ' — email alerts are working',
        html_body: html
      })
    });
    var data = await res.json();
    if (res.ok && data.data && data.data.succeeded > 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } else {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, detail: data }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: e.message };
  }
};
