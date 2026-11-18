// CRM Snapshot Router — copied from integrations/express/crmSnapshotRouter.example.js
// Drop into an Express product backend and mount as shown in
// integrations/product-connection.md. Node 18+ and Express are required.
// This file must not be changed; all product-specific logic lives in
// src/routes/crm_integration.route.js.
import crypto from 'node:crypto';
import express from 'express';

const { Router } = express;

function matchesKey(supplied, expected) {
  if (!supplied || !expected) return false;
  // Hash before comparing so different key lengths do not leak through timing.
  const left = crypto.createHash('sha256').update(supplied).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validMoney(value) {
  return value === null || (
    value && Number.isFinite(value.amount) && value.amount >= 0 &&
    typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)
  );
}

function validAccount(account) {
  return account && typeof account.external_id === 'string' && account.external_id.length > 0 &&
    typeof account.name === 'string' && account.name.length > 0 &&
    (account.location === null || typeof account.location === 'string') &&
    (account.admin_name === null || typeof account.admin_name === 'string') &&
    account.subscription && (account.subscription.plan === null || typeof account.subscription.plan === 'string') &&
    (account.subscription.status === null || typeof account.subscription.status === 'string') &&
    (account.subscription.cycle === null || typeof account.subscription.cycle === 'string') &&
    (account.last_payment === null || (
      validMoney(account.last_payment) &&
      typeof account.last_payment.status === 'string' &&
      (account.last_payment.paid_at === null || validDate(account.last_payment.paid_at)) &&
      (account.last_payment.reference === null || typeof account.last_payment.reference === 'string')
    )) &&
    Number.isSafeInteger(account.open_tickets) && account.open_tickets >= 0 &&
    (account.updated_at === null || validDate(account.updated_at));
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
      !summary.subscription_revenue.every((value) => value !== null && validMoney(value))) return 'summary';
  if (accounts.length > limit) return 'accounts.length';
  const badIndex = accounts.findIndex((account) => !validAccount(account));
  if (badIndex !== -1) return `accounts[${badIndex}]`;
  if (next_cursor !== null && typeof next_cursor !== 'string') return 'next_cursor';
  return null;
}

function requestId(req) {
  const supplied = req.get('x-request-id');
  // Reuse CRM's safe identifier so both servers can find the same request.
  return supplied && /^[A-Za-z0-9_-]{8,64}$/.test(supplied)
    ? supplied : crypto.randomUUID();
}

function failure(res, status, code, error, id) {
  return res.status(status).json({ code, error, request_id: id });
}

/**
 * The adapter MUST query this product's live database. It receives { limit,
 * cursor } and returns the contract documented in product-connection.md.
 * Do not fill missing data with invented values; use null for optional fields.
 */
export function createCrmSnapshotRouter(adapter, options = {}) {
  if (!adapter || typeof adapter.getSnapshot !== 'function') {
    throw new TypeError('An adapter with getSnapshot({ limit, cursor }) is required');
  }
  const router = Router();
  const readKey = options.readKey || process.env.CRM_READ_API_KEY;

  router.get('/snapshot', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = requestId(req);
    res.set('X-Request-Id', id);
    if (!readKey || readKey.length < 32) {
      console.error('[CRM snapshot]', { request_id: id, code: 'INTEGRATION_NOT_CONFIGURED' });
      return failure(res, 503, 'INTEGRATION_NOT_CONFIGURED', 'CRM read key is not configured', id);
    }
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!matchesKey(token, readKey)) {
      return failure(res, 401, 'READ_KEY_INVALID', 'Unauthorized', id);
    }

    const rawLimit = req.query.limit ?? '50';
    const limit = Number(rawLimit);
    const cursor = req.query.cursor ?? null;
    if (typeof rawLimit !== 'string' || !/^([1-9]|[1-9][0-9]|100)$/.test(rawLimit) ||
        (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 512))) {
      return failure(res, 400, 'INVALID_PAGINATION', 'Invalid limit or cursor', id);
    }

    try {
      // Read current records on every request. The adapter should page accounts
      // with a stable cursor and use indexed queries; never load all customers.
      const snapshot = await adapter.getSnapshot({ limit, cursor });
      const field = invalidSnapshotField(snapshot, limit);
      if (field) {
        console.error('[CRM snapshot]', { request_id: id, code: 'INVALID_SNAPSHOT', field });
        return failure(res, 502, 'INVALID_SNAPSHOT', 'Product adapter returned an invalid snapshot', id);
      }
      return res.json({ ...snapshot, schema_version: 1, generated_at: new Date().toISOString() });
    } catch (error) {
      // Keep vendor error details in server logs. CRM can report this request ID.
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

  router.all('/snapshot', (req, res) => {
    const id = requestId(req);
    res.set('Cache-Control', 'no-store');
    res.set('X-Request-Id', id);
    res.set('Allow', 'GET');
    return failure(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET for this endpoint', id);
  });

  return router;
}

