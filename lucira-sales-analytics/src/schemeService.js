require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');

// Same auth pattern as refillService.js / oldGoldService.js: local gcloud ADC,
// or a service account JSON in an env var in production.
const bigquery = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? new BigQuery({
      projectId: 'lucirajewelry-prod',
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    })
  : new BigQuery({ projectId: 'lucirajewelry-prod' });

function bqVal(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

function toNumber(v) {
  const n = Number(bqVal(v));
  return Number.isFinite(n) ? n : 0;
}

function toNullableNumber(v) {
  const raw = bqVal(v);
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toDateOnly(v) {
  const raw = bqVal(v);
  return raw ? String(raw).slice(0, 10) : null;
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + 'T00:00:00Z').getTime();
  const to = new Date(toDateStr + 'T00:00:00Z').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

// Three independent fact sets, each queried and aggregated on its own grain —
// deliberately NOT flattened into one join (scheme_monthly_details and
// scheme_payment both fan out against scheme_enrollment independently, so a
// single flattened query double-counts collections/installments before any
// de-dupe trick can fix it). payment_till_now is pre-aggregated so the
// enrollment query stays one row per enrollment.
const ENROLLMENT_QUERY = `
  WITH payment_till_now AS (
    SELECT scheme_enrollment_id, SUM(amount) AS payment_till_now
    FROM \`lucirajewelry-prod.Lucira_Prod.scheme_payment\`
    GROUP BY scheme_enrollment_id
  )
  SELECT
    a.scheme_enrollment_id,
    a.scheme_unique_code,
    a.party_id,
    p.party_name,
    p.mobile AS party_mobile,
    p.phone AS party_phone,
    a.company_id,
    c.company_name,
    a.scheme_id,
    a.scheme_amount,
    a.scheme_bonus_value,
    a.invested_amount,
    a.total_amount,
    a.total_payable,
    a.benifit_amount,
    a.total_allocated_weight,
    COALESCE(pt.payment_till_now, 0) AS payment_till_now,
    a.is_cancelled,
    a.is_matured,
    a.is_redeemed,
    a.scheme_status,
    a.tenure,
    a.multiplier,
    a.auto_pay_enabled,
    a.creation_date,
    a.document_date,
    a.maturity_month,
    a.maturity_year
  FROM \`lucirajewelry-prod.Pos.scheme_enrollment\` a
  LEFT JOIN payment_till_now pt ON a.scheme_enrollment_id = pt.scheme_enrollment_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON a.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON a.party_id = p.party_id
`;

// scheme_monthly_details joined 1:1 back to scheme_enrollment purely to pick
// up company_id/party_id for filtering — enrollment is the "one" side of that
// join so this can't fan the installment rows out.
const INSTALLMENT_QUERY = `
  SELECT
    b.scheme_monthly_details_id,
    b.scheme_enrollment_id,
    a.scheme_unique_code,
    a.party_id,
    p.party_name,
    p.mobile AS party_mobile,
    p.phone AS party_phone,
    a.company_id,
    c.company_name,
    sp.employee_name AS sales_person,
    b.month_id,
    b.month_amount,
    b.due_date,
    b.paid_on_date,
    b.payment_made,
    b.delay_days,
    b.days_held,
    b.gold_rate,
    b.weight,
    b.benefit_amount
  FROM \`lucirajewelry-prod.Lucira_Prod.scheme_monthly_details\` b
  LEFT JOIN \`lucirajewelry-prod.Pos.scheme_enrollment\` a ON b.scheme_enrollment_id = a.scheme_enrollment_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON a.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON a.party_id = p.party_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_administration_1.employee\` sp ON a.sales_person_id = sp.employee_id
`;

const PAYMENT_QUERY = `
  SELECT
    s.scheme_payment_id,
    s.scheme_enrollment_id,
    s.party_id,
    p.party_name,
    s.company_id,
    c.company_name,
    s.document_no,
    s.document_date,
    s.document_status,
    s.amount,
    s.gold_rate,
    s.weight
  FROM \`lucirajewelry-prod.Lucira_Prod.scheme_payment\` s
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.company\` c ON s.company_id = c.company_id
  LEFT JOIN \`lucirajewelry-prod.ornaverse_erp_master.party\` p ON s.party_id = p.party_id
`;

// Cancelled beats matured beats redeemed beats "still in progress" — a
// cancelled scheme is terminal regardless of what else got flagged on it.
//
// is_cancelled alone isn't reliable — it can lag behind the source POS system
// (confirmed: an enrollment cancelled in Ornaverse still had is_cancelled =
// null in BigQuery). scheme_status = 0 tracks the same "cancelled/inactive"
// state and was correctly set on that same enrollment, so it's treated as an
// equally-valid cancellation signal here — every enrollment observed with
// scheme_status = 0 also had no lifecycle flags set otherwise.
function isEffectivelyCancelled(e) {
  return e.isCancelled || e.schemeStatus === 0;
}

function deriveStatus(e) {
  if (isEffectivelyCancelled(e)) return 'Cancelled';
  if (e.isMatured) return 'Matured';
  if (e.isRedeemed) return 'Redeemed';
  return 'Active';
}

async function buildSchemeDashboard() {
  const [[enrollmentRows], [installmentRows], [paymentRows]] = await Promise.all([
    bigquery.query({ query: ENROLLMENT_QUERY }),
    bigquery.query({ query: INSTALLMENT_QUERY }),
    bigquery.query({ query: PAYMENT_QUERY }),
  ]);

  const today = todayISODate();

  // Built up front from the raw enrollment rows so the installment mapping
  // below can gate isOverdue on it — a cancelled scheme's unpaid installments
  // aren't outstanding debt, they're moot, and shouldn't count as overdue
  // anywhere on the dashboard (KPIs, charts, tables all read isOverdue).
  const cancelledEnrollmentIds = new Set(
    enrollmentRows
      .filter(r => !!r.is_cancelled || bqVal(r.scheme_status) === 0)
      .map(r => bqVal(r.scheme_enrollment_id))
  );

  const installments = installmentRows.map(r => {
    const dueDate = toDateOnly(r.due_date);
    const paidOnDate = toDateOnly(r.paid_on_date);
    const paymentMade = !!r.payment_made;
    const isCancelledScheme = cancelledEnrollmentIds.has(bqVal(r.scheme_enrollment_id));
    const isOverdue = !paymentMade && !!dueDate && dueDate < today && !isCancelledScheme;
    return {
      schemeMonthlyDetailsId: bqVal(r.scheme_monthly_details_id),
      schemeEnrollmentId: bqVal(r.scheme_enrollment_id),
      enrollmentCode: r.scheme_unique_code || null,
      partyId: bqVal(r.party_id),
      customerName: r.party_name || 'Unknown',
      customerMobile: r.party_mobile || r.party_phone || null,
      companyId: bqVal(r.company_id),
      companyName: r.company_name || 'Unknown',
      salesPerson: r.sales_person || null,
      isCancelledScheme,
      monthId: bqVal(r.month_id),
      monthAmount: round2(toNumber(r.month_amount)),
      dueDate,
      dueMonth: dueDate ? dueDate.slice(0, 7) : null,
      paidOnDate,
      paymentMade,
      delayDays: toNullableNumber(r.delay_days),
      daysHeld: toNullableNumber(r.days_held),
      goldRate: toNullableNumber(r.gold_rate),
      weight: toNullableNumber(r.weight),
      benefitAmount: round2(toNumber(r.benefit_amount)),
      isOverdue,
      overdueDays: isOverdue ? daysBetween(dueDate, today) : null,
    };
  });

  // Per-enrollment installment rollups, computed once here so the front end
  // doesn't need to re-join two arrays on every filter change.
  const overdueByEnrollment = new Map();
  const nextDueByEnrollment = new Map();
  const installmentCountByEnrollment = new Map();
  const paidCountByEnrollment = new Map();
  const lastPaidDateByEnrollment = new Map();

  installments.forEach(i => {
    const id = i.schemeEnrollmentId;
    installmentCountByEnrollment.set(id, (installmentCountByEnrollment.get(id) || 0) + 1);
    if (i.paymentMade) paidCountByEnrollment.set(id, (paidCountByEnrollment.get(id) || 0) + 1);

    if (i.paymentMade && i.paidOnDate) {
      const existingPaid = lastPaidDateByEnrollment.get(id);
      if (!existingPaid || i.paidOnDate > existingPaid) lastPaidDateByEnrollment.set(id, i.paidOnDate);
    }

    if (i.isOverdue) {
      // oldestDueDate is the due date driving maxDays — the installment that's
      // been unpaid the longest, not just any overdue due date.
      const existing = overdueByEnrollment.get(id) || { count: 0, amount: 0, maxDays: 0, oldestDueDate: null };
      existing.count += 1;
      existing.amount += i.monthAmount;
      if ((i.overdueDays || 0) >= existing.maxDays) {
        existing.maxDays = i.overdueDays || 0;
        existing.oldestDueDate = i.dueDate;
      }
      overdueByEnrollment.set(id, existing);
    }

    if (!i.paymentMade && i.dueDate && i.dueDate >= today) {
      const existing = nextDueByEnrollment.get(id);
      if (!existing || i.dueDate < existing.dueDate) {
        nextDueByEnrollment.set(id, { dueDate: i.dueDate, amount: i.monthAmount });
      }
    }
  });

  const payments = paymentRows.map(r => {
    const documentDate = toDateOnly(r.document_date);
    return {
      schemePaymentId: bqVal(r.scheme_payment_id),
      schemeEnrollmentId: bqVal(r.scheme_enrollment_id),
      partyId: bqVal(r.party_id),
      customerName: r.party_name || 'Unknown',
      companyId: bqVal(r.company_id),
      companyName: r.company_name || 'Unknown',
      documentNo: r.document_no,
      documentDate,
      month: documentDate ? documentDate.slice(0, 7) : null,
      documentStatus: bqVal(r.document_status),
      amount: round2(toNumber(r.amount)),
      goldRate: toNullableNumber(r.gold_rate),
      weight: toNullableNumber(r.weight),
    };
  });

  const enrollments = enrollmentRows.map(r => {
    const creationDate = toDateOnly(r.creation_date);
    // scheme_amount is the MONTHLY installment amount, not the scheme's total
    // committed value — total_amount (~= scheme_amount x tenure, sometimes plus
    // a bonus month) is the actual commitment, confirmed against sample rows.
    // Collection rate and "committed value" must be measured against
    // total_amount, or a scheme mid-tenure would misleadingly read as
    // already-overcollected.
    const monthlyAmount = round2(toNumber(r.scheme_amount));
    const totalAmount = round2(toNumber(r.total_amount));
    const paymentTillNow = round2(toNumber(r.payment_till_now));
    const id = bqVal(r.scheme_enrollment_id);
    const overdue = overdueByEnrollment.get(id) || { count: 0, amount: 0, maxDays: 0, oldestDueDate: null };
    const nextDue = nextDueByEnrollment.get(id) || null;

    const enrollment = {
      schemeEnrollmentId: id,
      enrollmentCode: r.scheme_unique_code || null,
      partyId: bqVal(r.party_id),
      customerName: r.party_name || 'Unknown',
      customerMobile: r.party_mobile || r.party_phone || null,
      companyId: bqVal(r.company_id),
      companyName: r.company_name || 'Unknown',
      schemeId: bqVal(r.scheme_id),
      monthlyAmount,
      schemeBonusValue: round2(toNumber(r.scheme_bonus_value)),
      investedAmount: round2(toNumber(r.invested_amount)),
      totalAmount,
      totalPayable: round2(toNumber(r.total_payable)),
      benefitAmount: round2(toNumber(r.benifit_amount)),
      totalAllocatedWeight: toNullableNumber(r.total_allocated_weight),
      paymentTillNow,
      collectionRatePct: totalAmount > 0 ? round2((paymentTillNow / totalAmount) * 100) : null,
      isCancelled: !!r.is_cancelled,
      isMatured: !!r.is_matured,
      isRedeemed: !!r.is_redeemed,
      schemeStatus: bqVal(r.scheme_status),
      tenure: bqVal(r.tenure),
      multiplier: bqVal(r.multiplier),
      autoPayEnabled: !!r.auto_pay_enabled,
      creationDate,
      month: creationDate ? creationDate.slice(0, 7) : null,
      documentDate: toDateOnly(r.document_date),
      maturityMonth: bqVal(r.maturity_month),
      maturityYear: bqVal(r.maturity_year),
      installmentCount: installmentCountByEnrollment.get(id) || 0,
      paidInstallmentCount: paidCountByEnrollment.get(id) || 0,
      overdueCount: overdue.count,
      overdueAmount: round2(overdue.amount),
      maxOverdueDays: overdue.maxDays,
      oldestOverdueDueDate: overdue.oldestDueDate,
      lastPaidDate: lastPaidDateByEnrollment.get(id) || null,
      nextDueDate: nextDue ? nextDue.dueDate : null,
      nextDueAmount: nextDue ? round2(nextDue.amount) : null,
    };
    enrollment.status = deriveStatus(enrollment);
    enrollment.maturityKey = enrollment.maturityYear && enrollment.maturityMonth
      ? `${enrollment.maturityYear}-${String(enrollment.maturityMonth).padStart(2, '0')}`
      : null;
    return enrollment;
  });

  return {
    generatedAt: new Date().toISOString(),
    asOfDate: today,
    enrollments,
    installments,
    payments,
  };
}

module.exports = { buildSchemeDashboard };
