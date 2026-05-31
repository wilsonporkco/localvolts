/**
 * trigger-backfill.js — Netlify function
 * Dispatches the backfill GitHub Actions workflow on demand.
 * Called from the dashboard Settings → "Backfill data" button.
 *
 * Required Netlify env var:
 *   GITHUB_TOKEN — a Personal Access Token with Actions: Read + Write scope
 *                  (repo scope also works)
 *
 * Optional:
 *   GITHUB_REPO  — owner/repo, defaults to "wilsonporkco/localvolts"
 *
 * POST body: { hours_back: 72 }   (optional, defaults to 72)
 */

'use strict';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO || 'wilsonporkco/localvolts';
const WORKFLOW_ID  = 'backfill.yml';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!GITHUB_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GITHUB_TOKEN env var not set' }) };
  }

  let hoursBack = 72;
  try {
    const body = JSON.parse(event.body || '{}');
    if (body.hours_back) hoursBack = parseInt(body.hours_back, 10) || 72;
  } catch (_) {}

  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: 'main', inputs: { hours_back: String(hoursBack) } })
    });

    if (res.status === 204) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: `Backfill triggered (${hoursBack}h). Data will appear within ~2 minutes.` }) };
    }

    const text = await res.text();
    return { statusCode: res.status, headers, body: JSON.stringify({ error: `GitHub API returned ${res.status}: ${text.slice(0, 200)}` }) };

  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
