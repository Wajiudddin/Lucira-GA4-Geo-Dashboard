"""
Independent validation of zoho_crm.zoho_deal_intelligence (spec §23).

For up to 30 deals per validation case it re-derives every flag in PYTHON straight
from the raw sources (cdc_deals JSON, cdc_contacts JSON, marketing_sale rows) —
not from the SQL — and compares. Also checks table-wide invariants (no duplicate
deal ids, buyer + non-buyer = total, sale duplication cannot inflate deals).

Run:  python deal_intel/validate_deal_intelligence.py
"""
import json
import re
import sys
from collections import defaultdict

from google.cloud import bigquery

BQ = bigquery.Client(project="lucirajewelry-prod")
T = "`lucirajewelry-prod.zoho_crm.zoho_deal_intelligence`"
V = "`lucirajewelry-prod.zoho_crm.zoho_deal_intelligence_validation_v`"
q = lambda sql: [dict(r) for r in BQ.query(sql).result()]


def norm_mobile(x):
    m = re.sub(r"[^0-9]", "", x or "")
    if len(m) == 12 and m.startswith("91"):
        m = m[2:]
    elif len(m) == 11 and m.startswith("0"):
        m = m[1:]
    elif len(m) == 13 and m.startswith("091"):
        m = m[3:]
    if len(m) == 10 and m[0] in "6789" and len(set(m)) > 1:
        return m
    return None


def norm_email(x):
    e = (x or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", e):
        return None
    if re.match(r"^\+?[0-9]+@", e) or e.endswith("@lucirajewelry.com"):
        return None
    return e


def norm_name(x):
    s = re.sub(r"[^a-z ]", " ", (x or "").lower())
    s = re.sub(r"\b(mr|mrs|ms|miss|dr|shri|smt)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip() or None


def main():
    fails = []

    # ---------------------------------------------------------------- invariants
    inv = q(f"""SELECT COUNT(*) n, COUNT(DISTINCT deal_id) ids, COUNTIF(buyer_flag) b,
                       COUNTIF(NOT buyer_flag) nb, COUNTIF(subscriber_flag AND visitor_flag) sv,
                       (SELECT COUNT(*) FROM `lucirajewelry-prod.zoho_crm.cdc_deals`) src
                FROM {T}""")[0]
    print("Invariants:", inv)
    if inv["n"] != inv["ids"]:
        fails.append("duplicate deal_id rows in table")
    if inv["n"] != inv["src"]:
        fails.append(f"row count {inv['n']} != cdc_deals {inv['src']}")
    if inv["b"] + inv["nb"] != inv["n"]:
        fails.append("buyer + non-buyer != total")
    if inv["sv"]:
        fails.append(f"{inv['sv']} deals are both Subscriber and Visitor")

    # sales: how many customers have >1 sale row (proves de-dup matters)
    dup = q("""SELECT COUNTIF(n > 1) multi, COUNT(*) customers FROM (
                 SELECT RIGHT(REGEXP_REPLACE(Cus_mobile, r'[^0-9]', ''), 10) m, COUNT(*) n
                 FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale` GROUP BY 1)""")[0]
    print(f"Sale customers with >1 sale row: {dup['multi']} of {dup['customers']} "
          "(table still has exactly one row per deal -> no inflation)")

    # ---------------------------------------------------------------- samples
    sample = q(f"""SELECT * FROM {V}
                   QUALIFY ROW_NUMBER() OVER (PARTITION BY validation_case ORDER BY FARM_FINGERPRINT(deal_id)) <= 30""")
    ids = [s["deal_id"] for s in sample]
    raw = {r["id"]: r for r in q(f"""
        SELECT d.id, d.created_time, d.data, c.data cdata
        FROM `lucirajewelry-prod.zoho_crm.cdc_deals` d
        LEFT JOIN `lucirajewelry-prod.zoho_crm.cdc_contacts` c ON c.id = JSON_VALUE(d.data, '$.Contact_Name.id')
        WHERE d.id IN ({','.join("'" + i + "'" for i in ids)})""")}

    sales = q("""SELECT Transaction_Date d, Cus_mobile, mobile1, email, party_name
                 FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale` WHERE Transaction_Date IS NOT NULL""")
    by_m, by_e, by_n, n_ids = {}, {}, {}, defaultdict(set)
    for s in sales:
        m, e, n = norm_mobile(s["Cus_mobile"] or s["mobile1"]), norm_email(s["email"]), norm_name(s["party_name"])
        if m: by_m[m] = min(by_m.get(m, s["d"]), s["d"])
        if e: by_e[e] = min(by_e.get(e, s["d"]), s["d"])
        if n and " " in n:
            by_n[n] = min(by_n.get(n, s["d"]), s["d"]); n_ids[n].add(m or e or "x")

    from datetime import timedelta, timezone
    ist = timezone(timedelta(hours=5, minutes=30))
    per_case = defaultdict(lambda: [0, 0])
    for s in sample:
        r = raw[s["deal_id"]]
        d = json.loads(r["data"]); c = json.loads(r["cdata"]) if r["cdata"] else {}
        created = r["created_time"].astimezone(ist).date()
        mob = norm_mobile((d.get("Mobile") or "").strip() or c.get("Mobile"))
        em = norm_email((d.get("Email") or "").strip() or c.get("Email"))
        name = norm_name(((d.get("Contact_Name") or {}).get("name") or "").strip() or c.get("Full_Name")
                         or re.sub(r"_[0-9]+$", "", d.get("Deal_Name") or ""))
        cands = [by_m.get(mob), by_e.get(em)]
        if not mob and not em and name in by_n and len(n_ids[name]) == 1:
            cands.append(by_n[name])
        cands = [x for x in cands if x]
        min_sale = min(cands) if cands else None
        trig = (d.get("Deal_Trigger_Event") or "").lower()
        nitro = "nitro" in trig
        exp = {
            "minimum_sale_date": min_sale,
            "buyer_flag": bool(min_sale and min_sale < created),
            "ctwa_flag": "whatsapp" in trig,
            "subscriber_flag": not nitro and "whatsapp" not in trig,
            "visitor_flag": nitro,
        }
        exp["deal_category"] = ("CTWA" if exp["ctwa_flag"] else "Buyer" if exp["buyer_flag"]
                                else "Subscriber" if exp["subscriber_flag"]
                                else "Visitor" if exp["visitor_flag"] else "Non-Buyer")
        if s["deal_created_date"] != created:
            exp["deal_created_date"] = created
        bad = {k: (s.get(k), v) for k, v in exp.items() if s.get(k) != v}
        if s["deal_created_date"] != created:
            bad["deal_created_date"] = (s["deal_created_date"], created)
        per_case[s["validation_case"]][0] += 1
        if bad:
            per_case[s["validation_case"]][1] += 1
            fails.append(f"{s['deal_id']} {s['validation_case']}: {bad}")

    print("\nSample re-computation (independent Python vs table):")
    for k in sorted(per_case):
        n, b = per_case[k]
        print(f"  {k:<45} checked {n:>3}  mismatches {b}")

    # spot the explicit rule examples
    print("\nExamples:")
    for k in sorted(per_case):
        ex = next(s for s in sample if s["validation_case"] == k)
        print(f"  {k}: deal {ex['deal_id']} created {ex['deal_created_date']} min_sale {ex['minimum_sale_date']} "
              f"trigger={ex['deal_trigger_event']!r} lead={ex['lead_source']!r} -> {ex['deal_category']} [{ex['matched_rules']}]")

    print("\nRESULT:", "PASS" if not fails else f"FAIL ({len(fails)})")
    for f in fails[:40]:
        print("  -", f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
