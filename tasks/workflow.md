## Wallet control prototype (backend engine + Angular UI) — feat/wallet-control
DEFINE ⏭️ (challenge.md as spec) · PLAN ✅ · BUILD ✅ · VERIFY ✅ (10 tests, UI checked) · REVIEW ⬜ · SHIP ⬜
gates: spec/plan OK ("continua") · ship pending

## Data pack verification, issuer checks, customer preferences — feat/wallet-control
DEFINE ⏭️ (user list a/b/c) · PLAN ⏭️ (small scope) · BUILD ✅ · VERIFY ✅ (22 tests, UI checked) · REVIEW ⬜ · SHIP ⬜

## Code-review fixes (live run race, live reconciliation, unconfirmed spend, CORS) — feat/wallet-control
REVIEW ✅ (/code-review: 4 findings) · BUILD ✅ · VERIFY ✅ (28 tests, UI checked) · SHIP ✅ (f4a44e7 → gfilomena/viseca-2026)

## Move Viseca originals to resource/, app at root — chore/resource-layout
BUILD ✅ · VERIFY ✅ (28 tests, re-seed from resource/data verified in UI) · SHIP ✅ (PR + merge on fork)

## Shop chat home page (simulated agent → wallet control) + all-transactions table — feat/shop-chat
DEFINE ✅ (brief re-read: control independent of agent, untrusted shop text) · PLAN ✅ · BUILD ✅ · VERIFY ✅ (36 tests, UI flow in browser, mobile width) · REVIEW ⬜ · SHIP ✅ (PR + merge on fork)

## Step-up modal on click + read-only purchase review — feat/step-up-modal
DEFINE ✅ · BUILD ✅ · VERIFY ✅ (36 tests; browser: no auto-open, row click opens, Close keeps pending, Decline, read-only review, Enter to send) · SHIP ✅ (PR + merge on fork)

## Minimal chat (no suggested products, read-only summary only) — feat/minimal-chat
BUILD ✅ · VERIFY ✅ (build; browser: no suggestions, summary, decision card) · SHIP ✅ (PR + merge on fork)

## Shop page: choose the customer, policy derived — feat/shop-by-user
BUILD ✅ · VERIFY ✅ (36 tests, build, browser) · SHIP ✅ (PR + merge on fork)

## Shop: 'Shopping for' selector at the top with all users — feat/shop-for-selector
BUILD ✅ · VERIFY ✅ (tsc, build, browser: 20 users, no-policy user, policy user) · SHIP ✅ (PR + merge on fork)

## Audit fixes P1/P2 + optional policy LLM — feat/audit-fixes
DEFINE ✅ (audit) · PLAN ✅ · BUILD ✅ · VERIFY ✅ (49 tests, build, browser: platform card, replace warning) · REVIEW ⬜ · SHIP ✅ (PR + merge on fork)

## Wallet policy: input only + active policies table — feat/policy-input-only
BUILD ✅ · VERIFY ✅ (50 tests, build, browser 633px cards + 1280px table, draft for a customer without scenario) · SHIP ✅ (PR + merge on fork)

## Wallet policy table scoped to selected customer — feat/policy-filter-by-customer
BUILD ✅ · VERIFY ✅ (50 backend tests unaffected, build, browser: switched between 3 customers, correct rows/empty state each time) · SHIP ✅ (PR + merge on fork)

## Shop chat: propose any product, not just the catalogue — feat/shop-any-product
DEFINE ✅ · BUILD ✅ · VERIFY ✅ (54 backend tests incl. 4 new, frontend build, browser: non-catalogue product approved under an amount-only policy, and correctly declined under an item-specific policy) · SHIP ✅ (PR + merge on fork)

## Wire the remaining hosted-API endpoints; verify the full lifecycle live, fix a real 422 — feat/live-api-full
DEFINE ✅ · BUILD ✅ · VERIFY ✅ (61 backend tests, frontend build, full lifecycle run live against saw26api: bootstrap, mandate create/confirm, scenario-run, worker delivery+decision, /v1/authorizations, reconciliation) · REVIEW ⬜ · SHIP ⬜

## iOS-inspired mobile-first restyle (frontend/) — main
DEFINE ✅ (user brief, scoped to frontend/) · PLAN ✅ (mock approved) · BUILD ✅ · VERIFY ✅ (dev server, mobile+desktop, light+dark, ng build) · REVIEW ⬜ · SHIP ⬜
gates: plan OK (mock approved) · ship OK pending
files: styles.scss, index.html, app shell, step-up-modal, shop/policy/activity/data pages (templates+scss only, no .ts changed)
