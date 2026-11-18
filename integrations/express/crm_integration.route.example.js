// Copy this file to backend/routes/crm_integration.route.js.
// Complete every CHANGE ME section before deploying the product backend.
const { createCrmSnapshotRouter } = require('../utils/crmSnapshotRouter.js');

// Unfinished queries return a clear code instead of invented data.
function unfinished(task) {
  const error = new Error(`CHANGE ME: ${task}`);
  error.code = 'ADAPTER_INCOMPLETE';
  throw error;
}

// CHANGE ME 1: Use the lowercase slug configured in CRM_CONNECTED_PRODUCTS.
// Example: 'stocksense'. The CRM rejects a different product.external_id.
const PRODUCT_SLUG = 'change_me';
const PRODUCT_NAME = 'Change Me';

// CHANGE ME 2: Return THIS product's existing server-side database client.
// Return your existing server-side client (SQL, Firebase Admin, etc.).
// Keep database secret keys on this server; CRM only uses the read key.
function getDatabaseClient() {
  unfinished('connect this route to the product database');
}

// CHANGE ME 3: Query product-wide totals, not just the current page.
// Return { customers: number, activeCustomers: number, openTickets: number }.
// Count unresolved support tickets using this product's actual status values.
async function loadCounts(db) {
  unfinished('query total customers, active customers, and open tickets');
}

// CHANGE ME 4: Sum COMPLETED PRODUCT SUBSCRIPTION payments by currency.
// Return [{ amount: number, currency: 'KES' }, ...] or [] if none.
// Do not include school fees, user purchases, or pending payments.
async function loadSubscriptionRevenue(db) {
  unfinished('query completed product subscription revenue');
}

// CHANGE ME 5: Page product customers using a stable database order.
// Return { rows: customerRows, nextCursor: string | null }.
// Read at most limit + 1 rows, return at most limit, and set nextCursor only
// when another page exists. Treat cursor as an opaque value from the prior page.
// Map a customer to an institution, shop, business, or equivalent account.
// If a cursor no longer exists, throw an error with code 'INVALID_CURSOR'.
async function loadCustomerPage(db, { limit, cursor }) {
  unfinished('query one stable page of product customers');
}

// CHANGE ME 6: Batch the lookups for the current page.
// Each Map is keyed by String(customer.id). Return an empty Map for no match.
// payments values must be { amount, currency, status, paid_at, reference }.
async function loadPrimaryAdmins(db, customerIds) {
  unfinished('query primary admin names for this page');
}
async function loadLatestCompletedPayments(db, customerIds) {
  unfinished('query latest completed subscription payment per customer');
}
async function loadOpenTicketCounts(db, customerIds) {
  unfinished('query unresolved ticket counts per customer');
}

// CHANGE ME 7: Map your real customer column names to the CRM fields.
// Use null for optional data that does not exist; never invent a payment.
// Dates must be ISO strings. Keep external_id stable across requests.
function mapCustomer(row, { admins, payments, ticketCounts }) {
  const id = String(row.id);
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
    last_payment: payments.get(id) ?? null,
    open_tickets: ticketCounts.get(id) ?? 0,
    updated_at: row.updated_at ?? row.created_at ?? null,
  };
}

const adapter = {
  async getSnapshot({ limit, cursor }) {
    const db = getDatabaseClient();
    const [counts, revenue, customerPage] = await Promise.all([
      loadCounts(db),
      loadSubscriptionRevenue(db),
      loadCustomerPage(db, { limit, cursor }),
    ]);
    const rows = customerPage.rows;
    const ids = rows.map((row) => String(row.id));

    // Three batch queries are faster than a query for every customer.
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
        customer_count: counts.customers,
        active_customer_count: counts.activeCustomers,
        open_tickets: counts.openTickets,
        subscription_revenue: revenue,
      },
      accounts: rows.map((row) => mapCustomer(row, { admins, payments, ticketCounts })),
      next_cursor: customerPage.nextCursor,
    };
  },
};

// Appendix A checks the read key, validates this data, and serves JSON.
module.exports = createCrmSnapshotRouter(adapter);
