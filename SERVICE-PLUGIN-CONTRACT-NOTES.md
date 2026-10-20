# Wix WiPay plugin — service-plugin contract notes

**Purpose:** capture the Wix + WiPay contract details we are building against, with the
explicit boundaries of what is confirmed from Wix/WiPay docs vs. what still needs reference
confirmation before finalizing code. This is a working note, not a final spec.

## Wix file layout (confirmed from the tutorial)

```
Service Plugins/
└── payment-provider/
    └── WiPay/
        ├── WiPay-config.js   # getConfig()
        └── WiPay.js         # connectAccount / createTransaction / refundTransaction
backend/
└── http-functions.js       # provider status callback endpoint(s)
```

- The plugin name cannot contain spaces or special characters.
- We can add extra `.js` files inside the `WiPay/` plugin folder and import them into the
  main plugin files.
- `context` is passed to the plugin functions but is described as internal Wix use; we do not
  rely on it.

## getConfig() — confirmed shape (from the tutorial)

Exported function `getConfig()` returns:

```js
{
  title: "WiPay",  // required — Wix: the name of the payment service provider as a string; shown in dashboard provider selection
  paymentMethods: [  // required — Wix: an array of paymentMethod objects
    {
      hostedPage: {
        title: "WiPay",      // required — Wix: the payment method title as a string         // billingAddressMandatoryFields: ["EMAIL","FIRST_NAME","LAST_NAME","COUNTRY_CODE"],
      }
    }
  ],
  credentialsFields: [  // required — Wix: at least 1 credentials object is required; keep fields separate by purpose
    // 1) Payments API account number — identifies the merchant on Payment Request; no auth header.
    {
      simpleField: {
        name: "accountNumber",
        label: "WiPay Account Number"
      }
    },
    // 2) Payments API account API Key — server-side only; used for buyer-return hash verification.
    {
      simpleField: {
        name: "accountApiKey",
        label: "WiPay Account API Key (for response-hash verification)"
      }
    },
    // 3) WAPI credential for refunds — either a WAPI Key (X-WAPI-Key) or OAuth bearer token.
    //    WAPI Keys are created on the Developer page -> WAPI Keys; plaintext shown once.
    {
      simpleField: {
        name: "wapiCredential",
        label: "WiPay WAPI Credential for refunds (WAPI Key, or Bearer token)"
      }
    },
    // 4) Webhook endpoint signing secret — separate from all of the above; verify webhook HMAC.
    {
      simpleField: {
        name: "webhookSecret",
        label: "WiPay Webhook Signing Secret (for webhook verification)"
      }
    }
  ]
}
```

- Only `hostedPage` is supported as a payment-method key in this Velo service plugin. The tutorial says
  "For now, only 'hostedPage' is supported." (`supportedOrderMethods` is **not** among the properties the
  readable tutorial lists for the hostedPage object; confirm from the Wix reference whether it is valid — we
  do not assume it is.)
- `credentialsFields` supports `simpleField`, `checkboxField`, and `dropdownField`. The tutorial says:
  `simpleField` and `checkboxField` have `name` + `label` (checkboxField also has `tooltip`); `dropdownField`
  has `name`, `label`, and `options`, where each option has `key` and `value`. The `name` in each is the key
  we receive later.
- `billingAddressMandatoryFields` allowed values per the Wix tutorial: `ZIPCODE`, `CITY`, `STATE`,
  `ADDRESS`, `COUNTRY_CODE`, `EMAIL`, `PHONE`, `FIRST_NAME`, `LAST_NAME`, `STREET`, `HOUSE_NUMBER`,   `TAX_IDENTIFIER`. The example here shows three of them; expand to the full allowed set when/if we require
   more billing fields.
- `logos` is described by the tutorial as an object of logo URLs (for white/colored backgrounds). The
   tutorial text does **not** page-verify the exact subfield names (e.g. `light` / `dark`); the code comment
   above is an educated guess, not a confirmed field name. Confirm from the Wix reference before shipping
   logo branding.

Note: the exact logo object shape and any other `hostedPage` return properties are defined in Wix's linked
reference; the readable tutorial did not expose the example code block. We keep the config minimal and confirm
the rest before expanding.

Note: the exact logo object shape and any other `hostedPage` return properties are defined in Wix's linked
reference; the readable tutorial did not expose the example code block. We keep the config minimal and confirm
the rest before expanding.

## Plugin lifecycle methods (confirmed from the tutorial)

### connectAccount(options, context)

- Called when the merchant clicks **Connect** on the Connect page.
- `options` contains the credentials entered on the Connect page plus site info we may need.
- On success, return the provider account info / credentials; Wix passes those credentials to
  `createTransaction()` and `refundTransaction()`.
- On failure, return an error object instead of account details.

### createTransaction(options, context)

- Called when the buyer clicks **Place Order**.
- `options` contains site + order + redirect-URL information (exact fields in Wix's reference).
- Returns an object containing `pluginTransactionId` (the provider's transaction ID).
- For a hosted-page flow, we also return the redirect target so Wix sends the buyer to WiPay's
  hosted checkout (confirming the exact Wix return property name from the reference first;
  we do not yet assume it equals `url`).

### refundTransaction(options, context)

- Called when a merchant initiates a refund from the Orders dashboard.
- `options` contains transaction + refund-amount information.
- On success, return an object containing `pluginRefundId` (provider's refund ID).
- If the provider does not approve, return an error shape that explains why.

Example failure shape visible in the tutorial:

```js
{
  reasonCode: 3025,
  errorCode: "INSUFFICIENT_FUNDS_FOR_REFUND",
  errorMessage: "Insufficient funds for refund"
}
```

The Wix tutorial lists `reasonCode: 3025` (Insufficient funds for refund) as one example. The Wix Reason Codes search snippet lists these additional refund reason codes: `3022` (Refund not allowed), `3023` (Payment already refunded), `3024` (Partial refund not allowed), and `3032` (Refund attempts exceeded). These code values are **snippet-only**, not verified from the readable Reason Codes page text; we will confirm the full allowed reason-code / error-code contract from the Wix reference before finalizing. We will not invent additional error codes or assume this is the complete allowed list.

## HTTP callbacks / submitEvent() (confirmed from the tutorial)

Flow:

1. In `createTransaction()`, create the WiPay transaction and supply WiPay with a callback URL
   on the Wix site.
2. Expose an HTTP function in `backend/http-functions.js` for the provider's status callback.
3. In the handler, call `submitEvent()` (from Wix's payment-provider backend module) to mark the
   transaction status.
4. For refunds, supply a callback URL when creating the refund and call `submitEvent()` when the
   provider reports the refund result.

Indexed fragment from the tutorial's callback example (snippet, not fully verified from readable page text):

```js
import wixPaymentProviderBackend from "wix-payment-provider-backend";

// ... inside an HTTP function that receives the provider callback:
submitEvent({
  event: {
    transaction: {
      wixTransactionId: request.query["wixTransactionId"],
      pluginTransactionId: /* provider transaction ID */
      // ... other event properties per Wix reference
    }
  }
});
```

What we can say from readable/available sources:
- The tutorial says to use Wix HTTP Functions for the provider callback and to call `submitEvent()` in those
  endpoints to update transaction or refund status. It also says to give the provider the callback URL when
  creating a transaction or refund.
- The tutorial snippet points to:
  - import from `"wix-payment-provider-backend"` (snippet-only)
  - reading callback values from `request.query["wixTransactionId"]` (snippet-only)
  - a transaction event shape containing `event.transaction.wixTransactionId` and `pluginTransactionId`
    (snippet-only)
- The HTTP function is exported with a name combining the HTTP method + endpoint name and receives `(request)`
  and returns a response object (tutorial prose, not snippet).
- A submitted transaction update causes the associated order to appear in the Orders dashboard; a completed
  refund update marks the order as refunded (tutorial prose).
- Refunds are initiated from the Wix Orders tab / Orders dashboard (tutorial prose).

**Not verified from readable source:** the complete `submitEvent()` event shape, the exact status values Wix
accepts for transaction vs refund updates, whether refund updates use a separate `event.refund` shape, the
exact exported HTTP function naming, and whether every callback arrives via `request.query` vs `request.body`.
The Wix submitEvent / createTransaction / refundTransaction / reason-codes / sample-payment-flows reference pages
were not extractable in our reads. Do **not** invent event fields, status values, or additional error codes; confirm from the Wix
reference before shipping.

## WiPay contract we map onto this (confirmed from WiPay docs + prior Waypoint work)

### Payment Request (session creation)

- Endpoint: `POST {base}/plugins/payments/request`
- TT sandbox base: `https://ttsb.wipayfinancial.com`
- TT live base: `https://tt.wipayfinancial.com`
- Set environment via the request field `environment` (`sandbox` / `live`) in addition to the host.

Required fields (from current WiPay docs):

- `account_number` — merchant account; sandbox uses `1234567890`
- `country_code` — processing platform, uppercase ISO (`TT`, `JM`, `BB`, `GY`, `GD`)
- `currency` — uppercase ISO 4217
- `environment` — `sandbox` or `live`
- `fee_structure` — `customer_pay`, `merchant_absorb`, or `split`
- `method` — `credit_card_co` (full hosted checkout) or `3co_simple` (simplified hosted checkout)
- `order_id` — unique; alphanumeric, hyphens, underscores; recommended max 16 chars; no leading/trailing `-` or `_`
- `origin` — app identifier; 1–32 chars, alphanumeric, hyphens, underscores; no leading/trailing hyphen/underscore
- `response_url` — where WiPay redirects the buyer after checkout
- `total` — amount within currency limits
- `email` — customer email; must differ from merchant's registered email

Optional: `data` (pass-through echoed in return + webhook), customer name/address/phone,
`version`, billing `country`.

Response (successful):

```json
{
  "url": "https://tt.wipayfinancial.com/checkout/payment?...",
  "message": "OK",
  "transaction_id": "..."
}
```

- Save `transaction_id` immediately as the WiPay reference and as the basis for
  `pluginTransactionId`.
- Redirect the buyer to `url`.
- A failed request may include `message` + error `url` + empty `transaction_id`; do not treat as
  a successful session.

### Buyer return (response_url)

- WiPay redirects the buyer's browser to `response_url` via **GET** with query-string result
  fields.
- Typical fields: `status`, `transaction_id`, `order_id`, `total`, `message`, `date`, `currency`,
  and when present `hash`, `data`, and customer/card display fields.
- `status=success` or `status=failed`; the hash is returned only for successful transactions.
- Treat the return as untrusted until verified.

Hash verification:

```text
MD5(transaction_id + original_total + api_key)
```

- Use WiPay's `transaction_id`, the **original submitted amount formatted to exactly two decimals**
  (e.g. `10.00`), and the account API key.
- Do **not** hash the buyer-facing `total` returned in the redirect.
- Sandbox API key: `123`. Keep the key on the server, never in Wix frontend code.
- Optionally corroborate via WAPI transaction retrieval.
- This is the **account's API Key** (separate from WAPI credentials and from the webhook signing
  secret). The documented sandbox API Key `123` is used for hash verification only — it is **not** a
  Payment Request credential (the Payment Request endpoint has no auth header) and **not** a WAPI
  credential.

### Webhooks

- `POST`, JSON body, to a public HTTPS endpoint registered in the WiPay dashboard.
- Headers (page-text-verified from `docs.wipayfinancial.com/webhooks`):
  - `X-WiPay-Webhook-Signature: sha256=<hex>` — HMAC-SHA256 signature of `timestamp + "." + raw_body`
    using the endpoint signing secret; compare the received hex with a constant-time comparison.
  - `X-WiPay-Webhook-Timestamp` — Unix timestamp in seconds (UTC).
  - `X-WiPay-Webhook-Id` — event UUID, reused across retries; use as the idempotency key (dedup).
  - `X-WiPay-Webhook-Event` — event type.
  - `X-WiPay-Webhook-Version` — signature-scheme version (currently `v1`).
- Verify HMAC-SHA256 over `timestamp + "." + exact_raw_request_body` using the endpoint signing
  secret; constant-time compare the hex digest.
- Reject missing/malformed/invalid signatures; reject timestamps outside a ~5-minute tolerance.
- Deduplicate by envelope `id` / `X-WiPay-Webhook-Id`; durably accept then return 2xx.
- Payments API events include: `payment.created`, `payment.success`, `payment.failed`,
  `payment.error`, `payment.chargeback_pending`, `payment.chargeback_processed`,
  `payment.chargeback_released`, `payment.refund_requested`, `payment.refunded`,
  `payment.refund_rejected`, `payment.fraud_confirmed`.
- Use envelope `event` as the lifecycle signal; `data.status` is a coarse snapshot and can remain
  `success` during later refund/chargeback events.

### Refund

- WiPay refund via WAPI: `POST {base}/wapi/transactions/{transaction_id}/refund`
- Authenticated with a **WAPI credential**, not the Payments API account number or account API Key:
  either `Authorization: Bearer <access_token>` (OAuth bearer; access tokens last 12 hours, refresh
  token usable 6 hours after expiry) **or** `X-WAPI-Key: <wapi_key>` (WAPI Key) — send exactly one,
  never both. Requests that send both, send neither, or use an invalid/expired/revoked credential are
  rejected with 401.
- WAPI Keys: format `wapi_{environment}_{kid}_{secret}` (e.g. `wapi_live_a1b2c3d4e5f6g7h8i9_...`);
  `wapi_live_...` keys authenticate against live platforms, `wapi_test_...` keys against sandbox
  platforms; a live key cannot authenticate a sandbox endpoint and vice versa. Created and managed on
  the WiPay dashboard **Developer page** → **WAPI Keys** tab; the plaintext key is shown once and
  cannot be retrieved again — WiPay stores only an HMAC-SHA256 hash. WAPI Keys are available only to
  verified WiPay **BUSINESS** accounts (KYC 3); PERSONAL accounts must use the OAuth bearer-token flow.
  The WAPI changelog lists the refund scope as `wapi-transactions-refund-request`.
- Documented request: transaction id in path; the refund page shows Bearer auth — the shared WAPI
  Getting Started page says protected WAPI routes accept exactly one of `Authorization: Bearer`
  (OAuth bearer) or `X-WAPI-Key`.
- Eligibility: transaction `status=success` and normal status; receiver must have sufficient
  balance.
- Documented success response: `{"message": "Refund request successfully created."}` — this response
  carries **no refund ID/reference field** in the current docs, so treat it as a refund *request*
  confirmation, not an immediate refund completion.
- Definitive refund OUTCOME arrives via webhooks — Payments API events `payment.refund_requested`,
  `payment.refunded`, `payment.refund_rejected`. (Note: these are documented under the Payments API
  webhook events; the docs do not explicitly tie them to WAPI refund requests in the text we read, so
  confirm the refund-event flow for the merchant account before depending on it.)
- **Gap for the plugin (unchanged, not closed):** Wix expects `refundTransaction()` to return
  `pluginRefundId` and report completion through the provider callback; WiPay's documented refund
  endpoint is a refund *request* whose documented success response is just a message with no refund id.
  The plugin currently bridges this by: (1) creating the WAPI refund request; (2) using a WiPay refund
  reference if the WAPI response ever carries one, otherwise a plugin-local refund id; and (3) reporting
  the refund as PENDING through the callback until the webhook confirms completion. Do **not** invent a
  refund ID or mark a refund complete just because the request was accepted — that depends on the actual
  WAPI refund response shape and the merchant’s refund-event flow, both of which still need confirmation. In addition, do **not** invent additional error codes or assume the snippet-only codes below (3022, 3023, 3024, 3025, 3032) are the complete allowed list — confirm the full allowed reason-code / error-code contract from the Wix reference before shipping.
  In addition, do **not** invent additional error codes or assume the snippet-only codes below (3022,
  3023, 3024, 3025, 3032) are the complete allowed list — confirm the full allowed reason-code / error-code
  contract from the Wix reference before shipping.

### Sandbox testing

- Sandbox account number `1234567890`, environment `sandbox`, hash key `123`.
- WiPay **does** publish sandbox test cards — it does **not** say there is no test-card matrix. See
  `docs.wipayfinancial.com/payments-api/testing`. For the target territory (TT) use the TTD hosted-
  checkout / TTD 3DS test sets, which are documented as **not interchangeable** with the USD/other-currency
  card sets. Example USD/other-currency standard cards: `4242424242424242` (Visa success),
  `4000000000000002` (Visa decline), `5555555555554444` (Mastercard success). Confirm the exact TTD set
  for the target account/territory from the testing page before relying on any specific card number for TT
  sandbox end-to-end testing; do not substitute another processor's test cards.
- Hash verification in sandbox uses the account API key `123`; that key is for hash verification only,
  not a Payment Request credential or a WAPI credential.

## Credentials model — decided

WiPay documents **four separate credential materials**, not one universal secret:

| Job | Credential | Where the merchant gets it | How the plugin uses it |
|---|---|---|---|
| Create a Payments API checkout session | **Account number** (`account_number`) — no auth header; it identifies the merchant in the request body | Live account number from the verified WiPay Business account | Send in Payment Request body; sandbox uses `1234567890` |
| Verify the buyer-return / transaction-response hash | **Account API Key** — server-side only, used in `md5(transaction_id + original_total + api_key)` | Account API Key kept on the server (dashboard location to confirm); sandbox API Key is `123` for hash verification only | Recompute and compare the hash server-side before fulfilling; never expose client-side |
| Issue a WAPI refund | **WAPI credential** — either `Authorization: Bearer <access_token>` (OAuth bearer; access tokens last 12h, refresh token usable 6h after expiry) **or** `X-WAPI-Key: <wapi_key>` (WAPI Key); send exactly one, never both | Developer page → WAPI Keys (Business/KYC-3 only) for a WAPI Key; or WAPI auth endpoints for a bearer token | Call `POST .../wapi/transactions/{transaction_id}/refund`; 401 if credential is invalid/expired/revoked/missing/wrong-environment |
| Verify webhook signatures | **Webhook endpoint signing secret** — separate from all of the above | Developer page; shown when the webhook endpoint is created/rotated | HMAC-SHA256 over `timestamp + "." + raw_body`; constant-time compare; reject outside ~5-minute tolerance |

Key account-type facts the Connect page and docs must state:

- A **verified WiPay BUSINESS account (KYC 3)** is required for a live `account_number` and for
  creating WAPI Keys. WAPI Keys are **not** available to PERSONAL accounts — a PERSONAL account
  must use OAuth bearer for WAPI.
- WAPI Keys carry an environment prefix (`wapi_live_...` vs `wapi_test_...`); a live key cannot
  authenticate a sandbox endpoint and vice versa. So a sandbox + live plugin deployment needs the
  matching WAPI credential for each, or the merchant switches credentials per environment.
- The sandbox API Key `123` is **only** for server-side hash verification — it is **not** a Payment
  Request credential (the Payment Request endpoint has no auth header) and **not** a WAPI credential.
- Webhooks, WAPI Keys, and (where applicable) the account API Key are created/rotated on the WiPay
  **Developer page**; the plaintext is shown once for WAPI Keys and for webhook secrets.

Practical implication for the Connect page: collect **separate fields** — account number, account
API Key, WAPI credential for refunds, and webhook signing secret — rather than a single "API token."
This is forward-compatible if a merchant only has some of these today (e.g. a merchant without WAPI
refund credentials can still do checkout + return verification), and it avoids pretending one secret
covers four differently-authenticated WiPay operations.

## Known reference-confirmation gaps before finalizing code

1. Wix's exact `createTransaction()` `options` fields (order details + redirect URLs) — not verified
   from readable Wix source; the Velo tutorial says `options` contains site/order/redirect-URL info and
   the return must include `pluginTransactionId`, but the exact option/return objects are in code blocks
   that did not render into readable text. The sample-payment-flows snippet points to `order.returnUrls`
   + `redirectUrl` but that page itself was not extractable.
2. The exact Wix return property name for the hosted-page redirect — not verified from readable Wix
   source. Snippet hints at `redirectUrl`, but confirm from the live Wix reference; do not hard-code the
   return field from guesswork.
3. The full `submitEvent()` transaction and refund event shape — not verified from readable Wix source.
   Snippet points to `wixPaymentProviderBackend` import and `request.query["wixTransactionId"]`, but the
   complete event schema/status values are in a reference page that was not extractable.
4. The full `refundTransaction()` failure-result contract and allowed error codes — not verified from
   readable Wix source. The Reason Codes page snippet hints at `3022`–`3025` (refund not allowed / already
   refunded / partial refund not allowed / insufficient funds), but the page itself was not extractable.
5. The exact WAPI scope required for the refund route — resolved: WAPI changelog lists `wapi-transactions-refund-request`.
6. The WiPay dashboard location for the Payments API account API Key — still open: docs describe the
   account's API Key but do not name the exact dashboard path beyond the Developer page for WAPI Keys and
   webhook secrets.

## TODO

- [ ] Read Wix's service-plugin reference pages for `getConfig`, `createTransaction`, `refundTransaction`,
      and `submitEvent` to finalize option/return/event types. **This is the blocking item** — the WiPay
      side is implemented and tested; the Wix shapes are what remain.

- [x] Decide the order_id / origin generation and idempotency strategy inside `createTransaction`.
      **Decided:** `generateOrderId()` in `wipay-core.js` derives a deterministic 16-char alphanumeric
      id from a SHA-256 of the Wix order reference (`wix` + 13 hex chars), so a retry of the same order
      reuses the same id. `origin` is the fixed app identifier `WaypointWix` (1–32 chars, alphanumeric,
      within the documented rules). Covered by the harness.

- [x] Adopt Wix redirection/hosted-page model from Wix docs (confirmed from sample-payment-flows page):
   - Wix sends `order.returnUrls` (success / error / cancel / pending) in the Create Transaction request.
   - For hosted-page payments, the PSP returns `redirectUrl`; Wix opens that URL in an iframe or browser window for the buyer to complete.
   - The buyer lands on the appropriate `returnUrl`; final status is delivered by the PSP to Wix via Submit Event, not returned as a final value from Create Transaction.
   - For hosted-page payments, the `paymentMethod` value in the Create Transaction request is a string representing the PSP's Wix app ID.
   - Hard constraint from Wix docs: "Hosted-page payment methods don't support 3D Secure verification or recurring payments." (Snippet-only from the Wix sample-payment-flows search result; the page itself was not extractable — do not treat this as page-text-verified.)
   - Open item: exact JSON shapes for the Create Transaction request and Submit Event webhook are shown in Wix docs as "Copy" code blocks that did not render into extracted text; do not hard-code field names from guesswork — confirm from the live Wix page before shipping.

- [x] Decide how the buyer-return callback finds the original amount for hash verification (store it
      on the Wix side? pass as `data`?).
      **Decided: pass it as `data`.** WiPay documents `data` as echoed back in both the buyer return and
      the webhook, which makes it a contract-backed carrier that needs no database and survives isolate
      recycling. `createTransaction` pins `data = { order_id, total: "10.00" }` alongside the request;
      `handleBuyerReturn` reads the total from that echo first and falls back to a process-local map.
      If neither yields a total the callback is **rejected**, never verified against a guess — and a
      success return without a hash is rejected outright, since WiPay only omits the hash on failure.
      This closes the "store vs. `data`" question; see `resolveOriginalTotal` in `WiPay.js`.

- [ ] Decide whether Wix routes transaction status / refund status / signed webhooks through one callback path or separate endpoints, and where the signed webhook handler should live relative to the plugin (Wix HTTP function vs. external HTTPS endpoint). This is not settled by the tutorial prose alone.

- [ ] Resolve where an HTTP function reads `context.credentials` server-side. `createTransaction()` gets
      them from Wix; a callback invoked by WiPay's redirect does not obviously receive that context.
      Until this is answered `http-functions.js` deliberately **fails closed with 500** — a callback that
      cannot verify must never report success.

- [ ] Implement the `submitEvent` wiring. Verification is complete; nothing yet reports the verified
      result back to Wix, so orders will not appear in Wix Orders without it.

## Implementation status (2026-10-19)

| WiPay-side path | Status |
|---|---|
| Payment Request payload + POST | Implemented; field names corrected (`account_number`, `fname`/`lname`/`phone`, `credit_card_co`) — an earlier draft sent `account`, `first_name`, `phone_number` and a `WIX_APP_ID_FOR_WIPAY` placeholder method, all wrong. |
| Response validation | Implemented; non-200, non-JSON, non-wipayfinancial and missing-txn responses all rejected. |
| Buyer-return hash verify | Implemented; pinned original total, constant-time compare, no-hash-on-success rejected. |
| Webhook signature verify | Implemented; HMAC-SHA256 over `timestamp + "." + raw_body`, ±300s window, dedupe id surfaced. |
| WAPI refund | Implemented; exactly one of `X-WAPI-Key` / `Bearer`, environment derived from the key prefix, cross-environment rejected. Reports PENDING, never an invented completion. |
| Pure-JS MD5 / SHA-256 / HMAC | Implemented and cross-checked against Node crypto (Velo has no built-in crypto). |
| Wix `submitEvent` + credential lookup from HTTP functions | **Not implemented** — blocked on the Wix reference shapes above. |

