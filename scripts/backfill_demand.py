#!/usr/bin/env python3
"""
Backfill lv_demand table with 30-min NEM interval demand data.

Fetches from the start of the current billing month (or LV_BACKFILL_FROM env var)
through to now, saving 30-min intervals to lv_demand.

Note: The LV API only returns ~72h of history. Intervals older than that
will not be fetchable. Run seed_lv_demand.sql first to cover the known monthly
peak if it occurred before the API window.

Usage:
  python3 backfill_demand.py

Env vars (same as sync.py):
  SUPABASE_URL, SUPABASE_KEY — required
  LV_ACCOUNTS / LV_API_KEY + LV_PARTNER + LV_NMI — required
  LV_BACKFILL_FROM — optional ISO date override, e.g. 2026-06-01
"""

import os, json, urllib.request, urllib.parse, time
from datetime import datetime, timezone, timedelta, date

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
LV_BASE = "https://api.localvolts.com/v1"

# ── helpers ──────────────────────────────────────────────────────────────────

def safe_float(val):
    if val is None or val == "N/A": return None
    try: return float(val)
    except: return None

def is_thirty_min(r):
    try: return int(r.get("intervalDuration", 0)) == 30
    except: return False

def transform_demand(r):
    return {
        "nmi":               r.get("NMI"),
        "interval_end":      r.get("intervalEnd"),
        "interval_duration": r.get("intervalDuration"),
        "demand_main_kw":    safe_float(r.get("demandMain")),
        "costs_demand":      safe_float(r.get("costsDemandMain")),
        "quality":           r.get("quality"),
    }

# ── Supabase ──────────────────────────────────────────────────────────────────

def supabase_get_setting(key):
    url = f"{SUPABASE_URL}/rest/v1/lv_settings?key=eq.{urllib.parse.quote(key)}&select=value&limit=1"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.loads(r.read())
            if rows:
                val = rows[0].get("value")
                if isinstance(val, str):
                    try: return json.loads(val)
                    except: return val
                return val
    except Exception as e:
        print(f"  WARNING: Could not read {key} from Supabase: {e}")
    return None

def supabase_upsert_demand(rows):
    url = f"{SUPABASE_URL}/rest/v1/lv_demand?on_conflict=nmi,interval_end"
    payload = json.dumps(rows).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Supabase lv_demand {e.code}: {e.read().decode()[:300]}")

# ── accounts ──────────────────────────────────────────────────────────────────

def load_accounts():
    sb = supabase_get_setting("lv_accounts")
    if isinstance(sb, list) and sb:
        valid = [a for a in sb if a.get("apikey") and a.get("partner")]
        for a in valid:
            if not a.get("nmi"):
                a["nmi"] = ",".join(a.get("nmis", [])) if a.get("nmis") else "*"
        if valid:
            print(f"  Loaded {len(valid)} account(s) from Supabase")
            return valid

    raw = os.environ.get("LV_ACCOUNTS", "")
    if raw.strip():
        try:
            accounts = json.loads(raw)
            if isinstance(accounts, list) and accounts:
                print(f"  Loaded {len(accounts)} account(s) from LV_ACCOUNTS env var")
                return accounts
        except Exception as e:
            print(f"  WARNING: Could not parse LV_ACCOUNTS: {e}")

    print("  Using single-account env vars")
    return [{
        "label":   os.environ.get("LV_LABEL", "Default"),
        "partner": os.environ["LV_PARTNER"],
        "apikey":  os.environ["LV_API_KEY"],
        "nmi":     os.environ.get("LV_NMI", "*"),
    }]

# ── LV API ────────────────────────────────────────────────────────────────────

def lv_fetch(account, from_dt, to_dt):
    nmi     = account.get("nmi", "*")
    api_key = account["apikey"]
    partner = account["partner"]
    qs = (f"NMI={urllib.parse.quote(nmi)}"
          f"&from={from_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
          f"&to={to_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    url = f"{LV_BASE}/customer/interval?{qs}"
    print(f"    GET {url}")
    req = urllib.request.Request(url, headers={
        "Authorization": f"apikey {api_key}",
        "partner":       partner,
        "User-Agent":    "LocalvoltsDemandBackfill/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    now = datetime.now(timezone.utc)

    # Determine start of current billing month in AEST (UTC+10)
    aest_now = now + timedelta(hours=10)
    month_start_aest = date(aest_now.year, aest_now.month, 1)
    month_start_utc  = datetime(month_start_aest.year, month_start_aest.month, 1,
                                tzinfo=timezone.utc) - timedelta(hours=10)

    # Allow env override
    override = os.environ.get("LV_BACKFILL_FROM", "")
    if override:
        month_start_utc = datetime.fromisoformat(override.replace("Z", "+00:00"))
        if month_start_utc.tzinfo is None:
            month_start_utc = month_start_utc.replace(tzinfo=timezone.utc)

    # API hard limit: ~72h history
    api_limit = now - timedelta(hours=71, minutes=50)
    fetch_from = max(month_start_utc, api_limit)
    fetch_to   = now

    print(f"[{now.isoformat()}] Demand backfill")
    print(f"  Billing month start (AEST): {month_start_aest}")
    print(f"  API window available:       {api_limit.strftime('%Y-%m-%d %H:%MZ')} → now")
    print(f"  Fetching:                   {fetch_from.strftime('%Y-%m-%d %H:%MZ')} → {fetch_to.strftime('%Y-%m-%d %H:%MZ')}")

    if fetch_from > month_start_utc:
        print(f"\n  ⚠  NOTE: Data before {fetch_from.strftime('%Y-%m-%d')} is outside the API window.")
        print(f"     If the billing peak occurred before that date, run seed_lv_demand.sql manually.")

    accounts = load_accounts()
    total_saved = 0

    for account in accounts:
        label = account.get("label", account.get("partner", "?"))
        nmis_list = account.get("nmis") or []
        if isinstance(nmis_list, list) and nmis_list:
            nmis = [n for n in nmis_list if n]
        else:
            nmis = [account.get("nmi", "*")]

        for nmi in nmis:
            acct = dict(account, nmi=nmi)
            print(f"\n  [{label}] NMI={nmi}")
            try:
                raw = lv_fetch(acct, fetch_from, fetch_to)
            except Exception as e:
                print(f"    ERROR fetching: {e}")
                continue

            demand_rows = [
                transform_demand(r)
                for r in raw
                if r.get("NMI") and r.get("intervalEnd")
                and is_thirty_min(r)
                and safe_float(r.get("demandMain")) is not None
            ]

            if not demand_rows:
                print(f"    No 30-min demand intervals found in response ({len(raw)} total intervals)")
                continue

            peak = max(safe_float(r["demand_main_kw"]) for r in demand_rows if r["demand_main_kw"])
            print(f"    Found {len(demand_rows)} 30-min demand intervals | peak demand_main_kw={peak:.4f} → {peak*2:.2f} kW")

            saved = 0
            for i in range(0, len(demand_rows), 500):
                batch = demand_rows[i:i+500]
                status = supabase_upsert_demand(batch)
                print(f"    Batch {i//500+1}: HTTP {status} ({len(batch)} rows)")
                saved += len(batch)
                if i + 500 < len(demand_rows):
                    time.sleep(0.3)

            total_saved += saved
            print(f"    Saved {saved} rows to lv_demand")

    print(f"\n  Done — {total_saved} total rows saved to lv_demand")

if __name__ == "__main__":
    main()
