# Waypoint WiPay for Wix

An independent Wix integration research project maintained by Waypoint. It is not affiliated with, sponsored by, or endorsed by WiPay.

## Project status

**Per-site build scaffolded; not production-ready.** No Waypoint-supported Wix payment provider is available for general distribution — that requires WiPay to complete Wix PSP onboarding. What this repo does contain is a site-specific Velo Payment Provider Service Plugin scaffold (in `Service Plugins/payment-provider/WiPay/`) that implements the WiPay hosted-page flow for a single merchant's own Wix site. The scaffold is **untested against a live Wix site** and still carries documented stubs and Wix-contract TODOs; see [SERVICE-PLUGIN-CONTRACT-NOTES.md](SERVICE-PLUGIN-CONTRACT-NOTES.md) for the exact gaps.

## What you can actually do with WiPay on Wix today

A Wix site can take WiPay payments through a DIY, per-site integration rather than through a published Wix App Market provider. The documented route is a Velo-based payment-provider service plugin that supports `hostedPage`, passes order and redirect information, and can receive provider status callbacks. Combined with Wix's Velo backend order and payment APIs, a single-site build can create or update order records and payment state on that site instead of only opening the WiPay hosted page and leaving the order untouched.

That is a merchant-specific tool for one site, not a generally installable Wix payment provider. A site-specific Velo integration is not equivalent to a marketplace product, and broad availability across Wix merchants would require Wix PSP onboarding and partnership work that is not in scope for this repository.

If you only need WiPay on your own Wix store, this is the most credible path to build from. If you want a one-click installable provider for many Wix merchants, this repo does not solve that today.

## What is in this repo

- `Service Plugins/payment-provider/WiPay/` — the Velo Payment Provider Service Plugin scaffold: `WiPay-config.js` (getConfig: title, `hostedPage` method, four credential fields), `WiPay.js` (connectAccount / createTransaction / refundTransaction plus buyer-return, refund-status and webhook handlers), `http-functions.js` (callback stubs). The payment and refund HTTP calls, the response-hash computation and the Wix `submitEvent` wiring are **stubbed with TODOs** — the scaffold documents the contract, it does not yet move money.
- [SERVICE-PLUGIN-CONTRACT-NOTES.md](SERVICE-PLUGIN-CONTRACT-NOTES.md) — the working contract notes for the build: Wix file layout, getConfig shape, plugin lifecycle methods, HTTP callbacks / submitEvent, and the WiPay contract (Payment Request, buyer return, webhooks, refund, sandbox) mapped onto them, plus the reference-confirmation gaps.
- [PLATFORM-RESEARCH.md](PLATFORM-RESEARCH.md) — the platform research: the hard constraint, the per-site Velo route, the PSP onboarding distinction, and official references.
- [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) — third-party platform notices (Wix, WiPay).

## Research

See [PLATFORM-RESEARCH.md](PLATFORM-RESEARCH.md) for the hard constraint, the per-site Velo route, the PSP onboarding distinction, and official references.

## Ownership and disclaimer

Waypoint maintains this independent research project. WiPay does not endorse it. Use is at your own risk; no warranty is provided.
