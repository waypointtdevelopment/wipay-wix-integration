/**
 * @file backend/http-functions.js
 * @description HTTP function stubs for the WiPay plugin callback path.
 *
 * Wix Payment Provider Service Plugins can expose HTTP functions that the provider calls back
 * into (for buyer return, provider status, etc.). The exact function naming and the exact
 * Wix surface (which HTTP function Wix routes buyer returns to, how submitEvent is reached from
 * those functions) is defined in Wix's service-plugin reference pages and is not fully confirmed
 * here. The stubs below are organized by intent, not by a confirmed Wix route map.
 *
 * Callback flows we need:
 *   1. Buyer return at response_url -> verify WiPay response hash -> submitEvent -> order success/failure
 *   2. Refund status from Wix provider path -> submitEvent -> refund completion
 *   3. Signed webhooks (optional for first cut) -> HMAC verify + replay protect + dedupe -> order updates
 *
 * TODO: confirm from Wix reference the exact HTTP function names Wix expects, the exact request
 * shape Wix sends to each callback, and the exact way to reach submitEvent from inside an HTTP
 * function. Do not assume the naming below matches Wix until confirmed.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// TODO: import the WiPay.js functions (createTransaction, refundTransaction, handleBuyerReturn, etc.)
// when the module layout is confirmed. For now each handler keeps its own minimal logic.
// import { handleBuyerReturn as wiPayHandleBuyerReturn } from './WiPay.js';

// ---------------------------------------------------------------------------
// Buyer return callback
// ---------------------------------------------------------------------------

/**
 * wipayBuyerReturnHandler(request)
 *
 * Public HTTPS HTTP function that receives WiPay's GET response at response_url.
 *
 * WIPAY RESPONSE: WiPay posts the buyer return to response_url with query parameters that
 * include the order status and a response hash. The exact query parameter names are defined in
 * the WiPay Payments API introduction (buyer return / response_url). We MUST verify the hash
 * server-side with the account API key and the original pinned amount before trusting the status.
 *
 * HASH VERIFICATION: the account API key is a secret credential. Verify the hash server-side only.
 * The hash formula and the sandbox rule (123 is for hash-only verification) are described in the
 * WiPay Payments API introduction. Do not implement the hash from memory; read it from the docs.
 *
 * WIX CALLBACK: after verifying the hash, report the result back to Wix through submitEvent so
 * the order appears in Wix Orders with the correct status. The exact submitEvent shape (event
 * type, status value, transaction reference) is defined in Wix's service-plugin reference.
 *
 * TODO (exact response_url query fields): confirm the exact WiPay query parameter names from the
 * Payments API docs (status, order_id, transaction_id, pin, hash, etc.).
 *
 * TODO (exact submitEvent shape): confirm the exact submitEvent() shape Wix expects for a
 * transaction status update.
 */
export async function wipayBuyerReturnHandler(request) {
  // TODO: read query parameters from the WiPay response.
  const query = request.query;

  // TODO: read the account API key from server-side storage only.
  // const apiKey = getAccountApiKey(); // server-side only, never expose to client

  // TODO: verify the response hash with the API key + the original order total.
  // TODO: map WiPay status to a Wix submitEvent call.
  // TODO: on success -> submitEvent({ status: 'SUCCESS', pluginTransactionId, ... })
  // TODO: on failure -> submitEvent({ status: 'FAILED', pluginTransactionId, ... })

  return { body: 'RECEIVED' };
}

// ---------------------------------------------------------------------------
// Refund status callback
// ---------------------------------------------------------------------------

/**
 * wipayRefundStatusHandler(request)
 *
 * HTTP function that receives refund status updates for the WiPay plugin.
 *
 * FLOW: when a merchant initiates a refund from Wix Orders, refundTransaction() calls the WiPay
 * WAPI refund endpoint and reports the refund as PENDING. The real refund OUTCOME arrives via
 * WiPay's refund webhook (or via the Wix provider callback path, depending on Wix's design).
 * This handler receives that update and reports completion back to Wix through submitEvent.
 *
 * TODO: confirm from Wix reference whether Wix routes refund status through a separate HTTP
 * function or through the same callback path as the buyer return. Also confirm the exact fields
 * Wix expects when marking a refund COMPLETED (pluginTransactionId, pluginRefundId, status, amount).
 */
export async function wipayRefundStatusHandler(request) {
  // TODO: read refund status, verify any signature if WiPay signs refund callbacks,
  // and call submitEvent() to mark the refund COMPLETED once confirmed.
  return { body: 'RECEIVED' };
}

// ---------------------------------------------------------------------------
// Webhook handler (signed, replay-protected)
// ---------------------------------------------------------------------------

/**
 * wipayWebhookHandler(request)
 *
 * Consumes signed WiPay webhooks for lifecycle events: success, failure, refund, chargeback, fraud.
 *
 * VERIFICATION (WiPay webhook contract):
 *   - Verify the HMAC signature using the webhook signing secret.
 *   - Verify the timestamp window (reject stale events).
 *   - Dedup by webhook id (ignore already-processed events).
 *
 * DESTINATION: on a verified event, map it to a Wix order update via submitEvent where
 * appropriate. If webhooks are not in scope for the first cut, keep this handler stubbed.
 *
 * The webhook signing secret is a server-side credential declared in getConfig() for when we do
 * wire up webhooks. Do not log it or expose it.
 *
 * TODO (webhooks in scope for first cut): if webhooks are out of scope for the first cut, leave
 * this stubbed and do not wire it into the callback path. Confirm the exact webhook signature
 * scheme, timestamp field, and dedup id from the WiPay webhooks docs when we do.
 */
export async function wipayWebhookHandler(request) {
  // TODO: verify HMAC signature + timestamp window, dedup by webhook id, map event to Wix.
  return { body: 'RECEIVED' };
}
