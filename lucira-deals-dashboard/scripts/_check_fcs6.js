const { BigQuery } = require('@google-cloud/bigquery');
const bq = new BigQuery({ projectId: 'lucirajewelry-prod' });
(async () => {
  const [header] = await bq.query({
    query: `
      SELECT transaction_id, document_no, document_date, document_status, net_amount, net_weight, party_id, company_id
      FROM \`lucirajewelry-prod.Lucira_Prod.exchange\`
      WHERE document_no = 'FCS-EXC-08-26-00006'
    `,
  });
  console.log('Header row(s):', JSON.stringify(header, null, 2));

  if (header.length) {
    const txnId = header[0].transaction_id;
    const [items] = await bq.query({
      query: `
        SELECT * FROM \`lucirajewelry-prod.Lucira_Prod.exchange_items\`
        WHERE transaction_id = ${txnId}
      `,
    });
    console.log('Item rows for this transaction_id:', items.length);
    console.log(JSON.stringify(items, null, 2));
  } else {
    console.log('No header row found with that exact document_no — checking similar ones...');
    const [similar] = await bq.query({
      query: `
        SELECT document_no, document_status FROM \`lucirajewelry-prod.Lucira_Prod.exchange\`
        WHERE document_no LIKE 'FCS-EXC-08-26-%'
        ORDER BY document_no
      `,
    });
    console.log(JSON.stringify(similar, null, 2));
  }
})().catch(e => console.error('ERR', e.message));
