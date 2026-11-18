// Firebase Cloud Functions v2 — CRM Snapshot for M-Pesa QR Scanner System.
//
// This is an ALTERNATIVE to the Express route when you want a standalone
// Cloud Function (no Express server.js needed). Deploy with:
//   firebase deploy --only functions:crmSnapshot
//
// Steps completed below:
//   1  Product slug / name set to match CRM configuration.
//   2  Firestore collection = 'merchants'.
//   3  loadCounts: total merchants, active/trialing merchants, pending transactions.
//   4  loadSubscriptionRevenue: completed success transactions tagged 'subscription'.
//   5  Batch per-page lookups: admins, payments, ticket counts.
//   6  mapCustomer: maps Firestore fields → CRM contract fields.
//
// Required:
//   firebase functions:secrets:set CRM_READ_API_KEY
//   Then deploy. CRM uses the full HTTPS function URL.

import crypto from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialise Firebase Admin only once (safe for Cloud Functions cold starts).
if (!getApps().length) initializeApp();

const crmReadKey = defineSecret('CRM_READ_API_KEY');

// ─── Step 1: Product identity ─────────────────────────────────────────────────
const PRODUCT_SLUG        = 'mpesa_qr';
const PRODUCT_NAME        = 'M-Pesa QR Scanner';

// ─── Step 2: Firestore collection ────────────────────────────────────────────
const MERCHANT_COLLECTION = 'merchants';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchesKey(supplied, expected) {
  if (!supplied || !expected) return false;
  const left  = crypto.createHash('sha256').update(supplied).digest();
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

/**
 * Convert a Firestore Timestamp or Date to an ISO string.
 * Returns null for absent or unrecognised values.
 */
function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000).toISOString();
  return null;
}

// ─── Step 3: Product-wide totals ──────────────────────────────────────────────
/**
 * Returns { customers, activeCustomers, openTickets }.
 * "Active" = subscription.status in [ACTIVE, TRIALING].
 * "Open tickets" = pending transactions (unconfirmed STK pushes).
 */
async function loadCounts(db) {
  const merchantsRef    = db.collection(MERCHANT_COLLECTION);
  const transactionsRef = db.collection('transactions');

  const [totalSnap, activeSnap, pendingSnap] = await Promise.all([
    merchantsRef.count().get(),
    merchantsRef
      .where('subscription.status', 'in', ['ACTIVE', 'TRIALING'])
      .count()
      .get(),
    transactionsRef
      .where('status', '==', 'pending')
      .count()
      .get(),
  ]);

  return {
    customers:       totalSnap.data().count,
    activeCustomers: activeSnap.data().count,
    openTickets:     pendingSnap.data().count,
  };
}

// ─── Step 4: Subscription revenue ─────────────────────────────────────────────
/**
 * Sums completed subscription transactions by currency (KES only).
 * Subscription payments have a description starting with 'subscription'
 * or 'Subscription'. We fetch both prefix ranges and deduplicate.
 */
async function loadSubscriptionRevenue(db) {
  const [snapLower, snapUpper] = await Promise.all([
    db.collection('transactions')
      .where('status', '==', 'success')
      .where('description', '>=', 'subscription')
      .where('description', '<=', 'subscription\uf8ff')
      .get(),
    db.collection('transactions')
      .where('status', '==', 'success')
      .where('description', '>=', 'Subscription')
      .where('description', '<=', 'Subscription\uf8ff')
      .get(),
  ]);

  let totalKES = 0;
  const seen   = new Set();

  const tally = (doc) => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    totalKES += Number(doc.data().amount || 0);
  };
  snapLower.docs.forEach(tally);
  snapUpper.docs.forEach(tally);

  return totalKES > 0 ? [{ amount: totalKES, currency: 'KES' }] : [];
}

// ─── Paginated customer list ───────────────────────────────────────────────────
/**
 * Returns one stable page of merchant documents ordered by document ID.
 * The document ID (Firebase UID) is used as the opaque cursor.
 */
async function loadCustomerPage(db, { limit, cursor }) {
  const collection = db.collection(MERCHANT_COLLECTION);
  let query = collection.orderBy('__name__').limit(limit + 1);

  if (cursor) {
    const previous = await collection.doc(cursor).get();
    if (!previous.exists) {
      const err = new Error('Merchant cursor document no longer exists');
      err.code = 'INVALID_CURSOR';
      throw err;
    }
    query = query.startAfter(previous);
  }

  const result  = await query.get();
  const visible = result.docs.slice(0, limit);

  return {
    rows:       visible.map((doc) => ({ id: doc.id, ...doc.data() })),
    nextCursor: result.docs.length > limit ? visible.at(-1).id : null,
  };
}

// ─── Step 5: Batch per-page lookups ───────────────────────────────────────────

/**
 * Load the merchant's own name as the primary admin label.
 * Returns Map<merchantId, label>.
 */
async function loadPrimaryAdmins(db, customerIds) {
  if (!customerIds.length) return new Map();
  const admins  = new Map();
  const batches = [];
  for (let i = 0; i < customerIds.length; i += 30) batches.push(customerIds.slice(i, i + 30));

  await Promise.all(
    batches.map(async (batch) => {
      const snap = await db.collection(MERCHANT_COLLECTION)
        .where('__name__', 'in', batch)
        .get();
      snap.docs.forEach((doc) => {
        const d = doc.data();
        admins.set(doc.id, d.email ? `${d.name} (${d.email})` : (d.name || null));
      });
    })
  );
  return admins;
}

/**
 * Load the most recent successful transaction per merchant.
 * Returns Map<merchantId, { amount, currency, status, paid_at, reference }>.
 */
async function loadLatestCompletedPayments(db, customerIds) {
  if (!customerIds.length) return new Map();
  const payments = new Map();

  await Promise.all(
    customerIds.map(async (merchantId) => {
      const snap = await db.collection('transactions')
        .where('merchantId', '==', merchantId)
        .where('status', '==', 'success')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (!snap.empty) {
        const d   = snap.docs[0].data();
        payments.set(merchantId, {
          amount:    Number(d.amount || 0),
          currency:  'KES',
          status:    'completed',
          paid_at:   toIso(d.updatedAt ?? d.createdAt),
          reference: d.paymentDetails?.mpesaReceiptNumber ?? d.transactionRef ?? null,
        });
      }
    })
  );

  return payments;
}

/**
 * Count pending transactions (open tickets) per merchant.
 * Returns Map<merchantId, count>.
 */
async function loadOpenTicketCounts(db, customerIds) {
  if (!customerIds.length) return new Map();
  const ticketCounts = new Map();

  await Promise.all(
    customerIds.map(async (merchantId) => {
      const snap = await db.collection('transactions')
        .where('merchantId', '==', merchantId)
        .where('status', '==', 'pending')
        .count()
        .get();
      const count = snap.data().count;
      if (count > 0) ticketCounts.set(merchantId, count);
    })
  );

  return ticketCounts;
}

// ─── Step 6: Map Firestore fields → CRM contract ──────────────────────────────
/**
 * Maps a merchant document row to the CRM account shape.
 * Firestore Timestamps are converted to ISO strings via toIso().
 */
function mapCustomer(row, { admins, payments, ticketCounts }) {
  const id      = String(row.id);
  const payment = payments.get(id);

  return {
    external_id:  id,
    name:         row.name || id,
    location:     null,
    admin_name:   admins.get(id) ?? null,
    subscription: {
      plan:   row.subscription?.tier   ? row.subscription.tier.toLowerCase()   : null,
      status: row.subscription?.status ? row.subscription.status.toLowerCase() : null,
      cycle:  'monthly',
    },
    last_payment: payment
      ? { ...payment, paid_at: toIso(payment.paid_at) }
      : null,
    open_tickets: ticketCounts.get(id) ?? 0,
    updated_at:   toIso(row.updatedAt ?? row.createdAt),
  };
}

// ─── Snapshot builder ─────────────────────────────────────────────────────────
async function buildSnapshot(db, { limit, cursor }) {
  const [counts, revenue, page] = await Promise.all([
    loadCounts(db),
    loadSubscriptionRevenue(db),
    loadCustomerPage(db, { limit, cursor }),
  ]);

  const ids = page.rows.map((row) => String(row.id));
  const [admins, payments, ticketCounts] = ids.length
    ? await Promise.all([
        loadPrimaryAdmins(db, ids),
        loadLatestCompletedPayments(db, ids),
        loadOpenTicketCounts(db, ids),
      ])
    : [new Map(), new Map(), new Map()];

  return {
    product: { external_id: PRODUCT_SLUG, name: PRODUCT_NAME },
    summary: {
      customer_count:        counts.customers,
      active_customer_count: counts.activeCustomers,
      open_tickets:          counts.openTickets,
      subscription_revenue:  revenue,
    },
    accounts:    page.rows.map((row) => mapCustomer(row, { admins, payments, ticketCounts })),
    next_cursor: page.nextCursor,
  };
}

// ─── Cloud Function export ────────────────────────────────────────────────────
// CRM calls this function's full HTTPS URL directly (no /snapshot suffix).
export const crmSnapshot = onRequest({ secrets: [crmReadKey] }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = requestId(req);
  res.set('X-Request-Id', id);

  if (req.method !== 'GET') {
    res.set('Allow', 'GET');
    return failure(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET for this endpoint', id);
  }

  const header   = req.get('authorization') || '';
  const token    = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = crmReadKey.value();

  if (!expected || expected.length < 32) {
    console.error('[CRM snapshot]', { request_id: id, code: 'INTEGRATION_NOT_CONFIGURED' });
    return failure(res, 503, 'INTEGRATION_NOT_CONFIGURED', 'CRM read key is not configured', id);
  }
  if (!matchesKey(token, expected)) {
    return failure(res, 401, 'READ_KEY_INVALID', 'Unauthorized', id);
  }

  const rawLimit = req.query.limit ?? '50';
  const limit    = Number(rawLimit);
  const cursor   = req.query.cursor ?? null;

  if (
    typeof rawLimit !== 'string' ||
    !/^([1-9]|[1-9][0-9]|100)$/.test(rawLimit) ||
    (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 512 || cursor.includes('/')))
  ) {
    return failure(res, 400, 'INVALID_PAGINATION', 'Invalid limit or cursor', id);
  }

  try {
    const snapshot = await buildSnapshot(getFirestore(), { limit, cursor });
    const field    = invalidSnapshotField(snapshot, limit);
    if (field) {
      console.error('[CRM snapshot]', { request_id: id, code: 'INVALID_SNAPSHOT', field });
      return failure(res, 502, 'INVALID_SNAPSHOT', 'Product adapter returned an invalid snapshot', id);
    }
    return res.json({ ...snapshot, schema_version: 1, generated_at: new Date().toISOString() });
  } catch (error) {
    const code = error?.code === 'INVALID_CURSOR'    ? 'INVALID_CURSOR'
               : error?.code === 'ADAPTER_INCOMPLETE' ? 'ADAPTER_INCOMPLETE'
               : 'SOURCE_UNAVAILABLE';
    console.error('[CRM snapshot]', {
      request_id: id,
      code,
      source_code: String(error?.code  || '').slice(0, 64),
      message:     String(error?.message || error).slice(0, 500),
    });
    return failure(
      res,
      code === 'INVALID_CURSOR' ? 400 : 503,
      code,
      code === 'INVALID_CURSOR' ? 'Cursor is no longer valid' : 'Snapshot temporarily unavailable',
      id,
    );
  }
});

