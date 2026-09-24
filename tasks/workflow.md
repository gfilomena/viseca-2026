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
