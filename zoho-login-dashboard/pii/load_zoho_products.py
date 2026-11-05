"""
Load a Zoho CRM "Products" CSV export into BigQuery, UNCHANGED.

    python pii/load_zoho_products.py C:/Users/ADMIN/Downloads/Products_2026_10_03.csv [--date 2026-10-03]

-> lucirajewelry-prod.zoho_crm.zoho_products_src
   * every CSV column kept as STRING (header -> snake_case), values untouched
   * + export_date (from the file name Products_YYYY_MM_DD.csv or --date),
     source_file, loaded_at
   * re-loading the same export_date replaces only that date's rows

All mapping / normalisation happens downstream in the views built by
pii/product_inventory.sql — this table is the raw source of truth.
"""
import argparse, csv, datetime as dt, io, os, re, sys
from google.cloud import bigquery

PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
TABLE = f"{PROJECT}.zoho_crm.zoho_products_src"


def snake(h):
    return re.sub(r"_+", "_", re.sub(r"[^0-9a-z]+", "_", h.strip().lower())).strip("_")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("--date", help="export date YYYY-MM-DD (default: from file name)")
    a = ap.parse_args()
    m = re.search(r"(\d{4})_(\d{2})_(\d{2})", os.path.basename(a.csv_path))
    export_date = a.date or (f"{m[1]}-{m[2]}-{m[3]}" if m else None)
    if not export_date:
        sys.exit("cannot infer export date from file name — pass --date YYYY-MM-DD")

    with open(a.csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    header, body = [snake(h) for h in rows[0]], rows[1:]
    if len(set(header)) != len(header):
        sys.exit(f"duplicate column names after snake_case: {header}")
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    recs = [dict(zip(header, r), export_date=export_date,
                 source_file=os.path.basename(a.csv_path), loaded_at=now) for r in body]

    bq = bigquery.Client(project=PROJECT)
    schema = ([bigquery.SchemaField(h, "STRING") for h in header] +
              [bigquery.SchemaField("export_date", "DATE"),
               bigquery.SchemaField("source_file", "STRING"),
               bigquery.SchemaField("loaded_at", "TIMESTAMP")])
    try:
        bq.query(f"DELETE FROM `{TABLE}` WHERE export_date = '{export_date}'").result()
    except Exception:
        pass  # first load: table does not exist yet
    job = bq.load_table_from_json(recs, TABLE, job_config=bigquery.LoadJobConfig(
        schema=schema, write_disposition="WRITE_APPEND",
        schema_update_options=[bigquery.SchemaUpdateOption.ALLOW_FIELD_ADDITION],
        time_partitioning=bigquery.TimePartitioning(field="export_date")))
    job.result()
    n = list(bq.query(f"SELECT COUNT(*) n FROM `{TABLE}` WHERE export_date='{export_date}'").result())[0]["n"]
    print(f"loaded {len(recs)} CSV rows -> {TABLE} (export_date={export_date}); table now has {n} rows for that date")
    if n != len(recs):
        sys.exit("ROW COUNT MISMATCH")


if __name__ == "__main__":
    main()
