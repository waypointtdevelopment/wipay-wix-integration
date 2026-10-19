/**
 * @file WiPay.js
 * @description Core of the WiPay Payment Provider Service Plugin.
 *
 * Wix calls these functions at checkout time. They must be annotated for Velo or exported as
 * module members depending on how Wix loads the plugin. The exact Wix surface (which function
 * names Wix imports, how it wraps them) is defined in Wix's service-plugin reference pages.
 *
 * Hosted-page note: WiPay Payment Request can return a hosted checkout URL a buyer completes on
 * WiPay's page. For hosted-page payment methods Wix documents that they do NOT support 3D Secure
 * verification or recurring payments — that constraint applies here too.
 *
 * Sources for the WiPay contract used below:
 *   - Payments API / Payment Request: https://dev.wipay.com/docs/api/payments/operation/create-a-payment-request
 *   - Payment Request request/response shape, account/order_id/total/response_url semantics:
 *     https://dev.wipay.com/docs/api/payments/introduction
 *   - Buyer return (response_url) and pin-hash verification:
 *     https://dev.wipay.com/docs/api/payments/introduction#buyer-return-response_url
 *   - Webhooks (HMAC, replay protection, dedupe):
 *     https://dev.wipay.com/docs/api/payments/introduction#webhooks
 *   - Refund (WAPI refund-request endpoint, refund request succeeds with message):
 *     https://dev.wipay.com/docs/api/wapi/introduction
 *   - Sandbox values (test account, 123-is-for-hash-only, etc.):
 *     https://dev.wipay.com/docs/api/payments/introduction
 *
 * Wix redirection/hosted-page model (confirmed from Wix sample-payment-flows page):
 *   - Wix sends `order.returnUrls` (success / error / cancel / pending) in the Create Transaction request.
 *   - For hosted-page payments, the PSP returns `redirectUrl`; Wix opens that URL in an iframe or
 *     browser window for the buyer to complete.
 *   - The buyer lands on the appropriate `returnUrl`; final status is delivered by the PSP to Wix via
 *     Submit Event, not returned as a final value from Create Transaction.
 *   - For hosted-page payments, the `paymentMethod` value in the Create Transaction request is a string
 *     representing the PSP's Wix app ID.
 *   - Hard constraint from Wix docs: "Hosted-page payment methods don't support 3D Secure verification
 *     or recurring payments."
 *   - Open item: exact JSON shapes for the Create Transaction request and Submit Event webhook are shown
 *     in Wix docs as "Copy" code blocks that did not render into extracted text; do not hard-code field
 *     names from guesswork — confirm from the live Wix page before shipping.
 *
 * TODO (exact Wix return / event shapes): the exact JSON passed into createTransaction() by Wix and the
 * exact properties Wix expects back (for hosted-page return, especially the redirect property and the
 * pluginTransactionId surface) are defined in Wix's service-plugin reference pages and need confirmation
 * before finalizing the return shape. The current implementation follows the contract described in
 * SERVICE-PLUGIN-CONTRACT-NOTES.md and flags the Wix-side gaps as TODOs.
 */

// ---------------------------------------------------------------------------
// WiPay Payment Request field names we pass through to the Payments API.
// These match the WiPay create-a-payment-request operation and the field semantics
// in the Payment Request introduction. Confirm each field name spelling against the live
// API reference before treating the request body as finalized.
// ---------------------------------------------------------------------------
const PAYMENT_REQUEST_FIELDS = [
  'account',               // WiPay account number (identity, no auth header)
  'environment',           // sandbox or live
  'country_code',          // e.g. TT, JM, BB
  'currency',              // e.g. JMD
  'fee_structure',         // e.g. customer_pay
  'method',                // credit_card_co or 3co_simple; for hosted page the PSP’s Wix app ID
  'order_id',              // merchant order id
  'origin',                // e.g. wix
  'total',                 // order total
  'response_url',          // where WiPay posts the buyer return / status callback
  'email',                 // buyer email (optional)
  'first_name',            // optional
  'last_name',             // optional
  'phone_number',          // optional
  'return_url',            // optional, distinct from response_url in some flows
];

// ---------------------------------------------------------------------------
// State / lookup helpers (stubs)
// ---------------------------------------------------------------------------

/**
 * resolveOriginalTotal(pluginTransactionId)
 *
 * Returns the original order total for the given WiPay transaction, formatted to exactly two
 * decimals (e.g. "10.00"). Required for buyer-return hash verification because the hash must be
 * computed over the original submitted amount, not the buyer-facing total returned in the redirect.
 *
 * Implementation notes:
 *   - We must store the original total somewhere Wix can retrieve it later (Wix order metadata, the
 *     plugin’s stored transaction state, or as part of the `data` pass-through echoed back by WiPay).
 *   - Decide the storage strategy before shipping; do not rely on reconstructing it from the redirect.
 *
 * TODO: implement using a real Wix-side store for the original total keyed by pluginTransactionId.
 */
function resolveOriginalTotal(pluginTransactionId) {
  // TODO: look up and return the original total for this transaction.
  throw new Error('resolveOriginalTotal not implemented');
}

// ---------------------------------------------------------------------------
// Helper: build the Payment Request payload from the Wix context + merchant order.
// ---------------------------------------------------------------------------

/**
 * Build the WiPay Payment Request JSON for createTransaction.
 *
 * @param {object} options - Wix transaction options (from Wix's createTransaction call).
 * @param {object} context - Wix context, includes context.credentials after Connect.
 * @param {object} orderInfo - merchant order data (items, totals, buyer, etc.).
 * @returns {object} - Payment Request payload suitable for the WiPay Payments API.
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

  const payload = {};

  // --- identity / environment ---
  payload.account = creds.accountNumber;
  // Toggle between sandbox and live. Drive from the merchant's chosen WiPay environment or a site
  // setting in production. For now we default to sandbox so the plugin can be tested against WiPay
  // sandbox first.
  // TODO: wire the environment from a real merchant setting / credentials rather than a hard default.
  payload.environment = 'sandbox';

  // --- country + currency ---
  if (orderInfo.countryCode) payload.country_code = orderInfo.countryCode;
  if (orderInfo.currency) payload.currency = orderInfo.currency;

  // --- fee structure ---
  // WiPay accepts fee_structure values like customer_pay / merchant_absorb / split.
  if (orderInfo.feeStructure) payload.fee_structure = orderInfo.feeStructure;

  // --- method ---
  // For hosted-page payment methods in Wix, the paymentMethod value in the Create Transaction
  // request body is "a string representing the PSP's Wix app ID." The exact string to pass here for
  // WiPay's Wix app ID is a Wix-side value we must confirm from the Wix service-plugin reference.
  // Until then we pass a clearly-marked placeholder.
  payload.method = orderInfo.method || 'WIX_APP_ID_FOR_WIPAY'; // TODO: replace with confirmed Wix app ID

  // --- order identity ---
  // WiPay needs a merchant order_id. Generate or pass through one from the Wix order.
  // Decide the origin/order_id generation and idempotency strategy (see TODO in notes).
  payload.order_id = orderInfo.orderId || generateOrderId();
  payload.origin = orderInfo.origin || 'wix';

  // --- amount ---
  payload.total = total.toFixed(2);

  // --- buyer return ---
  // response_url is where WiPay posts the buyer return. Wix's hosted-page flow sends
  // order.returnUrls (success / error / cancel / pending); the buyer ends up on the right
  // returnUrl and the status flows back to Wix through Submit Event. The WiPay response_url should
  // point at the Wix HTTP function that verifies the hash and calls submitEvent.
  //
  // TODO (exact response_url / Wix return url wiring): confirm from Wix reference whether the Wix
  // plugin should set response_url to a Wix HTTP function URL and how Wix maps the buyer return on
  // its returnUrls to that callback. Do not hardcode a URL that will not resolve in the published site.
  if (orderInfo.responseUrl) {
    payload.response_url = orderInfo.responseUrl;
  } else {
    // Fallback placeholder for local / preview development only. Replace with a real published site
    // HTTPS function URL before any live test.
    payload.response_url = 'https://placeholder.example/wipay-response';
  }

  // --- optional buyer / display fields ---
  if (orderInfo.email) payload.email = orderInfo.email;
  if (orderInfo.firstName) payload.first_name = orderInfo.firstName;
  if (orderInfo.lastName) payload.last_name = orderInfo.lastName;
  if (orderInfo.phone) payload.phone_number = orderInfo.phone;

  // --- line items if WiPay Payment Request supports them ---
  if (orderInfo.items && orderInfo.items.length) {
    payload.items = orderInfo.items.map((item) => ({
      name: item.name || 'Item',
      amount: Number(item.amount).toFixed(2),
      quantity: item.quantity || 1,
    }));
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Helper: generate a merchant order id when the Wix order does not provide one.
// ---------------------------------------------------------------------------

/**
 * Generate an order id for the WiPay Payment Request.
 * Replace with a real strategy tied to the Wix order / site. Current implementation is a placeholder.
 */
function generateOrderId() {
  // TODO: replace with a real order-id strategy (Wix order id, site prefix, idempotency key).
  return 'WIX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ---------------------------------------------------------------------------
// connectAccount
// ---------------------------------------------------------------------------

/**
 * connectAccount(options, context)
 *
 * Called when the merchant clicks Connect on the Connect page.
 *
 * options contains the credentials entered on the Connect page plus site info we may need.
 * On success, return the provider account info / credentials Wix will pass to createTransaction()
 * and refundTransaction(). On failure, return an error object instead.
 *
 * For hosted-page providers, connectAccount is also where we would validate that the merchant's
 * WiPay account is the right type (e.g. BUSINESS/KYC-3 if they need WAPI refunds) and surface
 * clear instructions for any missing credential.
 *
 * TODO (account-type gating on the Connect page): confirm from WiPay which account types can use
 * Payment Request vs WAPI refunds, and surface a clear Connect-page message when a merchant's account
 * cannot yet do one of the flows (e.g. PERSONAL accounts cannot create WAPI Keys and must use OAuth
 * bearer for refunds).
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

  // Return the credentials Wix will store and pass to createTransaction / refundTransaction.
  // Field IDs here must match the credential field names declared in WiPay-config.js.
  return {
    accountNumber,
    accountApiKey,
    wapiCredential,
    webhookSecret,
  };
}

// ---------------------------------------------------------------------------
// createTransaction
// ---------------------------------------------------------------------------

/**
 * createTransaction(options, context)
 *
 * Called by Wix when the buyer clicks Place Order.
 *
 * Contract:
 *   1. Build the WiPay Payment Request payload.
 *   2. Call WiPay Payments API create-a-payment-request.
 *   3. Read transaction_id from the WiPay response and store it as pluginTransactionId.
 *   4. Return the hosted checkout URL as the redirect target.
 *
 * In Wix's hosted-page / redirection flow, Wix sends order.returnUrls (success / error / cancel /
 * pending) in the Create Transaction request, the PSP returns redirectUrl, and Wix opens that
 * redirectUrl in an iframe or browser window for the buyer to complete. The buyer then lands on the
 * appropriate returnUrl, and the PSP sends the status to Wix through Submit Event.
 *
 * Saving pluginTransactionId is required so Wix can correlate the transaction across the redirect,
 * the buyer return, and the later refund.
 *
 * TODO (exact Wix return property for hosted-page redirect): confirm from Wix reference which property
 * Wix expects createTransaction() to return for a hosted-page redirect (the documentation names
 * redirectUrl in the return shape; confirm whether Wix wants exactly that property name or a different
 * one, and whether any additional fields are required). Do not ship a return shape that does not match
 * the Wix reference.
 *
 * TODO (exact createTransaction request shape from Wix): Wix passes order data into createTransaction();
 * confirm the exact fields Wix provides here so we read the right order properties instead of guessing
 * properties that may not exist.
 */
export function createTransaction(options, context) {
  const creds = context.credentials;
  if (!creds || !creds.accountNumber) {
    throw new Error('WiPay account not connected. Connect from Accept Payments first.');
  }
  if (!creds.accountApiKey) {
    throw new Error('Account API Key is required for buyer-return hash verification.');
  }

  // --- read the order from Wix options ---
  // TODO: confirm the exact fields Wix puts on options/order here.
  const orderInfo = {
    total: options.amount ? Number(options.amount) : 0,
    currency: options.currency || context.currency,
    countryCode: options.countryCode,
    feeStructure: options.feeStructure,
    method: options.method,
    orderId: options.orderId,
    origin: options.origin,
    responseUrl: options.responseUrl,
    email: options.email,
    firstName: options.firstName,
    lastName: options.lastName,
    phone: options.phone,
    items: options.items,
  };

  if (!orderInfo.total || isNaN(orderInfo.total) || orderInfo.total <= 0) {
    throw new Error('Order total is required by WiPay Payment Request and was not provided by Wix.');
  }

  // --- build Payment Request payload ---
  const payload = buildPaymentRequest(options, context, orderInfo);

  // --- call WiPay Payments API (create-a-payment-request) ---
  const wiPayResponse = callPaymentRequestApi(payload, creds);

  // --- store pluginTransactionId ---
  // TODO: confirm whether Wix expects pluginTransactionId to be returned inside the transaction object
  // or as a top-level property. The tutorial establishes that Wix needs the PSP's transaction id stored
  // and returned so it can correlate the transaction later.
  const pluginTransactionId = wiPayResponse.transaction_id;
  if (!pluginTransactionId) {
    throw new Error('WiPay returned no transaction_id. Payment Request failed or response shape changed.');
  }

  // --- remember the original total for later hash verification ---
  // The buyer-return hash must be computed over the original submitted amount, not the returned total.
  // We must store it somewhere retrievable by pluginTransactionId.
  // TODO: store originalTotal keyed by pluginTransactionId using the chosen Wix-side store.
  const originalTotal = orderInfo.total.toFixed(2);
  rememberOriginalTotal(pluginTransactionId, originalTotal);

  // --- return the hosted checkout URL ---
  const redirectUrl = wiPayResponse.url;
  if (!redirectUrl) {
    throw new Error('WiPay returned no hosted checkout URL. Payment Request succeeded but no redirect URL.');
  }

  // Return shape: TODO - confirm exact Wix return shape for hosted-page redirect.
  return {
    pluginTransactionId,
    redirectUrl,
    // TODO: confirm whether Wix expects any other return fields for hosted-page flows.
    // Examples from Wix docs surface: statusCode, confirmation, order (with returnUrls), etc.
  };
}

// ---------------------------------------------------------------------------
// refundTransaction
// ---------------------------------------------------------------------------

/**
 * refundTransaction(options, context)
 *
 * Called by Wix when a merchant initiates a refund from the Orders dashboard.
 *
 * Contract (WiPay side):
 *   - WiPay provides a WAPI refund endpoint. The documented WAPI refund operation is a refund REQUEST
 *     whose success response is currently documented as:
 *       { "message": "Refund request successfully created." }
 *     The definitive refund OUTCOME is reported via webhooks (refund event), not via the immediate
 *     refund-request response.
 *
 * Contract (Wix side):
 *   - Wix expects refundTransaction() to return a pluginRefundId and to report the refund completion
 *     back through the provider status callback (submitEvent / the HTTP callback path). Wix correlates
 *     refunds using pluginTransactionId + pluginRefundId.
 *
 * Reconciling the two: we call the WAPI refund endpoint for the WiPay transaction, then we must report
 * the refund status back to Wix in the way Wix expects. Because WiPay's documented refund response is a
 * request confirmation (not a completed refund with an id), we currently:
 *   1. Create the WAPI refund request.
 *   2. Use the WiPay refund reference (if the WAPI response carries one) as pluginRefundId; if the WAPI
 *      response does not carry a usable refund id, we derive a plugin-local refund id.
 *   3. Report the refund back to Wix via the callback path as PENDING until the webhook confirms
 *      completion, then mark it COMPLETED.
 *
 * This is a known contract gap that must be resolved for production: WiPay's refund semantics vs Wix's
 * expectation. See the refund section of SERVICE-PLUGIN-CONTRACT-NOTES.md and the TODO there.
 *
 * TODO (WAPI refund response shape): confirm the exact WAPI refund response fields (does it return a
 * refund id/reference, a status, or just the message string?). If it returns a refund reference, use that
 * as pluginRefundId. If not, use a local refund id and rely on webhooks for completion.
 *
 * TODO (WAPI auth for refunds): refund auth uses EITHER X-WAPI-Key OR OAuth bearer Authorization, never
 * both. The WAPI credential field stores whichever form the merchant has. A BUSINESS account with a
 * verified WAPI Key uses X-WAPI-Key; a PERSONAL account uses OAuth bearer. Decide the auth strategy from
 * the account type / credential form rather than assuming one.
 */
export function refundTransaction(options, context) {
  const creds = context.credentials;
  if (!creds) {
    throw new Error('WiPay credentials are missing from context.');
  }

  const pluginTransactionId = options.pluginTransactionId;
  if (!pluginTransactionId) {
    throw new Error('pluginTransactionId is required for WiPay refunds (Wix must pass it).');
  }

  const refundAmount = options.amount ? Number(options.amount) : 0;
  if (!refundAmount || isNaN(refundAmount) || refundAmount <= 0) {
    throw new Error('Refund amount is required.');
  }

  // --- call WAPI refund endpoint ---
  const wiPayRefundResponse = callWapiRefund(
    creds,
    pluginTransactionId,
    refundAmount,
    options.reason || 'Refund initiated from Wix Orders'
  );

  // --- determine pluginRefundId ---
  // WiPay's documented refund success response is currently just a message. If the WAPI response carries
  // a refund reference / id, prefer that. Otherwise use a local refund id.
  const refundIdFromWiPay = wiPayRefundResponse.refund_id || wiPayRefundResponse.refundReference;
  const pluginRefundId = refundIdFromWiPay || 'WIPAY-REFUND-' + generateOrderId();

  // --- report back to Wix ---
  // Refund is initially reported as PENDING; the webhook / buyer-return flow should confirm completion
  // and update the Wix order. TODO: confirm the exact Wix submitEvent shape for refund status updates
  // (status, pluginRefundId, amount, etc.).
  const refundStatusReport = {
    pluginTransactionId,
    pluginRefundId,
    status: 'PENDING',
    amount: refundAmount,
    message: wiPayRefundResponse.message || 'Refund request submitted to WiPay.',
  };

  // TODO: call the Wix provider status callback (submitEvent or HTTP function) to mark the refund PENDING
  // here, then mark COMPLETED when the webhook confirms. Do not block this function waiting for a webhook;
  // async report is the expected pattern.

  return refundStatusReport;
}

// ---------------------------------------------------------------------------
// HTTP callbacks
// ---------------------------------------------------------------------------

/**
 * handleBuyerReturn(request)
 *
 * Public HTTPS HTTP function that receives WiPay's GET response at response_url.
 *
 * Flow:
 *   1. Read the query parameters from WiPay's response.
 *   2. Verify the response hash with the account API key + the original order total.
 *   3. On success, call submitEvent() to mark the transaction success so the order appears in Wix Orders.
 *      On failure, call submitEvent() to mark failure.
 *
 * The hash verification must happen server-side using the account API key (a secret credential) and the
 * original pinned amount. The hash formula and the "123-is-for-hash-only" sandbox rule are described in
 * the WiPay Payments API introduction.
 *
 * Hash formula (from WiPay docs):
 *   md5(transaction_id + original_total + api_key)
 *   - transaction_id is WiPay's transaction_id from the redirect.
 *   - original_total is the original submitted amount formatted to exactly two decimals (e.g. "10.00").
 *   - api_key is the account API Key (sandbox: "123" for hash verification only).
 *
 * TODO (exact response_url query fields): confirm the exact query parameters WiPay posts to response_url
 * from the Payments API docs (status, order_id, transaction_id, pin, hash, etc.). Use the real field names
 * to read the response.
 *
 * TODO (Wix submitEvent exact shape): confirm the exact submitEvent() shape Wix expects for a transaction
 * status update (event type, status value, transaction reference). Use real values once confirmed.
 */
export function handleBuyerReturn(request) {
  const query = request.query;
  if (!query) {
    return { body: 'missing query', statusCode: 400 };
  }

  const apiKey = getAccountApiKey(); // TODO: read from context / stored creds, server-side only
  if (!apiKey) {
    return { body: 'account API key unavailable', statusCode: 500 };
  }

  const transactionId = query.transaction_id || query.transactionId;
  const returnedStatus = query.status;
  const returnedTotal = query.total;
  const returnedHash = query.hash;

  if (!transactionId || !returnedStatus) {
    return { body: 'incomplete WiPay return', statusCode: 400 };
  }

  // --- hash verification ---
  // We must verify the hash against the ORIGINAL total, not the returned total.
  // The sandbox API key "123" is for hash verification only.
  const originalTotal = resolveOriginalTotal(transactionId);
  const expectedHash = computeResponseHash(transactionId, originalTotal, apiKey);

  // Only verify hash when WiPay included one (sandbox may not always include hash; confirm from docs).
  if (returnedHash && returnedHash !== expectedHash) {
    // Hash mismatch — untrusted response.
    return { body: 'hash verification failed', statusCode: 400 };
  }

  // --- map WiPay status to a Wix event ---
  // TODO: call submitEvent() with the real Wix shape. Pseudocode:
  //   if (returnedStatus === 'success') {
  //     submitEvent({
  //       event: {
  //         transaction: {
  //           wixTransactionId: query["wixTransactionId"],
  //           pluginTransactionId: transactionId,
  //           // ... other event properties per Wix reference
  //         }
  //       }
  //     });
  //   } else {
  //     submitEvent({ event: { transaction: { ... failure shape ... } } });
  //   }

  return { body: 'RECEIVED' };
}

/**
 * handleRefundStatus(request)
 *
 * HTTP function that receives refund status updates from WiPay (or from the Wix provider callback path)
 * and reports completion back to Wix via submitEvent / the Wix callback.
 *
 * TODO (exact refund callback path): confirm from Wix reference whether Wix expects a separate HTTP
 * function for refund status or whether both transaction and refund status flows through the same path.
 * Also confirm the exact fields Wix expects in the refund completion call.
 */
export function handleRefundStatus(request) {
  // TODO: read refund status, verify any signature if WiPay signs refund callbacks, and call submitEvent()
  // to mark the refund COMPLETED once confirmed.
  return { body: 'RECEIVED' };
}

/**
 * handleWebhook(request)
 *
 * Consumes signed WiPay webhooks for lifecycle events: success, failure, refund, chargeback, fraud.
 *
 * Verification:
 *   - Verify the HMAC signature using the webhook signing secret.
 *   - Verify the timestamp window (reject stale events).
 *   - Dedup by webhook id (ignore already-processed events).
 *
 * On a verified event, map it to a Wix order update via submitEvent() where appropriate.
 *
 * TODO (webhook in scope for first cut): if webhooks are not in scope yet, leave this handler stubbed and
 * do not wire it into the callback path. The webhookSecret credential is already declared in getConfig()
 * for when we do.
 */
export function handleWebhook(request) {
  // TODO: verify HMAC signature + timestamp window, dedup by webhook id, map event to Wix.
  return { body: 'RECEIVED' };
}

// ---------------------------------------------------------------------------
// Internal helpers (stubs — replace with real implementations)
// ---------------------------------------------------------------------------

/**
 * callPaymentRequestApi(payload, creds)
 *
 * Calls the WiPay Payments API create-a-payment-request endpoint.
 *
 * Auth: the Payment Request endpoint accepts the account number as identity; it does NOT require a
 * separate auth header for the Payment Request itself (confirm against the live API reference).
 *
 * TODO (exact endpoint URL + request shape): confirm the exact endpoint URL and the exact fields WiPay
 * accepts from the live API reference. The payload built above uses the field names from the WiPay Payment
 * Request introduction; confirm spelling and required vs optional fields.
 */
function callPaymentRequestApi(payload, creds) {
  // TODO: implement the real HTTPS call to the WiPay Payments API.
  // Example shape (confirm from live docs):
  //   POST https://ttsb.wipayfinancial.com/plugins/payments/request  (TT sandbox)
  //   Body: the payload built in buildPaymentRequest()
  //
  // On success, the WiPay response includes transaction_id and url (the hosted checkout URL).
  // Return the parsed response.
  return {
    transaction_id: 'wiPay-sandbox-tx-' + generateOrderId(),
    url: 'https://sandbox.wipay.com/checkout/wipay-sandbox-checkout-' + generateOrderId(),
    // TODO: include any other response fields WiPay returns (status, order_id, etc.) once confirmed.
  };
}

/**
 * callWapiRefund(creds, pluginTransactionId, amount, reason)
 *
 * Calls the WiPay WAPI refund endpoint.
 *
 * Auth rules (do NOT combine):
 *   - WAPI Key: send as X-WAPI-Key header.
 *   - OAuth bearer: send as Authorization: Bearer <token>.
 *   - A BUSINESS account with a verified WAPI Key uses X-WAPI-Key.
 *   - A PERSONAL account uses OAuth bearer.
 *
 * Environment scoping: WAPI Keys are prefixed by environment (wapi_live_... vs wapi_test_...).
 * Use the matching key for the transaction's environment. Do not cross environments.
 *
 * TODO (exact WAPI refund endpoint + request shape + response shape): confirm from the WiPay WAPI docs
 * the exact endpoint, the exact refund request fields (transaction id, amount, reason, etc.), and the
 * exact response shape. The current implementation treats the documented success response ("Refund request
 * successfully created.") as the baseline and expects a possible refund id/reference field that needs
 * confirmation.
 */
function callWapiRefund(creds, pluginTransactionId, amount, reason) {
  // TODO: implement the real HTTPS call to the WiPay WAPI refund endpoint.
  // Decide auth from creds.wapiCredential form:
  //   - if it looks like a WAPI Key (per the documented prefix), send X-WAPI-Key
  //   - otherwise send Authorization: Bearer ...
  //
  // Example shape (confirm from live docs):
  //   POST https://api.wipay.com/wapi/transactions/{transaction_id}/refund  (or the actual endpoint)
  //   Body: { transaction_id: pluginTransactionId, amount, reason }  (or path-only, confirm from docs)
  //
  // On success, WiPay currently documents the response as:
  //   { "message": "Refund request successfully created." }
  // If the response also carries a refund id/reference field, use it. If not, the refund outcome arrives
  // via webhooks.
  return {
    message: 'Refund request successfully created.',
    // TODO: include refund_id / refund reference if WiPay returns one.
  };
}

/**
 * computeResponseHash(transactionId, originalTotal, apiKey)
 *
 * Computes the buyer-return response hash per WiPay's documented formula:
 *   md5(transaction_id + original_total + api_key)
 *
 * This must use the ACCOUNT API KEY (not the WAPI credential, not the webhook secret).
 * Sandbox api_key for hash verification is "123".
 */
function computeResponseHash(transactionId, originalTotal, apiKey) {
  // TODO: implement MD5 in the Wix runtime or call a server-side crypto helper.
  // Do not use the buyer-facing total; use the original submitted total formatted to two decimals.
  // return md5(transactionId + originalTotal + apiKey);
  return 'TODO-implementation-needed';
}

/**
 * getAccountApiKey()
 *
 * Returns the account API key from the stored credentials.
 *
 * WARNING: this is a secret credential. Keep it server-side only; do not log it, do not return it to the
 * browser, do not put it in any client-visible response. Use it only for hash verification and for any other
 * server-side operation the Payments API requires.
 */
function getAccountApiKey() {
  // TODO: read from context.credentials.accountApiKey (server-side storage).
  return null;
}

/**
 * rememberOriginalTotal(pluginTransactionId, originalTotal)
 *
 * Stores the original submitted total so the buyer-return callback can recompute the hash later.
 *
 * TODO: implement using a real Wix-side store keyed by pluginTransactionId (Wix order metadata, plugin
 * state, or the `data` pass-through echoed back by WiPay).
 */
function rememberOriginalTotal(pluginTransactionId, originalTotal) {
  // TODO: persist originalTotal for this pluginTransactionId.
}
