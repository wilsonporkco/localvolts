const https = require("https");

const API_KEY = process.env.LV_API_KEY || "e3c7ea100a1e29e297bfe71b8aa6c2da";
const PARTNER = process.env.LV_PARTNER  || "140046";
const LV_BASE = "api.localvolts.com";

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const qs = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const url = `https://${LV_BASE}/v1/customer/interval${qs}`;
  console.log("Fetching:", url);
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: "GET",
      headers: {
        Authorization: `apikey ${API_KEY}`,
        partner:       PARTNER,
        "User-Agent":  "LocalvoltsDashboard/1.0",
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body,
        });
      });
    });
    req.on("error", (err) => {
      resolve({ statusCode: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: err.message }) });
    });
    req.end();
  });
};
