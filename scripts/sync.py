#!/usr/bin/env python3
"""
Localvolts → Supabase sync script.

Two modes:
  HOURS_BACK=0  : Default fetch (6hr lookback + 24hr forecast). Run every 30 mins.
  HOURS_BACK=N  : Historical backfill — loops day by day using AEST boundaries.

Only 5-minute intervals are saved — 30-min intervals overlap with 5-min data
and cause double-counting in the dashboard.
"""

import os, json, urllib.request, urllib.parse, time
from datetime import datetime, timezone, timedelta

LV_API_KEY   = os.environ["LV_API_KEY"]
LV_PARTNER   = os.environ["LV_PARTNER"]
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
LV_NMI       = os.environ.get("LV_NMI", "*")
HOURS_BACK   = int(os.environ.get("LV_HOURS_BACK", "0"))

LV_BASE = "https://api.localvolts.com/v1"

def lv_fetch(from_dt=None, to_dt=None):
    # Build query string manually — urllib encodes colons which breaks the API
    qs = f"NMI={urllib.parse.quote(LV_NMI)}"
    if from_dt: qs += f"&from={from_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    if to_dt:   qs += f"&to={to_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    url = f"{LV_BASE}/customer/interval?{qs}"
    print(f"    GET {url}")
    req = urllib.request.Request(url, headers={
        "Authorization": f"apikey {LV_API_KEY}",
        "partner": LV_PARTNER,
        "User-Agent": "LocalvoltsSync/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def to_kwh(val, unit):
    if val is None or val == "N/A": return None
    n = float(val); u = (unit or "").lower().strip()
    if u == "wh": return n / 1000
    if u == "mwh": return n * 1000
    return n

def to_cents(val, unit):
    if val is None or val == "N/A": return None
    n = float(val); u = (unit or "").lower().strip()
    if u in ("$", "aud", "dollars"): return n * 100
    return n

def to_grams(val, unit):
    if val is None or val == "N/A": return None
    n = float(val); u = (unit or "").lower()
    if "kg" in u: return n * 1000
    return n

def safe_float(val):
    if val is None or val == "N/A": return None
    try: return float(val)
    except: return None

def transform(r):
    return {
        "nmi": r.get("NMI"),
        "interval_end": r.get("intervalEnd"),
        "interval_duration": r.get("intervalDuration"),
        "imports_kwh": to_kwh(r.get("importsAll"), r.get("importsAllUnits")),
        "exports_kwh": to_kwh(r.get("exportsAll"), r.get("exportsAllUnits")),
        "demand_main_kw": safe_float(r.get("demandMain")),
        "demand_interval": bool(r.get("demandInterval")),
        "earnings_cents": to_cents(r.get("earningsAll"), r.get("earningsAllUnits")),
        "earnings_var_cents": to_cents(r.get("earningsAllVar"), r.get("earningsAllVarUnits")),
        "earnings_fixed_cents": to_cents(r.get("earningsAllFixed"), r.get("earningsAllFixedUnits")),
        "earnings_rate": safe_float(r.get("earningsAllVarRate")),
        "earnings_flex_up": safe_float(r.get("earningsFlexUp")),
        "earnings_flex_down": safe_float(r.get("earningsFlexDown")),
        "costs_cents": to_cents(r.get("costsAll"), r.get("costsAllUnits")),
        "costs_var_cents": to_cents(r.get("costsAllVar"), r.get("costsAllVarUnits")),
        "costs_demand": safe_float(r.get("costsDemandMain")),
        "costs_rate": safe_float(r.get("costsAllVarRate")),
        "costs_flex_up": safe_float(r.get("costsFlexUp")),
        "costs_flex_down": safe_float(r.get("costsFlexDown")),
        "imports_emissions_g": to_grams(r.get("importsAllEmissions"), r.get("importsAllEmissionsUnits")),
        "exports_emissions_g": to_grams(r.get("exportsAllEmissions"), r.get("exportsAllEmissionsUnits")),
        "imports_zero_ee": safe_float(r.get("importsAllZeroEE")),
        "exports_zero_ee": safe_float(r.get("exportsAllZeroEE")),
        "quality": r.get("quality"),
        "raw": json.dumps(r),
    }

def supabase_upsert(rows):
    url = f"{SUPABASE_URL}/rest/v1/lv_intervals?on_conflict=nmi,interval_end"
    payload = json.dumps(rows).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Supabase {e.code}: {e.read().decode()[:200]}")

def fetch_and_save(from_dt=None, to_dt=None, label=""):
    raw = lv_fetch(from_dt, to_dt)
    if raw and isinstance(raw[0], dict) and "error" in raw[0]:
        print(f"    API error: {raw[0]['error']}")
        return 0

    # Only keep 5-minute intervals — 30-min intervals overlap with 5-min data
    # and cause double-counting when both exist for the same time period.
    # FIX: cast to int before comparing — the API may return intervalDuration as
    # a string (e.g. "30"), and in Python "30" != 30 is True, so the filter
    # would silently pass all 30-min intervals through.
    def is_five_min(r):
        dur = r.get("intervalDuration")
        try:
            return int(dur) != 30
        except (TypeError, ValueError):
            return True  # keep if duration is unknown

    valid = [r for r in raw if r.get("NMI") and r.get("intervalEnd") and is_five_min(r)]

    qualities = {}
    durations = {}
    for r in valid:
        q = r.get("quality", "?")
        qualities[q] = qualities.get(q, 0) + 1
        d = r.get("intervalDuration", "?")
        durations[str(d)] = durations.get(str(d), 0) + 1
    skipped = len(raw) - len(valid)
    print(f"    {len(raw)} total, {len(valid)} kept ({skipped} 30-min skipped), quality={qualities}, duration={durations} {label}")
    if not valid: return 0
    rows = [transform(r) for r in valid]
    for i in range(0, len(rows), 500):
        status = supabase_upsert(rows[i:i+500])
        print(f"    Batch {i//500+1}: HTTP {status}")
    return len(rows)

def main():
    now = datetime.now(timezone.utc)
    print(f"[{now.isoformat()}] Sync — NMI={LV_NMI} HOURS_BACK={HOURS_BACK}")
    total = 0

    if HOURS_BACK == 0:
        # Live mode: fetch last 6 hours of actuals + 24hr forecast.
        # Fetching recent history ensures actuals overwrite any stale forecast data.
        from_dt = now - timedelta(hours=6)
        print(f"  Mode: live fetch (6hr lookback + forecast, from {from_dt.strftime('%H:%MZ')})")
        total = fetch_and_save(from_dt=from_dt, label="(live+lookback)")
    else:
        # Historical: loop day by day using AEST midnight boundaries.
        days = max(1, (HOURS_BACK + 23) // 24)
        print(f"  Mode: historical backfill — {days} AEST days")

        for i in range(days - 1, -1, -1):
            aest_date = (now + timedelta(hours=10)).date() - timedelta(days=i)
            from_utc = datetime(aest_date.year, aest_date.month, aest_date.day,
                                0, 0, 0, tzinfo=timezone.utc) - timedelta(hours=10)
            # API limit: 'to - from' must be strictly less than 24 hours.
            # Using 24h - 1s avoids the "cannot exceed 24 hours" rejection.
            to_utc = from_utc + timedelta(hours=24, seconds=-1)

            if from_utc >= now:
                print(f"  Skipping future day {aest_date}")
                continue
            # API limit: 'from' cannot be more than 72 hours in the past.
            # Use 71h as a safe margin.
            if now - from_utc > timedelta(hours=71):
                print(f"  Skipping {aest_date} — beyond 72h API history limit")
                continue
            to_utc = min(to_utc, now)

            print(f"  Day {days-i}/{days}: AEST {aest_date} → UTC {from_utc.strftime('%H:%MZ')}–{to_utc.strftime('%H:%MZ')}")
            try:
                saved = fetch_and_save(from_utc, to_utc, f"(AEST {aest_date})")
                total += saved
                if saved > 0:
                    time.sleep(0.5)
            except Exception as e:
                print(f"    ERROR: {e}")

    print(f"\n  Total rows saved: {total}")

if __name__ == "__main__":
    main()
