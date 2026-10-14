# Platform research: Wix

## Status
Partner-feasibility workspace. No Waypoint-supported Wix payment provider exists.

## Hard constraint
Wix documents a Velo-based payment-provider service plugin for providers that are **not** Wix-supported PSPs, but that plugin is explicitly scoped to **a single merchant's own site** and cannot be published to the Wix App Market. Broad availability across Wix merchants would require Wix PSP onboarding through the separate REST PSP service-plugin path. A WiPay directory button alone does not confirm a supported package.
- [Velo payment-provider service plugin](https://dev.wix.com/docs/develop-websites/articles/code-tutorials/wix-pay/tutorial-payment-provider-service-plugin)
- [PSP service plugin introduction](https://dev.wix.com/docs/api-reference/business-management/payments/payment-service-provider-service-plugin/introduction)

## What is buildable today
A per-site, DIY WiPay hosted-checkout integration is a credible Velo path. The plugin supports `hostedPage`, calls the provider when the visitor places an order, passes order and redirect information, and can receive provider status callbacks to update the transaction. Wix's Velo backend APIs also expose order creation, order updates, and payment-record APIs, so the integration can write back order/payment state on a single site rather than only redirecting and leaving the order untouched.
- [Create order (Velo backend)](https://dev.wix.com/docs/velo/apis/wix-ecom-backend/orders/create-order)
- [Update order (Velo backend)](https://dev.wix.com/docs/velo/apis/wix-ecom-backend/orders/update-order)
- [Add payment records (Velo backend)](https://dev.wix.com/docs/velo/apis/wix-ecom-backend/order-transactions/add-payments)

## What is not buildable today
A generally installable Wix App Market provider for all Wix merchants is not an available self-service path; that depends on Wix PSP onboarding and partnership, not on publishing site-specific code.

## WiPay-specific open point
It is not resolved by the public docs whether Wix will onboard WiPay as a broadly available PSP, or whether a WiPay package already exists for Wix merchants.

## Recommended next steps
1. Pilot a single-site Velo `hostedPage` integration with signature verification and callbacks, and treat it as a merchant-specific tool rather than a marketplace product.
2. Ask Wix about onboarding WiPay through the REST PSP service-plugin path if broad merchant availability is the goal.
3. Confirm territories, accepted card methods, refund handling, incident response, settlement/reconciliation, and support ownership before any production-facing deliverable.
4. Keep it clear in any document that a site-specific Velo integration is not equivalent to a generally installable Wix payment provider.

## References
- [Wix PSP onboarding](https://dev.wix.com/docs/api-reference/business-management/payments/payment-service-provider-service-plugin/introduction)
- [WiPay Plugin Integration Guides](https://wipaycaribbean.com/solutions/plugins)
- [WiPay Payments API](https://docs.wipayfinancial.com/payments-api)
