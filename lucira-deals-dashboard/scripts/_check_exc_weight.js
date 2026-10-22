const { BigQuery } = require('@google-cloud/bigquery');
const bq = new BigQuery({ projectId: 'lucirajewelry-prod' });
(async () => {
  // Item-level (exchange_items) — what the dashboard uses
  const [itemRows] = await bq.query({
    query: `
      SELECT e.document_no, ei.net_weight AS item_net_weight, e.net_weight AS header_net_weight,
        e.document_status, ei.transaction_item_id
      FROM \`lucirajewelry-prod.Lucira_Prod.exchange_items\` ei
      JOIN \`lucirajewelry-prod.Lucira_Prod.exchange\` e ON ei.transaction_id = e.transaction_id
      WHERE REGEXP_CONTAINS(e.document_no, r'-EXC-')
      ORDER BY e.document_no
    `,
  });
  console.log('Total exchange_items rows for EXC:', itemRows.length);
  console.log('Distinct document_no:', new Set(itemRows.map(r => r.document_no)).size);

  const itemLevelSum = itemRows.reduce((s, r) => s + Number(r.item_net_weight), 0);
  console.log('SUM of item-level net_weight (exchange_items.net_weight):', itemLevelSum.toFixed(3));

  // header-level net_weight, summed ONCE per distinct transaction (not per item)
  const headerByDoc = new Map();
  itemRows.forEach(r => { headerByDoc.set(r.document_no, Number(r.header_net_weight)); });
  const headerLevelSum = [...headerByDoc.values()].reduce((s, v) => s + v, 0);
  console.log('SUM of header-level net_weight (exchange.net_weight, once per doc):', headerLevelSum.toFixed(3));

  // header-level net_weight summed ONCE PER ITEM ROW (i.e. duplicated across items in the same doc)
  const headerSumPerItemRow = itemRows.reduce((s, r) => s + Number(r.header_net_weight), 0);
  console.log('SUM of header-level net_weight repeated per item row:', headerSumPerItemRow.toFixed(3));

  console.log('Full item list:');
  console.log(JSON.stringify(itemRows, null, 2));
})().catch(e => console.error('ERR', e.message));
