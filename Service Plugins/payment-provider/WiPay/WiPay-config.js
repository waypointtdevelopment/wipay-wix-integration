
/**
 * @file WiPay-config.js
 * @description Config for the WiPay Payment Provider Service Plugin.
 *
 * Wix documentation: https://dev.wix.com/docs/rest-api/velo/backend-services/payment-provider-service-plugin/getting-started
 * The getConfig() function defines the plugin’s title, payment methods, and the credential
 * fields Wix will surface on the Connect page and pass to createTransaction / refundTransaction.
 *
 * The four Wix credential fields map onto four separately-authenticated WiPay operations:
 *   1. WiPay account number            -> Payment Request identity (no auth header)
 *   2. Account API Key                -> buyer-return hash verification (server-side only)
 *   3. WAPI credential for refunds    -> WAPI refund endpoint (X-WAPI-Key OR OAuth bearer, not both)
 *   4. Webhook signing secret         -> webhook HMAC verification (server-side)
 *
 * Field IDs must be the exact strings Wix returns in context.credentials when the merchant
 * completes the Connect flow. These IDs are chosen here and must match what the plugin code
 * reads. Do not rename them after the first merchant connects.
 *
 * TODO (exact field labels / Wix Connect-page rendering): confirm the exact Connect-page
 * field labels and whether Wix treats long credential fields as multi-line text or hidden
 * token fields from the Wix service-plugin reference. Current labels are descriptive; keep
 * them consistent with the credential decision in SERVICE-PLUGIN-CONTRACT-NOTES.md.
 */

export function getConfig() {
  return {
    title: 'WiPay',
    paymentMethods: [
      {
        id: 'hostedPage',
        name: 'WiPay Hosted Page',
        // Wix renders this as the payment option label the buyer sees at checkout.
        // The exact branding/logo rules are Wix-side; we keep a plain text name here.
        supportedOrderMethods: ['hostedPage'],
      },
    ],
    // The credentials the merchant enters on the Connect page. Wix stores these and
    // returns them inside context.credentials for createTransaction / refundTransaction.
    credentialsFields: [
      {
        id: 'accountNumber',
        label: 'WiPay Account Number',
        // The merchant’s WiPay account number. Used as the Payment Request account identity.
        // This value is not auth: the Payments API accepts the account number without an auth header.
        // Public or semi-public identifier; keep label plain.
        type: 'text',
        required: true,
      },
      {
        id: 'accountApiKey',
        label: 'Account API Key',
        // Server-side only. The Payments API uses this to verify the buyer-return response hash.
        // Hash verification needs the API key plus the original order amount — keep it server-side.
        // This is a secret credential; do not log it or return it to the browser.
        type: 'text',
        required: true,
      },
      {
        id: 'wapiCredential',
        label: 'WAPI Credential for Refunds',
        // Used for the WAPI refund endpoint. Pick ONE of:
        //   (a) WAPI Key as the literal string value (sent as X-WAPI-Key), or
        //   (b) an OAuth bearer token value (sent as Authorization: Bearer ...)
        //
        // WAPI Keys require a verified WiPay BUSINESS account (KYC 3). PERSONAL accounts must use
        // OAuth bearer for WAPI. The merchant’s account type determines which form to expect.
        //
        // WiPay WAPI Keys are managed on the WiPay dashboard (Developer page -> WAPI Keys), and each
        // key is prefixed with its environment. Use the SANDBOX-prefix key for sandbox testing and the
        // LIVE-prefix key for live refunds — do not cross them.
        //
        // Important: the WAPI response prints the key ONCE at creation time, then never shows it again.
        // Merchants must store the value when it is shown; there is no “copy it back from the dashboard”.
        //
        // TODO (WAPI scope / account-API-Key dashboard path): WiPay’s dashboard path for the account’s
        // own Payments API Key is not yet confirmed from the docs; the WAPI Keys path above is sourced
        // in SERVICE-PLUGIN-CONTRACT-NOTES.md. Resolve both before treating refund auth as finalized.
        type: 'text',
        required: true,
      },
      {
        id: 'webhookSecret',
        label: 'Webhook Signing Secret',
        // Used to verify HMAC-signed webhooks from WiPay. Keep server-side only.
        // If webhooks are not in scope for the first cut, leave blank and ignore the webhook handler.
        type: 'text',
        required: false,
      },
    ],
  };
}
