# MTO Control Tower

    npm install
    set GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>   # needs BigQuery read on lucirajewelry-prod
    npm start                                                   # http://localhost:4100

- `sql/mto_model.sql` - the only place data is joined (one row per MTO order line; join keys documented in the file).
- `public/js/config.js` - targets (`VENDOR_PRODUCTION_TAT`, `OVERALL_MTO_TAT`), ageing buckets, stage names.
- `public/js/model.js` - stage / ageing / status rules. `views.js` - rendering. `app.js` - filters and events.
- Server caches the query 15 min; falls back to `data/snapshot.json` if BigQuery is unreachable. `npm run snapshot` refreshes it.
- To add a stage or source: add its milestone date to the SQL, a rule in `model.js`, a `STAGES` entry in `config.js`.
