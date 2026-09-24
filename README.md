# Swiss {ai} Weeks 2026: Viseca Challenge

This repository contains the materials for Viseca's Swiss {ai} Weeks 2026 hackathon challenge.

## Contents

- [challenge.md](challenge.md): Full public challenge brief and judging criteria.
- [technical_details.md](technical_details.md): Sandbox API and data contract.
- [data/](data/): Synthetic offline data pack, including scenarios, purchase attempts, reference data, and JSON schemas.

---

# Prototype: Leash — wallet control for AI shopping agents

Two independently deployable parts, as recommended in the brief:

| Part | Stack | Role |
| --- | --- | --- |
| `backend/` | Node 24 (native TypeScript), Fastify, built-in `node:sqlite` | Policy compiler, decision engine (approve / decline / step_up), run state, hosted-API worker |
| `frontend/` | Angular 22 (standalone, signals, zoneless) | Customer UI: describe → review → confirm, tighten, revoke; live purchase feed; step-up inbox |

The database (`backend/var/leash.db`) is built from every CSV in [`data/`](data/) on first start
(`npm run seed` to rebuild). Reference tables mirror the CSVs; `mandates`, `runs` and `decisions`
hold application state.

Before loading, the pack is verified against its own contracts (`backend/src/db/verify.ts`):
`metadata.json` against `data_pack.schema.json`, SHA-256 and row counts, CSV headers, keys and
foreign keys (`x-csv-contracts`), the history column contract (types, enums, nullability, ordering,
refund links), the currency formula and cart totals. Structural problems stop the seed; a changed
hash is only a warning. The report is shown on the *Customer data* page.

## Run it

```bash
npm run install:all
npm run backend          # http://localhost:3000  (seeds the DB on first start)
npm run frontend         # http://localhost:4200  (proxies /api to the backend)
npm test                 # replays all 45 purchases + policy/HITL/revocation tests
```

Offline replay works without a key. To use the hosted simulator, start the backend with
`TEAM_API_KEY=<key> npm run backend`: confirmed policies are mirrored to `/v1/mandates`,
and a long-polling worker answers `/v1/decision-requests/next` within the 8-second deadline.
Every 5 s the backend reconciles live step-ups whose human window has passed, and answers whose
submission failed, with `/v1/authorizations`; until then a failed submission is not counted as
spend, and a step-up the platform stays silent about is closed as expired (never approved).

The API has no login (single-customer prototype). It listens on `127.0.0.1` (`HOST` to change) and
only accepts browser requests from the UI origin (`CORS_ORIGINS`, default `http://localhost:4200`);
requests carrying any other `Origin` are refused, so another website cannot approve a step-up.

## How a decision is made

1. **Customer rules** (`hard_rules`, all combined with AND) — any failure → `decline`.
2. **Built-in protections**, independent of wording: lookalike sellers (→ decline), duplicates of an
   approved order within 24 h (→ decline), prompt-injection in shop text, split orders around a
   per-order limit, re-quotes of open orders, amount/FX consistency.
3. **Card, account and delegation** from the bank's reference data: card status and expiry,
   online/abroad switches, the account's per-payment and monthly limits (monthly spend from the
   history of all the account's cards plus this run), and the delegation window in
   `scenario_authorities.csv` — any failure → `decline`.
4. **Customer preferences** from `customers.csv` (e.g. "avoids gift vouchers", "no marketplace
   add-ons", "clear return terms"): not part of the confirmed policy, so a conflict only makes the
   purchase uncertain — never a decline on its own.
5. **Session signals** from the card's history: new device, bursts (`recent_attempt_count_10m ≥ 2`),
   night-time, first-time country, unusual amount. Escalated when the instruction asks to watch for
   "someone other than me".
6. Anything **uncertain** (missing return terms, no size stated, manipulated text, risky session)
   follows the customer's `uncertainty_policy`: `ask` → `step_up`, or `decline` / `approve`.

The engine is deterministic (sub-millisecond per decision, no model in the decision path), so it stays
predictable when external services fail; any internal error falls back to a non-approving answer.
It never looks at scenario names, IDs or positions.

Merchant text (`item_details`) is untrusted: only size and return-window facts are extracted with
strict patterns, and instruction-like text is flagged and ignored — it can never change a limit.

Rolling limits count only **final approvals** in simulated time; a step-up counts once the customer
approves it. If a late approval would breach a rolling limit, the inbox warns before they answer.

## Rule vocabulary (`hard_rules[].field`)

| Field | Meaning |
| --- | --- |
| `authorization.billing_amount_chf` | Charged amount incl. delivery; `scope: purchase` per order, `scope: period` + `period_days` rolling window of approved spend |
| `items.item_id` / `items.item_category` | Every cart line must satisfy the rule |
| `items.attribute.size` | Size stated in shop text for the requested product (missing → uncertain) |
| `items.quantity_total` | Units in the basket |
| `basket.unrequested_lines` | Lines outside the requested product/category (add-ons) |
| `authorization.return_window_days` | From `order_returnable` + shop text; "final sale" = 0, unstated → uncertain |
| `authorization.fulfillment_method` | e.g. `delivery` |
| `authorization.local_hour` | Hour in Europe/Zurich |
| `merchant.merchant_category` / `merchant.merchant_country` | Registered merchant facts |
| `merchant.prior_approved_purchases` | Approved purchases on this card at this exact merchant ID (history + this run) |

Unknown fields are never ignored: they make the purchase uncertain.

## Customer control

- **Draft → confirm**: the instruction is compiled into checks with explanations, the phrase each came
  from, and open questions. Nothing is enforced until the customer confirms.
- **Tighten**: only adds rules or moves `uncertainty_policy` to `decline` (applies to new runs).
- **Revoke**: withdraws permission; offline pending step-ups are declined, new runs are refused.
- **Step-up**: the customer approves or declines in the inbox (120 s window; unanswered = not paid).

## Demo script

1. *Connection check* → interpret, confirm, run: approved with no friction.
2. *Manipulated agent* → injection text flagged (AU0040 asks you), lookalike seller declined,
   duplicate declined, add-on declined, legitimate re-quote approved.
3. *Household budget* → split order paused; approve it in the inbox; then revoke the policy.
