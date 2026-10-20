/**
 * @file backend/http-functions.js
 * @description HTTP function entry points for the WiPay plugin callback path.
 *
 * These are thin adapters: they translate a Wix HTTP request into the shape the verified handlers
 * in WiPay.js expect, call them, and translate the result back into a Wix HTTP response. All
 * security-relevant logic (hash verification, webhook signature verification, the pinned-original-
 * total rule, the success-without-hash rejection) lives in WiPay.js and is covered by
 * tests/harness.mjs — it is deliberately NOT reimplemented here.
 *
 * Callback flows:
 *   1. Buyer return at response_url -> verify WiPay response hash -> submitEvent
 *   2. Refund status -> submitEvent (pass-through until the Wix mapping is confirmed)
 *   3. Signed webhooks -> HMAC verify + replay window + dedupe id
 *
 * TODO (exact Wix route map): confirm from the Wix service-plugin reference the exact HTTP function
 * names Wix expects, the exact request shape Wix sends to each callback, and the exact way to reach
 * submitEvent from inside an HTTP function. The naming below is organized by intent, not by a
 * confirmed Wix route map. Do not assume it matches Wix until confirmed.
 *
 * TODO (credential access from an HTTP function): createTransaction() receives context.credentials,
 * but an HTTP function invoked by WiPay's redirect does not obviously get that context. The
 * handlers therefore take credentials as an explicit dependency. Resolving where an HTTP function
 * reads the stored accountApiKey / webhookSecret server-side is an open Wix-side item — until it is
 * resolved, the handlers fail closed (500) rather than skipping verification, which is the correct
 * behaviour: a callback that cannot verify must never report success.
 */

import {
  handleBuyerReturn,
  handleRefundStatus,
  handleWebhook,
} from './WiPay.js';

// TODO: read these from server-side storage (context.credentials / Wix secrets) per the note above.
// Never log or return them. Failing to resolve them must keep failing closed.
async function resolveCredentials(kind) {
  // TODO (Wix-side): implement the real server-side credential lookup.
  return null;
}

function toResponse(result) {
  return {
    statusCode: (result && result.statusCode) || 200,
    headers: { 'Content-Type': 'text/plain' },
    body: (result && result.body) != null ? String(result.body) : '',
  };
}

/**
 * wipayBuyerReturnHandler(request)
 *
 * Receives WiPay's GET at response_url. Delegates to handleBuyerReturn(), which:
 *   - requires a hash on success and returns 400 when it is absent,
 *   - recomputes md5(transaction_id + ORIGINAL_total + api_key) using the `data` echo or the
 *     stored total, never the buyer-visible `total`,
 *   - compares in constant time and returns 400 on any mismatch.
 *
 * TODO (submitEvent): on verified success, call submitEvent() to mark the transaction successful so
 * the order appears in Wix Orders; on verified failure, call submitEvent() with the failure shape.
 * The exact submitEvent schema is unconfirmed — see the TODOs in SERVICE-PLUGIN-CONTRACT-NOTES.md.
 * Do not invent the event shape.
 */
export async function wipayBuyerReturnHandler(request) {
  const credentials = await resolveCredentials('buyerReturn');
  const result = handleBuyerReturn(request, { credentials });
  return toResponse(result);
}

/**
 * wipayRefundStatusHandler(request)
 *
 * Receives refund status updates. Delegates to handleRefundStatus().
 *
 * WiPay's definitive refund outcome arrives via webhook (payment.refund_requested /
 * payment.refunded / payment.refund_rejected); refundTransaction() reports PENDING until then.
 *
 * TODO: confirm whether Wix routes refund status through a separate HTTP function or the same path
 * as the buyer return, and the exact fields Wix expects when marking a refund COMPLETED.
 */
export async function wipayRefundStatusHandler(request) {
  const result = handleRefundStatus(request);
  return toResponse(result);
}

/**
 * wipayWebhookHandler(request)
 *
 * Consumes signed WiPay webhooks. Delegates to handleWebhook(), which verifies
 * HMAC-SHA256 over `timestamp + "." + raw_body` with constant-time comparison inside a ±300s
 * window, and surfaces X-WiPay-Webhook-Id for deduplication.
 *
 * The raw body MUST reach the handler unmodified — verification is over the exact raw bytes, so
 * re-serializing parsed JSON here would break every signature. The adapter passes the body through.
 *
 * TODO: persist X-WiPay-Webhook-Id to dedupe (it is reused across retries and is the idempotency
 * key), and map verified events to Wix order updates. If webhooks are out of scope for the first
 * cut, leave unwired rather than partially wired.
 */
export async function wipayWebhookHandler(request) {
  const credentials = await resolveCredentials('webhook');
  const result = handleWebhook(request, { credentials });
  return toResponse(result);
}
