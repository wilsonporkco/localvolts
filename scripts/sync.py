#!/usr/bin/env python3
"""
Localvolts -> Supabase sync script.

Two modes:
  HOURS_BACK=0  : Default fetch (6hr lookback + 24hr forecast). Run every 30 mins.
  HOURS_BACK=N  : Historical backfill -- loops day by day using AEST boundaries.

Multi-account support:
  Set LV_ACCOUNTS as a JSON array of account objects, e.g.:
    LV_ACCOUNTS='[{"label":"Wilsons","partner":"140046","apikey":"xxx","nmi":"*"},
                  {"label":"Dougall","partner":"213608","apikey":"yyy","nmi":"3120818117"}]'
  If LV_ACCOUNTS is not set, falls back to the single-account env vars:
    LV_API_KEY, LV_PARTNER, LV_NMI

Only 5-minute intervals are saved -- 30-min intervals overlap with 5-min data
and cause double-counting in the dashboard.
"""

import os, json, urllib.request, urllib.parse, time
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
HOURS_BACK   = int(os.environ.get("LV_HOURS_BACK", "0"))

LV_BASE = "https://api.localvolts.com/v1"

def supabase_get_setting(key):
    """Read a single key from the lv_settings table in Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/lv_settings?key=eq.{urllib.parse.quote(key)}&select=value&limit=1"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.loads(r.read())
            if rows and isinstance(rows, list):
                return rows[0].get("value")
    except Exception as e:
        print(f"  WARNING: Could not read {key} from Supabase: {e}")
    return None

# Build accounts list -- priority order:
#   1. lv_accounts saved in Supabase (added via dashboard settings UI)
#   2. LV_ACCOUNTS env var (manual override / bootstrap)
#   3. Single-account LV_API_KEY / LV_PARTNER / LV_NMI env vars (legacy fallback)
def load_accounts():
    # 1. Try Supabase first -- this is the live source updated by the dashboard
    sb_accounts = supabase_get_setting("lv_accounts")
    if sb_accounts is None:
        print("  Supabase lv_accounts: not found (key missing or read failed)")
    elif not isinstance(sb_accounts, list):
        print(f"  Supabase lv_accounts: unexpected type {type(sb_accounts).__name__}, skipping")
    elif not sb_accounts:
        print("  Supabase lv_accounts: empty list")
    else:
        valid = [a for a in sb_accounts if a.get("apikey") and a.get("partner")]
        invalid = [a.get("label", "?") for a in sb_accounts if not (a.get("apikey") and a.get("partner"))]
        if invalid:
            print(f"  Supabase lv_accounts: skipping {len(invalid)} account(s) missing apikey/partner: {invalid}")
        if valid:
            print(f"  Loaded {len(valid)} account(s) from Supabase lv_settings: {[a.get('label','?') for a in valid]}")
            # Ensure each account has an nmi field
            for a in valid:
                if not a.get("nmi"):
                    a["nmi"] = ",".join(a.get("nmis", [])) if a.get("nmis") else "*"
            return valid

    # 2. Fall back to LV_ACCOUNTS env var
    raw = os.environ.get("LV_ACCOUNTS", "")
    if raw.strip():
        try:
            accounts = json.loads(raw)
            if isinstance(accounts, list) and accounts:
                print(f"  Loaded {len(accounts)} account(s) from LV_ACCOUNTS env var")
                return accounts
        except Exception as e:
            print(f"  WARNING: Could not parse LV_ACCOUNTS JSON: {e}")

    # 3. Legacy single-account env vars
    print("  Using single-account env vars (LV_API_KEY / LV_PARTNER / LV_NMI)")
    return [{
        "label":   os.environ.get("LV_LABEL", "Default"),
        "partner": os.environ["LV_PARTNER"],
        "apikey":  os.environ["LV_API_KEY"],
        "nmi":     os.environ.get("LV_NMI", "*"),
    }]

def lv_fetch(account, from_dt=None, to_dt=None):
    nmi     = account.get("nmi", "*")
    api_key = account["apikey"]
    partner = account["partner"]
    # Build query string manually -- urllib encodes colons which breaks the API
    qs = f"NMI={urllib.parse.quote(nmi)}"
    if from_dt: qs += f"&from={from_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    if to_dt:   qs += f"&to={to_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    url = f"{LV_BASE}/customer/interval?{qs}"
    print(f"    GET {url}")
    req = urllib.request.Request(url, headers={
        "Authorization": f"apikey {api_key}",
        "partner":       partner,
        "User-Agent":    "LocalvoltsSync/1.0",
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

def fetch_and_save(account, from_dt=None, to_dt=None, label=""):
    raw = lv_fetch(account, from_dt, to_dt)
    if raw and isinstance(raw[0], dict) and "error" in raw[0]:
        print(f"    API error: {raw[0]['error']}")
        return 0

    # Only keep 5-minute intervals -- 30-min intervals overlap with 5-min data
    # and cause double-counting when both exist for the same time period.
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

def sync_account(account, now):
    label = account.get("label", account.get("partner", "?"))
    # Support both 'nmi' (string) and 'nmis' (array from dashboard)
    # If manual NMIs are set, sync each one individually so we get the right data
    nmis_list = account.get("nmis") or []
    if isinstance(nmis_list, list) and nmis_list:
        nmi = nmis_list[0]  # use first manual NMI; loop below handles multiples
    else:
        nmi = account.get("nmi", "*")
    account = dict(account, nmi=nmi)  # ensure nmi key is set

    total = 0
    print(f"\n  Account: {label} (partner={account.get('partner')}, NMI={nmi})")

    if HOURS_BACK == 0:
        from_dt = now - timedelta(hours=6)
        print(f"    Mode: live fetch (6hr lookback + forecast, from {from_dt.strftime('%H:%MZ')})")
        total = fetch_and_save(account, from_dt=from_dt, label="(live+lookback)")
    else:
        days = max(1, (HOURS_BACK + 23) // 24)
        print(f"    Mode: historical backfill -- {days} AEST days")

        for i in range(days - 1, -1, -1):
            aest_date = (now + timedelta(hours=10)).date() - timedelta(days=i)
            from_utc = datetime(aest_date.year, aest_date.month, aest_date.day,
                                0, 0, 0, tzinfo=timezone.utc) - timedelta(hours=10)
            to_utc = from_utc + timedelta(hours=24, seconds=-1)

            if from_utc >= now:
                print(f"    Skipping future day {aest_date}")
                continue
            if now - from_utc > timedelta(hours=71):
                print(f"    Skipping {aest_date} -- beyond 72h API history limit")
                continue
            to_utc = min(to_utc, now)

            print(f"    Day {days-i}/{days}: AEST {aest_date}")
            try:
                saved = fetch_and_save(account, from_utc, to_utc, f"(AEST {aest_date})")
                total += saved
                if saved > 0:
                    time.sleep(0.5)
            except Exception as e:
                print(f"    ERROR: {e}")

    return total

def main():
    now      = datetime.now(timezone.utc)
    accounts = load_accounts()
    print(f"[{now.isoformat()}] Sync -- {len(accounts)} account(s), HOURS_BACK={HOURS_BACK}")

    grand_total = 0
    for account in accounts:
        try:
            grand_total += sync_account(account, now)
        except Exception as e:
            label = account.get("label", account.get("partner", "?"))
            print(f"  ERROR syncing account {label}: {e}")

    print(f"\n  Total rows saved across all accounts: {grand_total}")

if __name__ == "__main__":
    main()
