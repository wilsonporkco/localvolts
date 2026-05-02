#!/usr/bin/env python3
"""
Localvolts → Supabase sync script.

The Localvolts API default (no from/to) returns:
  - Current NEM interval
  - All intervals up to 24hrs ahead (forecasts)
  - These update every 5 minutes

Strategy: fetch without date params every 30-60 minutes.
As time passes, forecast intervals become actuals and get updated.
Upsert handles duplicates so re-fetching is safe.

For historical backfill, the API supports from/to but:
  - Max 24hr window
  - Max 72hrs in the past from NOW (not from 'to')
  - 'to' must be <= now (cannot be in future for historical calls)
"""

import os
import json
import urllib.request
from datetime import datetime, timezone, timedelta

LV_API_KEY   = os.environ["LV_API_KEY"]
LV_PARTNER   = os.environ["LV_PARTNER"]
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
LV_NMI       = os.environ.get("LV_NMI", "*")
HOURS_BACK   = int(os.environ.get("LV_HOURS_BACK", "0"))  # 0 = default fetch (current + 24hr forecast)

LV_BASE = "https://api.localvolts.com/v1"

def lv_fetch(from_dt=None, to_dt=None):
    qs = f"NMI={LV_NMI}"
    if from_dt:
        qs += f"&from={from_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    if to_dt:
        qs += f"&to={to_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    url = f"{LV_BASE}/customer/interval?{qs}"
    print(f"    Fetching: {url}")
    req = urllib.request.Request(url, headers={
        "Authorization": f"apikey {LV_API_KEY}",
        "partner":       LV_PARTNER,
        "User-Agent":    "LocalvoltsSync/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def to_kwh(val, unit):
    if val is None or val == "N/A": return None
    n = float(val)
    u = (unit or "").lower().strip()
    if u == "wh":  return n / 1000
    if u == "mwh": return n * 1000
    return n

def to_cents(val, unit):
    if val is None or val == "N/A": return None
    n = float(val)
    u = (unit or "").lower().strip()
    if u in ("$", "aud", "dollars"): return n * 100
    return n

def to_grams(val, unit):
    if val is None or val == "N/A": return None
    n = float(val)
    u = (unit or "").lower()
    if "kg" in u: return n * 1000
    return n

def safe_float(val):
    if val is None or val == "N/A": return None
    try: return float(val)
    except: return None

def transform(r):
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

def supabase_upsert(rows):
    url = f"{SUPABASE_URL}/rest/v1/lv_intervals"
    payload = json.dumps(rows).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates,return=minimal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return {"status": resp.status}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Supabase error {e.code}: {body[:300]}")

def main():
    now = datetime.now(timezone.utc)
    print(f"[{now.isoformat()}] Starting sync, NMI={LV_NMI}, HOURS_BACK={HOURS_BACK}")

    all_rows = []

    if HOURS_BACK == 0:
        # Default: fetch current interval + 24hr forecast (no date params)
        print("  Mode: default fetch (current + 24hr forecast)")
        try:
            raw = lv_fetch()
            if raw and isinstance(raw[0], dict) and 'error' in raw[0]:
                print(f"  API error: {raw[0]['error']}")
                return
            valid = [r for r in raw if r.get("NMI") and r.get("intervalEnd")]
            print(f"  Got {len(raw)} intervals, {len(valid)} valid")
            if valid:
                print(f"  Quality breakdown: Act={sum(1 for r in valid if r.get('quality')=='Act')} Exp={sum(1 for r in valid if r.get('quality')=='Exp')} Fcst={sum(1 for r in valid if r.get('quality')=='Fcst')}")
            all_rows.extend(valid)
        except Exception as e:
            print(f"  ERROR: {e}")
            return
    else:
        # Historical: fetch in 24hr chunks, each chunk ending at most at now
        # from must be >= now - 72hrs
        max_back = min(HOURS_BACK, 72)
        oldest_from = now - timedelta(hours=max_back)
        chunks = max(1, (max_back + 23) // 24)
        print(f"  Mode: historical, {max_back}hrs back in {chunks} chunks")

        for i in range(chunks):
            chunk_from = oldest_from + timedelta(hours=i * 24)
            chunk_to   = chunk_from + timedelta(hours=24)
            # Cap to at now - 5min to avoid future data rejection
            chunk_to = min(chunk_to, now - timedelta(minutes=5))
            if chunk_from >= now:
                break

            print(f"  Chunk {i+1}/{chunks}: {chunk_from.strftime('%Y-%m-%dT%H:%MZ')} → {chunk_to.strftime('%Y-%m-%dT%H:%MZ')}")
            try:
                raw = lv_fetch(chunk_from, chunk_to)
                if raw and isinstance(raw[0], dict) and 'error' in raw[0]:
                    print(f"    API error: {raw[0]['error']}")
                    continue
                valid = [r for r in raw if r.get("NMI") and r.get("intervalEnd")]
                print(f"    Got {len(raw)} intervals, {len(valid)} valid")
                if valid:
                    r = valid[0]
                    print(f"    Sample: NMI={r.get('NMI')} end={r.get('intervalEnd')} quality={r.get('quality')}")
                all_rows.extend(valid)
            except Exception as e:
                print(f"    ERROR: {e}")

    if not all_rows:
        print("No rows to save. Exiting.")
        return

    transformed = [transform(r) for r in all_rows]
    print(f"  Upserting {len(transformed)} rows to Supabase...")
    batch_size = 500
    for i in range(0, len(transformed), batch_size):
        result = supabase_upsert(transformed[i:i+batch_size])
        print(f"    Batch {i//batch_size + 1}: HTTP {result['status']}")
    print(f"  Done. {len(transformed)} rows saved.")

if __name__ == "__main__":
    main()
