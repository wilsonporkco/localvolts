#!/usr/bin/env python3
"""
Localvolts → Supabase daily sync script.
Fetches up to 72 hours of interval data and upserts into Supabase.
Runs via GitHub Actions on a schedule, or manually.

Environment variables required:
  LV_API_KEY       Localvolts API key
  LV_PARTNER       Localvolts partner ID
  SUPABASE_URL     Your Supabase project URL (https://xxxx.supabase.co)
  SUPABASE_KEY     Your Supabase service_role key (not anon key)

Optional:
  LV_NMI           NMI to fetch (default: *)
  LV_HOURS_BACK    How many hours back to fetch (default: 26, max: 72)
"""

import os
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
LV_API_KEY   = os.environ["LV_API_KEY"]
LV_PARTNER   = os.environ["LV_PARTNER"]
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
LV_NMI       = os.environ.get("LV_NMI", "*")
HOURS_BACK   = int(os.environ.get("LV_HOURS_BACK", "26"))

LV_BASE = "https://api.localvolts.com/v1"

# ── Helpers ───────────────────────────────────────────────────────────────────
def lv_fetch(from_dt: datetime, to_dt: datetime) -> list:
    """Fetch a single 24hr chunk from Localvolts."""
    params = {
        "NMI": LV_NMI,
        "from": from_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to":   to_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    url = f"{LV_BASE}/customer/interval?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"apikey {LV_API_KEY}",
        "partner":       LV_PARTNER,
        "User-Agent":    "LocalvoltsSync/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def to_kwh(val, unit: str) -> float:
    if val is None or val == "N/A":
        return None
    n = float(val)
    u = (unit or "").lower().strip()
    if u == "wh":  return n / 1000
    if u == "mwh": return n * 1000
    return n  # kWh


def to_cents(val, unit: str) -> float:
    if val is None or val == "N/A":
        return None
    n = float(val)
    u = (unit or "").lower().strip()
    if u in ("$", "aud", "dollars"): return n * 100
    return n  # cents


def to_grams(val, unit: str) -> float:
    if val is None or val == "N/A":
        return None
    n = float(val)
    u = (unit or "").lower()
    if "kg" in u: return n * 1000
    return n  # grams


def safe_float(val) -> float:
    if val is None or val == "N/A": return None
    try: return float(val)
    except: return None


def transform(r: dict) -> dict:
    """Convert raw API record to database row."""
    return {
        "nmi":                  r.get("NMI"),
        "interval_end":         r.get("intervalEnd"),
        "interval_duration":    r.get("intervalDuration"),
        "imports_kwh":          to_kwh(r.get("importsAll"),  r.get("importsAllUnits")),
        "exports_kwh":          to_kwh(r.get("exportsAll"),  r.get("exportsAllUnits")),
        "demand_main_kw":       safe_float(r.get("demandMain")),
        "demand_interval":      bool(r.get("demandInterval")),
        "earnings_cents":       to_cents(r.get("earningsAll"),      r.get("earningsAllUnits")),
        "earnings_var_cents":   to_cents(r.get("earningsAllVar"),   r.get("earningsAllVarUnits")),
        "earnings_fixed_cents": to_cents(r.get("earningsAllFixed"), r.get("earningsAllFixedUnits")),
        "earnings_rate":        safe_float(r.get("earningsAllVarRate")),
        "earnings_flex_up":     safe_float(r.get("earningsFlexUp")),
        "earnings_flex_down":   safe_float(r.get("earningsFlexDown")),
        "costs_cents":          to_cents(r.get("costsAll"),     r.get("costsAllUnits")),
        "costs_var_cents":      to_cents(r.get("costsAllVar"),  r.get("costsAllVarUnits")),
        "costs_demand":         safe_float(r.get("costsDemandMain")),
        "costs_rate":           safe_float(r.get("costsAllVarRate")),
        "costs_flex_up":        safe_float(r.get("costsFlexUp")),
        "costs_flex_down":      safe_float(r.get("costsFlexDown")),
        "imports_emissions_g":  to_grams(r.get("importsAllEmissions"), r.get("importsAllEmissionsUnits")),
        "exports_emissions_g":  to_grams(r.get("exportsAllEmissions"), r.get("exportsAllEmissionsUnits")),
        "imports_zero_ee":      safe_float(r.get("importsAllZeroEE")),
        "exports_zero_ee":      safe_float(r.get("exportsAllZeroEE")),
        "quality":              r.get("quality"),
        "raw":                  json.dumps(r),
    }


def supabase_upsert(rows: list) -> dict:
    """Upsert rows into Supabase via REST API."""
    url = f"{SUPABASE_URL}/rest/v1/lv_intervals"
    payload = json.dumps(rows).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "apikey":          SUPABASE_KEY,
            "Authorization":   f"Bearer {SUPABASE_KEY}",
            "Content-Type":    "application/json",
            "Prefer":          "resolution=merge-duplicates,return=minimal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
            return {"status": resp.status, "body": body.decode()[:200]}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Supabase error {e.code}: {body[:300]}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    now = datetime.now(timezone.utc)
    print(f"[{now.isoformat()}] Starting sync — {HOURS_BACK}hrs back, NMI={LV_NMI}")

    # Fetch in 24hr chunks (API limit)
    all_rows = []
    chunks = max(1, (HOURS_BACK + 23) // 24)
    for i in range(chunks):
        chunk_to   = now - timedelta(hours=i * 24)
        chunk_from = chunk_to - timedelta(hours=24)
        print(f"  Fetching chunk {i+1}/{chunks}: {chunk_from.strftime('%Y-%m-%dT%H:%MZ')} → {chunk_to.strftime('%Y-%m-%dT%H:%MZ')}")
        try:
            raw = lv_fetch(chunk_from, chunk_to)
            # Only save actuals and expected (not pure forecasts)
            actual = [r for r in raw if r.get("quality") in ("Act", "Exp")]
            print(f"    Got {len(raw)} intervals, {len(actual)} actual/expected")
            all_rows.extend(actual)
        except Exception as e:
            print(f"    WARNING: chunk failed — {e}")

    if not all_rows:
        print("No rows to save. Exiting.")
        return

    # Transform and deduplicate
    transformed = [transform(r) for r in all_rows]
    # Remove rows with no interval_end or nmi
    transformed = [r for r in transformed if r["nmi"] and r["interval_end"]]
    print(f"  Upserting {len(transformed)} rows to Supabase...")

    # Upsert in batches of 500
    batch_size = 500
    for i in range(0, len(transformed), batch_size):
        batch = transformed[i:i+batch_size]
        result = supabase_upsert(batch)
        print(f"    Batch {i//batch_size + 1}: HTTP {result['status']}")

    print(f"  Done. {len(transformed)} rows saved.")


if __name__ == "__main__":
    main()
