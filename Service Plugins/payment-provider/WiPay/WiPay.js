/**
 * @file WiPay.js
 * @description Core of the WiPay Payment Provider Service Plugin.
 *
 * Wix calls these functions at checkout time. The Wix-side surface (exact option shapes, the
 * hosted-page return property, the full submitEvent schema) is still confirmed only to the level
 * recorded in SERVICE-PLUGIN-CONTRACT-NOTES.md, and every such gap is flagged as a TODO below
 * rather than hard-coded from guesswork.
 *
 * The WiPay side of this file is real: payload construction, the Payment Request call, buyer-return
 * hash verification, webhook signature verification, and the WAPI refund call all go through
 * wipay-core.js, which the harness (tests/harness.mjs) cross-checks against Node's crypto and
 * exercises against the live TT sandbox.
 *
 * Hosted-page note: WiPay Payment Request returns a hosted checkout URL the buyer completes on
 * WiPay's page. Wix documents that hosted-page payment methods do NOT support 3D Secure
 * verification or recurring payments — that constraint applies here too.
 *
 * Sources for the WiPay contract used below:
 *   - Payments API / Payment Request: https://dev.wipay.com/docs/api/payments/operation/create-a-payment-request
 *   - Buyer return (response_url) and pin-hash verification:
 *     https://dev.wipay.com/docs/api/payments/introduction#buyer-return-response_url
 *   - Webhooks (HMAC, replay protection, dedupe):
 *     https://dev.wipay.com/docs/api/payments/introduction#webhooks
 *   - Refund (WAPI refund-request endpoint): https://dev.wipay.com/docs/api/wapi/introduction
 *
 * Wix redirection/hosted-page model (confirmed from Wix sample-payment-flows page):
 *   - Wix sends `order.returnUrls` (success / error / cancel / pending) in the Create Transaction request.
 *   - For hosted-page payments, the PSP returns `redirectUrl`; Wix opens that URL for the buyer.
 *   - Final status is delivered to Wix via Submit Event, not returned from Create Transaction.
 *   - Hard constraint: "Hosted-page payment methods don't support 3D Secure verification or
 *     recurring payments."
 *
 * TODO (exact Wix return / event shapes): the exact JSON passed into createTransaction() by Wix and
 * the exact properties Wix expects back are in Wix "Copy" code blocks that did not render into
 * extractable text; confirm from the live Wix reference before shipping. Do not hard-code.
 */

import {
  buildPaymentRequest as buildCorePayload,
  parseCheckoutResponse,
  paymentEndpoint,
  wapiEndpoint,
  wapiEnvironment,
  generateOrderId as coreGenerateOrderId,
  responseHash,
  verifyResponseHash,
  verifyWebhookSignature,
  isValidTransactionId,
} from './wipay-core.js';

// ---------------------------------------------------------------------------
// Runtime fetch.
//
// Node 18+ and modern server runtimes expose a global `fetch`. Velo's backend historically
// exposes `fetch` via the `wix-fetch` module instead.
// TODO (Velo runtime): confirm whether Velo backend provides a global fetch. If it does not,
// change this to `import { fetch } from 'wix-fetch'` and keep the rest of this file unchanged.
// ---------------------------------------------------------------------------
function runtimeFetch() {
  if (typeof fetch === 'function') {
    return fetch;
  }
  throw new Error(
    'No global fetch in this runtime. On Velo, import { fetch } from \'wix-fetch\' and pass it in.'
  );
}

// Allows the test harness to exercise these paths against a stubbed transport
// without a network. Production never calls this.
let transportOverride = null;
export function __setTransportForTests(fn) {
  transportOverride = fn;
}

// ---------------------------------------------------------------------------
// In-memory original-total store.
//
// The buyer-return hash must be computed over the ORIGINAL submitted amount, so we must be able
// to recover it from the WiPay transaction id at callback time.
//
// Two independent sources, in priority order:
//   1. The `data` pass-through field. WiPay documents `data` as echoed back in both the buyer
//      return and the webhook, which makes it a contract-backed place to pin the amount. This is
//      the durable path — it survives isolate recycling and does not need a database.
//   2. This process-local map, as a fallback for callbacks where `data` did not round-trip.
//
// The map is per-isolate and non-durable: if it is empty at callback time we MUST be able to fall
// back to (1), and if neither source yields a total we reject the callback rather than verify
// against a guessed amount.
//
// TODO (durability): if Wix-side durable storage (e.g. wix-data) is available to the plugin, mirror
// this map into it. Until then `data` is the source of truth and this map is an optimization.
// ---------------------------------------------------------------------------
const originalTotals = new Map();

function rememberOriginalTotal(pluginTransactionId, originalTotal) {
  if (!isValidTransactionId(pluginTransactionId)) {
    throw new Error('Refusing to store original total under an invalid transaction id.');
  }
  originalTotals.set(String(pluginTransactionId), String(originalTotal));
}

function resolveOriginalTotal(pluginTransactionId, dataEcho) {
  // 1. Contract-backed echo first: WiPay returns `data` verbatim.
  if (dataEcho) {
    try {
      const parsed = typeof dataEcho === 'string' ? JSON.parse(dataEcho) : dataEcho;
      if (parsed && parsed.total != null) {
        const total = Number(parsed.total);
        if (isFinite(total) && total > 0) {
          return total.toFixed(2);
        }
      }
    } catch {
      // Fall through to the local map rather than failing outright.
    }
  }
  // 2. Process-local fallback.
  const remembered = originalTotals.get(String(pluginTransactionId));
  if (remembered) {
    return remembered;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: build the Payment Request payload from the Wix context + merchant order.
// ---------------------------------------------------------------------------

/**
 * Build the WiPay Payment Request JSON for createTransaction.
 *
 * Field names, casing, fee-structure normalization, total formatting and prefill limits are all
 * delegated to wipay-core.js so this file never restates the contract.
 *
 * @param {object} options - Wix transaction options (from Wix's createTransaction call).
 * @param {object} context - Wix context, includes context.credentials after Connect.
 * @param {object} orderInfo - merchant order data (total, currency, buyer, etc.).
 * @returns {object} - Payment Request payload for the WiPay Payments API.
 */
function buildPaymentRequest(options, context, orderInfo) {
  const creds = context.credentials;

  if (!creds || !creds.accountNumber) {
    throw new Error('WiPay account number is required. Connect the account from Accept Payments first.');
  }

  const total = Number(orderInfo.total);
  if (!total || isNaN(total) || total <= 0) {
    throw new Error('Invalid order total for WiPay Payment Request.');
  }

  // Wix's hosted-page flow sends order.returnUrls; response_url is where WiPay sends the buyer
  // return that this plugin verifies. It must be a published-site HTTPS function URL.
  // TODO (exact response_url wiring): confirm from the Wix reference how the plugin's HTTP function
  // URL is derived for the site so we do not ship a placeholder that will not resolve.
  const responseUrl =
    orderInfo.responseUrl ||
    (orderInfo.returnUrls && orderInfo.returnUrls.success) ||
    null;

  if (!responseUrl) {
    // TODO: derive the real published-site function URL instead of failing. Kept as a hard error
    // rather than a placeholder so an unwired callback can never be presented as working.
    throw new Error(
      'response_url is required by WiPay Payment Request and was not provided by Wix. ' +
      'Confirm the hosted-page return URL wiring in the Wix reference before testing.'
    );
  }

  // `data` is the contract-backed carrier for the pinned original total: WiPay echoes it in both
  // the buyer return and the webhook, which is what lets the callback recompute the hash without
  // trusting any buyer-visible field.
  return buildCorePayload({
    account_number: creds.accountNumber,
    country: orderInfo.countryCode || 'TT',
    currency: orderInfo.currency || 'TTD',
    environment: creds.environment || orderInfo.environment || 'sandbox',
    fee_structure: orderInfo.feeStructure || 'customer_pay',
    // method: WiPay's documented Payment Request values are credit_card_co / 3co_simple.
    // TODO (Wix app-id confusion): an earlier draft passed a placeholder WIX_APP_ID here on the
    // reading that Wix wants the PSP's Wix app id in Create Transaction. That belongs to the
    // Wix-side Create Transaction request, not to WiPay's Payment Request body — confirm against
    // the live Wix reference and keep the two surfaces distinct.
    method: orderInfo.method || 'credit_card_co',
    order_id: orderInfo.orderId || coreGenerateOrderId(orderInfo.orderRef || String(Date.now())),
    origin: orderInfo.origin || 'WaypointWix',
    return_url: responseUrl,
    total: total,
    email: orderInfo.email,
    prefill: {
      fname: orderInfo.firstName,
      lname: orderInfo.lastName,
      addr1: orderInfo.address1,
      addr2: orderInfo.address2,
      city: orderInfo.city,
      state: orderInfo.state,
      zipcode: orderInfo.postalCode,
      country: orderInfo.billingCountry,
      phone: orderInfo.phone,
    },
  });
}

// ---------------------------------------------------------------------------
// connectAccount
// ---------------------------------------------------------------------------

/**
 * connectAccount(options, context)
 *
 * Called when the merchant clicks Connect on the Connect page.
 *
 * Returns the credentials Wix stores and passes back to createTransaction() and
 * refundTransaction(). Field ids must match WiPay-config.js.
 *
 * The four fields map onto four separately-authenticated WiPay operations:
 *   accountNumber   -> Payment Request identity (no auth header)
 *   accountApiKey   -> buyer-return hash verification (server-side only)
 *   wapiCredential  -> WAPI refund (X-WAPI-Key OR Bearer, never both)
 *   webhookSecret   -> webhook HMAC verification (server-side only)
 *
 * TODO (account-type gating): surface a clear Connect-page message when a merchant's account type
 * cannot do a flow (PERSONAL accounts cannot create WAPI Keys and must use OAuth bearer).
 */
export function connectAccount(options, context) {
  const creds = options || {};
  const accountNumber = creds.accountNumber;
  const accountApiKey = creds.accountApiKey;
  const wapiCredential = creds.wapiCredential;
  const webhookSecret = creds.webhookSecret;

  if (!accountNumber) {
    return { error: 'WiPay account number is required to connect.' };
  }
  if (!accountApiKey) {
    return { error: 'Account API Key is required for buyer-return hash verification.' };
  }
  if (wapiCredential && !wapiEnvironment(wapiCredential) && !looksLikeBearer(wapiCredential)) {
    return {
      error:
        'WAPI credential must be a WAPI Key (wapi_live_... or wapi_test_...) or an OAuth bearer token.',
    };
  }

  return {
    accountNumber,
    accountApiKey,
    wapiCredential,
    webhookSecret,
    environment: creds.environment || 'sandbox',
  };
}

function looksLikeBearer(value) {
  const v = String(value == null ? '' : value).trim();
  // OAuth bearer access tokens are long opaque strings; WAPI Keys are prefixed and self-identify.
  // Anything that is not a WAPI key is treated as a bearer token, which is why connectAccount
  // accepts it. Empty is rejected upstream.
  return v.length >= 20 && !v.startsWith('wapi_');
}

// ---------------------------------------------------------------------------
// createTransaction
// ---------------------------------------------------------------------------

/**
 * createTransaction(options, context)
 *
 * Called by Wix when the buyer clicks Place Order.
 *
 * WiPay side (implemented):
 *   1. Build the Payment Request payload (correct field names via wipay-core.js).
 *   2. POST to {base}/plugins/payments/request with Accept: application/json.
 *   3. Validate the response shape (200, JSON, https wipayfinancial.com URL, plausible txn id).
 *   4. Pin the original total under the transaction id and inside `data`.
 *   5. Return the hosted checkout URL as the redirect target.
 *
 * Wix side (partially confirmed):
 *   - The plugin must return pluginTransactionId so Wix can correlate across the redirect.
 *
 * TODO (exact Wix return property for hosted-page redirect): confirm from the Wix reference whether
 * Wix expects `redirectUrl` or a different property name, and whether more fields are required.
 *
 * TODO (exact createTransaction request shape from Wix): confirm the exact fields Wix puts on
 * `options` so order properties are read rather than guessed. The reads below accept several
 * plausible spellings and fall through to a hard error instead of silently paying 0.
 */
export async function createTransaction(options, context) {
  const creds = context.credentials;
  if (!creds || !creds.accountNumber) {
    throw new Error('WiPay account not connected. Connect from Accept Payments first.');
  }
  if (!creds.accountApiKey) {
    throw new Error('Account API Key is required for buyer-return hash verification.');
  }

  const o = options || {};
  const order = o.order || o;

  const orderInfo = {
    total: firstNumber(o.amount, order.amount, order.total, o.total),
    currency: o.currency || order.currency || context.currency,
    countryCode: o.countryCode || order.countryCode || order.billingCountry,
    environment: o.environment || order.environment,
    feeStructure: o.feeStructure || order.feeStructure,
    method: o.method,
    orderId: o.orderId || order.orderId || order._id,
    orderRef: o.orderId || order._id || o.wixTransactionId,
    origin: o.origin,
    responseUrl: o.responseUrl || (order.returnUrls && order.returnUrls.success),
    returnUrls: order.returnUrls,
    email: o.email || order.buyerInfo && order.buyerInfo.email,
    firstName: o.firstName || order.buyerInfo && order.buyerInfo.firstName,
    lastName: o.lastName || order.buyerInfo && order.buyerInfo.lastName,
    phone: o.phone || order.buyerInfo && order.buyerInfo.phone,
    address1: o.address1 || order.shippingAddress && order.shippingAddress.streetAddress,
    address2: o.address2,
    city: o.city || order.shippingAddress && order.shippingAddress.city,
    state: o.state || order.shippingAddress && order.shippingAddress.zipCode,
    postalCode: o.postalCode || order.shippingAddress && order.shippingAddress.postalCode,
    billingCountry: o.billingCountry || order.billingAddress && order.billingAddress.country,
  };

  if (!orderInfo.total || isNaN(orderInfo.total) || orderInfo.total <= 0) {
    throw new Error('Order total is required by WiPay Payment Request and was not provided by Wix.');
  }

  const payload = buildPaymentRequest(o, context, orderInfo);
  const originalTotal = Number(orderInfo.total).toFixed(2);

  // Pin the amount in `data` so the buyer-return callback can recover it from WiPay's echo.
  payload.data = JSON.stringify({
    order_id: payload.order_id,
    total: originalTotal,
  });

  const wiPayResponse = await callPaymentRequestApi(payload, creds, orderInfo);

  const pluginTransactionId = wiPayResponse.transaction_id;
  if (!pluginTransactionId) {
    throw new Error('WiPay returned no transaction_id. Payment Request failed or response shape changed.');
  }

  rememberOriginalTotal(pluginTransactionId, originalTotal);

  const redirectUrl = wiPayResponse.url;
  if (!redirectUrl) {
    throw new Error('WiPay returned no hosted checkout URL. Payment Request succeeded but no redirect URL.');
  }

  // Return shape: TODO - confirm exact Wix return shape for hosted-page redirect.
  return {
    pluginTransactionId,
    redirectUrl,
  };
}

function firstNumber(...values) {
  for (const v of values) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (isFinite(n) && n > 0) return n;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// refundTransaction
// ---------------------------------------------------------------------------

/**
 * refundTransaction(options, context)
 *
 * Called by Wix when a merchant initiates a refund from the Orders dashboard.
 *
 * WiPay side (implemented): POST {base}/wapi/transactions/{id}/refund with exactly ONE of
 * `Authorization: Bearer` or `X-WAPI-Key`, selected from the credential's form. WiPay documents the
 * success response as {"message": "Refund request successfully created."} with no refund id, and
 * the definitive outcome arrives via webhook — so this returns PENDING, never COMPLETED.
 *
 * Wix side (unconfirmed): Wix expects a pluginRefundId and completion reported through the
 * provider callback. Because WiPay's endpoint is a refund *request* with no id, we derive a
 * plugin-local id and report PENDING until a webhook confirms.
 *
 * TODO (WAPI refund response shape): confirm whether the response carries a refund id/reference.
 * If it does, use it as pluginRefundId instead of the local id.
 *
 * TODO (exact Wix refund error-code contract): do not invent error codes. The Reason Codes page
 * snippet hinted at 3022-3025 but was not extractable; confirm the full allowed list before
 * shipping a failure result.
 */
export async function refundTransaction(options, context) {
  const creds = context.credentials;
  if (!creds) {
    throw new Error('WiPay credentials are missing from context.');
  }

  const pluginTransactionId = options.pluginTransactionId;
  if (!pluginTransactionId || !isValidTransactionId(pluginTransactionId)) {
    throw new Error('A valid pluginTransactionId is required for WiPay refunds.');
  }

  const refundAmount = Number(options.amount);
  if (!refundAmount || isNaN(refundAmount) || refundAmount <= 0) {
    throw new Error('Refund amount is required.');
  }

  const wiPayRefundResponse = await callWapiRefund(
    creds,
    pluginTransactionId,
    refundAmount,
    options.reason || 'Refund initiated from Wix Orders',
    options.countryCode
  );

  if (wiPayRefundResponse.error) {
    // Surface the transport/API failure instead of reporting a refund that never happened.
    throw new Error('WiPay WAPI refund request failed: ' + wiPayRefundResponse.error);
  }

  const refundIdFromWiPay =
    wiPayRefundResponse.refund_id || wiPayRefundResponse.refundReference || wiPayRefundResponse.id;
  const pluginRefundId = refundIdFromWiPay || 'WIPAY-REFUND-' + coreGenerateOrderId(pluginTransactionId + ':' + refundAmount);

  // TODO (submitEvent shape): report PENDING here via the Wix provider status callback once the
  // exact submitEvent schema is confirmed. Async report is the expected pattern; do not block on
  // the webhook inside this function.
  return {
    pluginTransactionId,
    pluginRefundId,
    status: 'PENDING',
    amount: refundAmount,
    message: wiPayRefundResponse.message || 'Refund request submitted to WiPay.',
  };
}

// ---------------------------------------------------------------------------
// HTTP callbacks
// ---------------------------------------------------------------------------

/**
 * handleBuyerReturn(request)
 *
 * Receives WiPay's GET at response_url and verifies it before anything is trusted.
 *
 * Rules enforced here (all from the confirmed WiPay contract):
 *   - The hash is REQUIRED for a success return. WiPay returns it only on success, so a success
 *     with no hash is a forgery attempt or a contract break: reject it.
 *   - The hash is recomputed over the ORIGINAL submitted amount recovered from the `data` echo or
 *     the local store — never over the buyer-visible `total` in the redirect.
 *   - Comparison is constant-time; a failed verification returns 400 and never reports success.
 *   - A return with no recoverable original total is rejected rather than verified against a guess.
 *
 * TODO (exact response_url query fields): confirm the exact query parameter names WiPay posts.
 * The reads below accept the documented common spellings.
 *
 * TODO (submitEvent shape): map the verified status to a Wix submitEvent call once the exact event
 * schema is confirmed from the live reference.
 */
export function handleBuyerReturn(request, deps) {
  const query = (request && request.query) || {};
  const credentials = (deps && deps.credentials) || {};

  const apiKey = credentials.accountApiKey;
  if (!apiKey) {
    return { body: 'account API key unavailable', statusCode: 500 };
  }

  const transactionId = query.transaction_id || query.transactionId;
  const returnedStatus = query.status;
  const returnedTotal = query.total;
  const returnedHash = query.hash;
  const dataEcho = query.data;

  if (!transactionId || !returnedStatus) {
    return { body: 'incomplete WiPay return', statusCode: 400 };
  }

  const status = String(returnedStatus).toLowerCase();
  if (status !== 'success' && status !== 'failed') {
    return { body: 'unrecognized WiPay status', statusCode: 400 };
  }

  if (status === 'success') {
    // Success without a hash: reject. There is no legitimate success return without one.
    if (!returnedHash) {
      return { body: 'hash missing on success', statusCode: 400 };
    }

    const originalTotal = resolveOriginalTotal(transactionId, dataEcho);
    if (!originalTotal) {
      return { body: 'original total unavailable for verification', statusCode: 400 };
    }

    if (!verifyResponseHash(transactionId, originalTotal, apiKey, returnedHash)) {
      return { body: 'hash verification failed', statusCode: 400 };
    }

    // Hash verified against the pinned original total. Note we deliberately do NOT use
    // returnedTotal for anything security-relevant.
    return {
      body: 'RECEIVED',
      statusCode: 200,
      verified: true,
      transactionId,
      originalTotal,
      status: 'success',
    };
  }

  // Failure returns carry no hash by design; report the failure without claiming verification.
  return {
    body: 'RECEIVED',
    statusCode: 200,
    verified: false,
    transactionId,
    returnedTotal: returnedTotal || null,
    status: 'failed',
  };
}

/**
 * handleRefundStatus(request)
 *
 * TODO (exact refund callback path): confirm whether Wix routes refund status through a separate
 * HTTP function or the same path as the buyer return, and the exact fields Wix expects on refund
 * completion. WiPay's definitive refund outcome arrives via webhook (payment.refunded /
 * payment.refund_rejected), so this stays a pass-through until that mapping is confirmed.
 */
export function handleRefundStatus(request) {
  return { body: 'RECEIVED' };
}

/**
 * handleWebhook(request)
 *
 * Verifies a signed WiPay webhook: HMAC-SHA256 over `timestamp + "." + raw_body` with the endpoint
 * signing secret, constant-time compared, within a ±300s window, then deduplicated by
 * X-WiPay-Webhook-Id.
 *
 * Verification is real and tested in tests/harness.mjs. Event-to-Wix mapping is not wired yet.
 *
 * TODO (webhook scope): confirm which lifecycle events map to which Wix updates, and wire dedupe
 * storage (X-WiPay-Webhook-Id is reused across retries and is the idempotency key).
 */
export function handleWebhook(request, deps) {
  const credentials = (deps && deps.credentials) || {};
  const secret = credentials.webhookSecret;
  if (!secret) {
    return { body: 'webhook secret unavailable', statusCode: 500 };
  }

  const headers = (request && request.headers) || {};
  const signature =
    headers['x-wipay-webhook-signature'] || headers['X-WiPay-Webhook-Signature'];
  const timestamp =
    headers['x-wipay-webhook-timestamp'] || headers['X-WiPay-Webhook-Timestamp'];
  const webhookId =
    headers['x-wipay-webhook-id'] || headers['X-WiPay-Webhook-Id'];

  const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});

  if (!signature || !timestamp) {
    return { body: 'missing webhook signature headers', statusCode: 400 };
  }

  if (!verifyWebhookSignature(rawBody, timestamp, signature, secret)) {
    return { body: 'webhook signature verification failed', statusCode: 401 };
  }

  // TODO: persist webhookId to dedupe before acting on the event.
  return { body: 'RECEIVED', statusCode: 200, webhookId: webhookId || null };
}

// ---------------------------------------------------------------------------
// Internal helpers — real WiPay calls
// ---------------------------------------------------------------------------

/**
 * callPaymentRequestApi(payload, creds, orderInfo)
 *
 * POSTs the Payment Request to the territory/sandbox endpoint and validates the response.
 *
 * Auth: the Payment Request endpoint takes the account number as identity in the body and requires
 * NO auth header. `Accept: application/json` is required — without it the endpoint answers 302
 * with an HTML redirect to the hosted page (browser-facing behaviour), which is not a parseable
 * session response. This was verified live against the TT sandbox.
 */
export async function callPaymentRequestApi(payload, creds, orderInfo) {
  const environment = creds.environment || (orderInfo && orderInfo.environment) || 'sandbox';
  const country = (orderInfo && orderInfo.countryCode) || payload.country_code || 'TT';
  const url = paymentEndpoint(country, environment);
  if (!url) {
    return { error: 'unsupported_country' };
  }

  const doFetch = transportOverride || runtimeFetch();
  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { error: 'network: ' + (e && e.message ? e.message : String(e)) };
  }

  const text = await res.text();
  const parsed = parseCheckoutResponse(res.status, text);
  return parsed;
}

/**
 * callWapiRefund(creds, pluginTransactionId, amount, reason, countryCode)
 *
 * POSTs the WAPI refund request with EXACTLY ONE auth header:
 *   - WAPI Key (wapi_live_... / wapi_test_...) -> `X-WAPI-Key`
 *   - otherwise -> `Authorization: Bearer ...`
 * Sending both, neither, or a wrong-environment key is a 401 per the WAPI contract.
 *
 * Environment is derived from the WAPI key's own prefix so a live key never authenticates a
 * sandbox endpoint (and vice versa).
 */
export async function callWapiRefund(creds, pluginTransactionId, amount, reason, countryCode) {
  const credential = String(creds.wapiCredential == null ? '' : creds.wapiCredential).trim();
  if (!credential) {
    return { error: 'missing WAPI credential' };
  }

  const keyEnvironment = wapiEnvironment(credential);
  const environment = keyEnvironment || creds.environment || 'sandbox';
  if (keyEnvironment && creds.environment && keyEnvironment !== creds.environment) {
    return { error: 'wapi_key_environment_mismatch' };
  }

  const path = '/transactions/' + encodeURIComponent(pluginTransactionId) + '/refund';
  const url = wapiEndpoint(countryCode || 'TT', environment, path);
  if (!url) {
    return { error: 'unsupported_country' };
  }

  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (keyEnvironment) {
    headers['X-WAPI-Key'] = credential;
  } else {
    headers['Authorization'] = 'Bearer ' + credential;
  }

  const body = { amount: Number(amount).toFixed(2) };
  if (reason) body.reason = String(reason).slice(0, 255);

  const doFetch = transportOverride || runtimeFetch();
  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { error: 'network: ' + (e && e.message ? e.message : String(e)) };
  }

  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    return { error: 'http_' + res.status + ': ' + text.slice(0, 200) };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
