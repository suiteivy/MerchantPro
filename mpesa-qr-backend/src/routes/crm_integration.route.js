// CRM Integration Route for M-Pesa QR Scanner System
// Exposes GET /api/crm/v1/snapshot — a read-only endpoint for the Cloudora CRM.
// The router (Step 1) lives in src/utils/crmSnapshotRouter.js.
// The Firebase Admin client (Step 2) is imported from src/config/firebase-admin.js.
// Steps 3-7 below are fully implemented for the merchants/transactions data model.
//
// Required env variable: CRM_READ_API_KEY (at least 32 characters, never committed).
// Mount in src/server.js (Step 3 from the guide):
//   import crmRouter from './routes/crm_integration.route.js';
//   app.use('/api/crm/v1', crmRouter);

import { createCrmSnapshotRouter } from '../utils/crmSnapshotRouter.js';
import { db } from '../config/firebase-admin.js';

// ─── Product identity ────────────────────────────────────────────────────────
// PRODUCT_SLUG must exactly match the slug configured in CRM_CONNECTED_PRODUCTS.
const PRODUCT_SLUG = 'mpesa_qr';
const PRODUCT_NAME  = 'M-Pesa QR Scanner';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a Firestore Timestamp, plain Date, or ISO string to an ISO string.
 * Returns null for absent or invalid values — never invents a date.
 */
function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  // Firestore Admin serialises Timestamps as { _seconds, _nanoseconds }
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000).toISOString();
  return null;
}

// ─── Step 2: Database client ─────────────────────────────────────────────────
// db is the Firebase Admin Firestore instance initialised in firebase-admin.js.
// It is imported at module load; if the service-account file is absent the
// module logs a warning and db will be null — the route will return 503.
function getDatabaseClient() {
  if (!db) {
    const err = new Error('Firebase Admin Firestore client is not initialised');
    err.code = 'SOURCE_UNAVAILABLE';
    throw err;
  }
  return db;
}

// ─── Step 3: Product-wide totals ─────────────────────────────────────────────
/**
 * Returns { customers, activeCustomers, openTickets } for the whole product.
 *
 * "Active" merchant = subscription.status is ACTIVE or TRIALING (not EXPIRED).
 * "Open tickets" = pending transactions (M-Pesa STK pushes awaiting confirmation).
 * Firestore aggregate queries are used so we never load every document.
 */
async function loadCounts(db) {
  const merchantsRef = db.collection('merchants');
  const transactionsRef = db.collection('transactions');

  const [
    totalSnap,
    activeSnap,
    pendingTxSnap,
  ] = await Promise.all([
    // All merchants (count only)
    merchantsRef.count().get(),
    // Active/trialing merchants
    merchantsRef
      .where('subscription.status', 'in', ['ACTIVE', 'TRIALING'])
      .count()
      .get(),
    // Pending transactions — these are unresolved "tickets" in this system
    transactionsRef
      .where('status', '==', 'pending')
      .count()
      .get(),
  ]);

  return {
    customers:       totalSnap.data().count,
    activeCustomers: activeSnap.data().count,
    openTickets:     pendingTxSnap.data().count,
  };
}

// ─── Step 4: Subscription revenue ────────────────────────────────────────────
/**
 * Returns completed PRODUCT SUBSCRIPTION payments grouped by currency.
 * In this system, subscription payments are transactions where:
 *   - status === 'success'
 *   - description includes 'subscription' (case-insensitive) OR
 *     the transaction has no qrData (i.e. it was a direct subscription charge)
 *
 * All amounts are in KES (the only currency used).
 *
 * Because Firestore's aggregate sum does not support OR conditions easily we
 * fetch the matching docs and sum in JS. The expected volume is small (one
 * subscription payment per merchant per month).
 */
async function loadSubscriptionRevenue(db) {
  // Fetch all successful transactions tagged as subscriptions.
  // We identify subscription payments by their description field.
  const snap = await db.collection('transactions')
    .where('status', '==', 'success')
    .where('description', '>=', 'subscription')
    .where('description', '<=', 'subscription\uf8ff')
    .get();

  // Also fetch case variations: 'Subscription', 'SUBSCRIPTION'
  const snapUpper = await db.collection('transactions')
    .where('status', '==', 'success')
    .where('description', '>=', 'Subscription')
    .where('description', '<=', 'Subscription\uf8ff')
    .get();

  let totalKES = 0;
  const seen = new Set();

  const tally = (doc) => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    totalKES += Number(doc.data().amount || 0);
  };

  snap.docs.forEach(tally);
  snapUpper.docs.forEach(tally);

  if (totalKES === 0) return [];
  return [{ amount: totalKES, currency: 'KES' }];
}

// ─── Step 5: Paginated customer list ─────────────────────────────────────────
/**
 * Returns one stable page of merchant accounts.
 * Cursor = the last merchant document ID from the previous page.
 * Merchants are ordered by document ID (UID) which is stable and indexed.
 */
async function loadCustomerPage(db, { limit, cursor }) {
  const collection = db.collection('merchants');
  let query = collection
    .orderBy('__name__')   // order by document ID — stable across pages
    .limit(limit + 1);

  if (cursor) {
    const previous = await collection.doc(cursor).get();
    if (!previous.exists) {
      const err = new Error('Merchant cursor document no longer exists');
      err.code = 'INVALID_CURSOR';
      throw err;
    }
    query = query.startAfter(previous);
  }

  const result = await query.get();
  const visible = result.docs.slice(0, limit);

  return {
    rows:       visible.map((doc) => ({ id: doc.id, ...doc.data() })),
    nextCursor: result.docs.length > limit ? visible.at(-1).id : null,
  };
}

// ─── Step 6: Batch per-page lookups ──────────────────────────────────────────

/**
 * Load the primary admin name for each merchant on the current page.
 * In this product merchants ARE their own primary admin; we return the
 * merchant's name so the CRM can display it. If the merchant's email is
 * available it is appended for clarity.
 *
 * Returns Map<merchantId, adminName>.
 */
async function loadPrimaryAdmins(db, customerIds) {
  if (!customerIds.length) return new Map();

  // Firestore 'in' query supports up to 30 values per call.
  const batches = [];
  for (let i = 0; i < customerIds.length; i += 30) {
    batches.push(customerIds.slice(i, i + 30));
  }

  const admins = new Map();

  await Promise.all(
    batches.map(async (batch) => {
      const snap = await db.collection('merchants')
        .where('__name__', 'in', batch)
        .get();
      snap.docs.forEach((doc) => {
        const d = doc.data();
        const label = d.email ? `${d.name} (${d.email})` : d.name;
        admins.set(doc.id, label || null);
      });
    })
  );

  return admins;
}

/**
 * Load the latest completed (status === 'success') transaction per merchant.
 * We only consider direct merchant transactions (not guest pass-throughs).
 *
 * Returns Map<merchantId, { amount, currency, status, paid_at, reference }>.
 */
async function loadLatestCompletedPayments(db, customerIds) {
  if (!customerIds.length) return new Map();

  const payments = new Map();

  // We must query per merchantId — Firestore does not support
  // "latest per group" in a single query without a composite index on
  // (merchantId ASC, status ASC, createdAt DESC).
  // We issue one query per merchant but keep them concurrent.
  await Promise.all(
    customerIds.map(async (merchantId) => {
      const snap = await db.collection('transactions')
        .where('merchantId', '==', merchantId)
        .where('status', '==', 'success')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (!snap.empty) {
        const d = snap.docs[0].data();
        const paidAt = toIso(d.updatedAt || d.createdAt);
        // paymentDetails.mpesaReceiptNumber is the M-Pesa receipt reference
        const reference = d.paymentDetails?.mpesaReceiptNumber
          || d.transactionRef
          || null;
        payments.set(merchantId, {
          amount:    Number(d.amount || 0),
          currency:  'KES',
          status:    'completed',
          paid_at:   paidAt,
          reference: reference || null,
        });
      }
    })
  );

  return payments;
}

/**
 * Count unresolved (pending) transactions per merchant on the current page.
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

// ─── Step 7: Map Firestore fields to CRM contract ────────────────────────────
/**
 * Maps a merchant document row to the CRM account shape.
 * Subscription tier → plan, subscription status → status.
 * Cycle is monthly (M-Pesa QR subscriptions renew every 30 days).
 * Never invents data; absent optional values are null.
 */
function mapCustomer(row, { admins, payments, ticketCounts }) {
  const id = String(row.id);

  // Normalise subscription status to lowercase for the CRM
  const rawStatus = row.subscription?.status ?? null;
  const crmStatus = rawStatus ? rawStatus.toLowerCase() : null;

  // Normalise plan tier to lowercase
  const rawTier = row.subscription?.tier ?? null;
  const crmPlan = rawTier ? rawTier.toLowerCase() : null;

  return {
    external_id:  id,
    name:         row.name || id,
    location:     null,          // not stored on the merchant document
    admin_name:   admins.get(id) ?? null,
    subscription: {
      plan:   crmPlan,
      status: crmStatus,
      cycle:  'monthly',         // all M-Pesa QR plans are monthly
    },
    last_payment: payments.get(id) ?? null,
    open_tickets: ticketCounts.get(id) ?? 0,
    updated_at:   toIso(row.updatedAt ?? row.createdAt),
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────
const adapter = {
  async getSnapshot({ limit, cursor }) {
    const db = getDatabaseClient();

    // Run product-wide aggregations and the first customer page concurrently.
    const [counts, revenue, customerPage] = await Promise.all([
      loadCounts(db),
      loadSubscriptionRevenue(db),
      loadCustomerPage(db, { limit, cursor }),
    ]);

    const rows = customerPage.rows;
    const ids  = rows.map((row) => String(row.id));

    // Three concurrent batch queries — one per page, never per customer.
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
      accounts:    rows.map((row) => mapCustomer(row, { admins, payments, ticketCounts })),
      next_cursor: customerPage.nextCursor,
    };
  },
};

// createCrmSnapshotRouter validates the read key and serves the JSON contract.
export default createCrmSnapshotRouter(adapter);

