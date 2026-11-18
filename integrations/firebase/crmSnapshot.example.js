// Firebase Cloud Functions v2 example. Copy into your functions source folder.
// Complete every CHANGE ME section before deploying. No Supabase SDK is used.
const crypto = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { FieldPath, getFirestore } = require('firebase-admin/firestore');

initializeApp();
const crmReadKey = defineSecret('CRM_READ_API_KEY');

// CHANGE ME 1: Set the CRM slug and display name for this product.
const PRODUCT_SLUG = 'change_me';
const PRODUCT_NAME = 'Change Me';
// CHANGE ME 2: Name the Firestore collection that owns customer accounts.
const CUSTOMER_COLLECTION = 'change_me_customers';

// Until every query is implemented, return ADAPTER_INCOMPLETE.
function unfinished(task) {
  const error = new Error(`CHANGE ME: ${task}`);
  error.code = 'ADAPTER_INCOMPLETE';
  throw error;
}

function matchesKey(supplied, expected) {
  if (!supplied || !expected) return false;
  const left = crypto.createHash('sha256').update(supplied).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function isDate(value) {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function validMoney(value) {
  return value && Number.isFinite(value.amount) && value.amount >= 0 &&
    typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency);
}

function validAccount(account) {
  return account && typeof account.external_id === 'string' && account.external_id.length > 0 &&
    typeof account.name === 'string' && account.name.length > 0 &&
    (account.location === null || typeof account.location === 'string') &&
    (account.admin_name === null || typeof account.admin_name === 'string') &&
    account.subscription &&
    ['plan', 'status', 'cycle'].every((field) =>
      account.subscription[field] === null || typeof account.subscription[field] === 'string') &&
    (account.last_payment === null || (
      validMoney(account.last_payment) && account.last_payment.status === 'completed' &&
      isDate(account.last_payment.paid_at) &&
      (account.last_payment.reference === null || typeof account.last_payment.reference === 'string')
    )) &&
    Number.isSafeInteger(account.open_tickets) && account.open_tickets >= 0 &&
    isDate(account.updated_at);
}

function invalidSnapshotField(snapshot, limit) {
  if (!snapshot || !snapshot.product || !snapshot.summary || !Array.isArray(snapshot.accounts)) return 'snapshot';
  const { product, summary, accounts, next_cursor } = snapshot;
  if (typeof product.external_id !== 'string' || !product.external_id ||
      typeof product.name !== 'string' || !product.name) return 'product';
  if (!Number.isSafeInteger(summary.customer_count) || summary.customer_count < 0 ||
      !Number.isSafeInteger(summary.active_customer_count) || summary.active_customer_count < 0 ||
      !Number.isSafeInteger(summary.open_tickets) || summary.open_tickets < 0 ||
      !Array.isArray(summary.subscription_revenue) ||
      !summary.subscription_revenue.every(validMoney)) return 'summary';
  if (accounts.length > limit) return 'accounts.length';
  const badIndex = accounts.findIndex((account) => !validAccount(account));
  if (badIndex !== -1) return `accounts[${badIndex}]`;
  if (next_cursor !== null && typeof next_cursor !== 'string') return 'next_cursor';
  return null;
}

function requestId(req) {
  const supplied = req.get('x-request-id');
  return supplied && /^[A-Za-z0-9_-]{8,64}$/.test(supplied)
    ? supplied : crypto.randomUUID();
}

function failure(res, status, code, error, id) {
  return res.status(status).json({ code, error, request_id: id });
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

// CHANGE ME 3: Read product-wide totals from your Firestore collections.
// Return { customers: number, activeCustomers: number, openTickets: number }.
async function loadCounts(db) {
  unfinished('count all customers, active customers, and open tickets');
}

// CHANGE ME 4: Sum completed PRODUCT SUBSCRIPTION payments by currency.
// Return [{ amount: 120000, currency: 'KES' }, ...] or [] when none.
async function loadSubscriptionRevenue(db) {
  unfinished('aggregate completed product subscription revenue');
}

// Firestore paging example. Change CUSTOMER_COLLECTION above to your collection.
// The document ID is a stable cursor; rows contain { id, ...documentFields }.
async function loadCustomerPage(db, { limit, cursor }) {
  const collection = db.collection(CUSTOMER_COLLECTION);
  let query = collection.orderBy(FieldPath.documentId()).limit(limit + 1);
  if (cursor) {
    const previous = await collection.doc(cursor).get();
    if (!previous.exists) {
      const error = new Error('Customer cursor no longer exists');
      error.code = 'INVALID_CURSOR';
      throw error;
    }
    query = query.startAfter(previous);
  }
  const result = await query.get();
  const visible = result.docs.slice(0, limit);
  return {
    rows: visible.map((doc) => ({ ...doc.data(), id: doc.id })),
    nextCursor: result.docs.length > limit ? visible.at(-1).id : null,
  };
}

// CHANGE ME 5: Query these per-page details in batches. Return Maps keyed by
// String(customer ID), and an empty Map when a detail does not exist.
// Payment values: { amount, currency, status: 'completed', paid_at, reference }.
// paid_at may be a Firestore Timestamp; mapCustomer converts it to ISO.
async function loadPrimaryAdmins(db, customerIds) {
  unfinished('load primary admin names for this customer page');
}
async function loadLatestCompletedPayments(db, customerIds) {
  unfinished('load latest completed product subscription payments');
}
async function loadOpenTicketCounts(db, customerIds) {
  unfinished('load unresolved ticket counts for this customer page');
}

// CHANGE ME 6: Map your Firestore document fields to the CRM contract.
// Firestore Timestamp fields must be converted to ISO strings with toIso().
function mapCustomer(row, { admins, payments, ticketCounts }) {
  const id = String(row.id);
  const payment = payments.get(id);
  return {
    external_id: id,
    name: row.name,
    location: row.location ?? null,
    admin_name: admins.get(id) ?? null,
    subscription: {
      plan: row.subscription_plan ?? null,
      status: row.subscription_status ?? null,
      cycle: row.subscription_cycle ?? null,
    },
    last_payment: payment ? { ...payment, paid_at: toIso(payment.paid_at) } : null,
    open_tickets: ticketCounts.get(id) ?? 0,
    updated_at: toIso(row.updated_at ?? row.created_at),
  };
}

async function buildSnapshot(db, { limit, cursor }) {
  const [counts, revenue, page] = await Promise.all([
    loadCounts(db), loadSubscriptionRevenue(db), loadCustomerPage(db, { limit, cursor }),
  ]);
  const ids = page.rows.map((row) => String(row.id));
  const [admins, payments, ticketCounts] = ids.length
    ? await Promise.all([
        loadPrimaryAdmins(db, ids), loadLatestCompletedPayments(db, ids),
        loadOpenTicketCounts(db, ids),
      ])
    : [new Map(), new Map(), new Map()];
  return {
    product: { external_id: PRODUCT_SLUG, name: PRODUCT_NAME },
    summary: {
      customer_count: counts.customers,
      active_customer_count: counts.activeCustomers,
      open_tickets: counts.openTickets,
      subscription_revenue: revenue,
    },
    accounts: page.rows.map((row) => mapCustomer(row, { admins, payments, ticketCounts })),
    next_cursor: page.nextCursor,
  };
}

// Cloud Functions exports this as an HTTPS endpoint. Configure its FULL
// deployed URL in CRM_PRODUCT_<SLUG>_URL; Firebase chooses the URL path.
exports.crmSnapshot = onRequest({ secrets: [crmReadKey] }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = requestId(req);
  res.set('X-Request-Id', id);
  if (req.method !== 'GET') {
    res.set('Allow', 'GET');
    return failure(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET for this endpoint', id);
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = crmReadKey.value();
  if (!expected || expected.length < 32) {
    console.error('[CRM snapshot]', { request_id: id, code: 'INTEGRATION_NOT_CONFIGURED' });
    return failure(res, 503, 'INTEGRATION_NOT_CONFIGURED', 'CRM read key is not configured', id);
  }
  if (!matchesKey(token, expected)) {
    return failure(res, 401, 'READ_KEY_INVALID', 'Unauthorized', id);
  }

  const rawLimit = req.query.limit ?? '50';
  const limit = Number(rawLimit);
  const cursor = req.query.cursor ?? null;
  if (typeof rawLimit !== 'string' || !/^([1-9]|[1-9][0-9]|100)$/.test(rawLimit) ||
      (cursor !== null && (typeof cursor !== 'string' || !cursor ||
        cursor.length > 512 || cursor.includes('/')))) {
    return failure(res, 400, 'INVALID_PAGINATION', 'Invalid limit or cursor', id);
  }
  try {
    const snapshot = await buildSnapshot(getFirestore(), { limit, cursor });
    const field = invalidSnapshotField(snapshot, limit);
    if (field) {
      console.error('[CRM snapshot]', { request_id: id, code: 'INVALID_SNAPSHOT', field });
      return failure(res, 502, 'INVALID_SNAPSHOT', 'Product adapter returned an invalid snapshot', id);
    }
    return res.json({ ...snapshot, schema_version: 1, generated_at: new Date().toISOString() });
  } catch (error) {
    const code = error?.code === 'INVALID_CURSOR' ? 'INVALID_CURSOR'
      : error?.code === 'ADAPTER_INCOMPLETE' ? 'ADAPTER_INCOMPLETE' : 'SOURCE_UNAVAILABLE';
    console.error('[CRM snapshot]', {
      request_id: id, code, source_code: String(error?.code || '').slice(0, 64),
      message: String(error?.message || error).slice(0, 500),
    });
    return failure(res, code === 'INVALID_CURSOR' ? 400 : 503, code,
      code === 'INVALID_CURSOR' ? 'Cursor is no longer valid' : 'Snapshot temporarily unavailable', id);
  }
});
