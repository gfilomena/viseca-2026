# Leash — wallet control for AI shopping agents

Our solution to Viseca's Swiss {ai} Weeks 2026 challenge *Agent on a Leash*.
The original challenge material is in [`resource/`](resource/):
[challenge brief](resource/challenge.md), [technical details](resource/technical_details.md) and the
[synthetic data pack](resource/data/).

```text
backend/    decision engine + API (Node 24, TypeScript, Fastify, SQLite)
frontend/   customer UI (Angular 22)
resource/   original Viseca material: challenge.md, technical_details.md, data/
tasks/      workflow trace
```

Two independently deployable parts, as recommended in the brief:

| Part | Stack | Role |
| --- | --- | --- |
| `backend/` | Node 24 (native TypeScript), Fastify, built-in `node:sqlite` | Policy compiler, decision engine (approve / decline / step_up), run state, hosted-API worker |
| `frontend/` | Angular 22 (standalone, signals, zoneless) | Customer UI: describe → review → confirm, tighten, revoke; live purchase feed; step-up inbox |

The database (`backend/var/leash.db`) is built from every CSV in [`resource/data/`](resource/data/) on first start
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

On start (and every 10 minutes, or *Check now* on the *Customer data* page) the backend reads the
platform's `/healthz` and, with a key, `/v1/bootstrap` and `/v1/reference-data`: the human window and
decision deadline are taken from the team settings when present (documented defaults 120 s / 8 s
otherwise), and the platform's `pack_version` is compared with the local data pack. When a poll returns
204 the worker checks `/v1/scenario-runs/{id}` and marks finished hosted runs as completed.
*Reset team data* calls `POST /v1/team/reset` (with a key) and clears local policies, runs and decisions.

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

## Optional language-model review of drafts

With `POLICY_LLM=on` (and Anthropic credentials, e.g. `ANTHROPIC_API_KEY`), each new draft is reviewed by
a language model (`POLICY_LLM_MODEL`, default `claude-opus-5`, low effort, 20 s timeout). It reads the
instruction and the built-in rules and may only **add** rules in the vocabulary below plus questions for
the customer; every suggestion is validated (known fields, operators, categories, item ids, ISO countries)
and shown as *suggested by the language model*. It never removes or edits a rule and is **never used to
decide a purchase**. On missing credentials, timeout, refusal or invalid output the built-in draft is used
unchanged, so behaviour stays predictable.

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

## Shop with your agent (home page)

The home page is a chat with a **simulated shopping agent**, to try wallet control by hand:

1. Pick **who you are shopping for** in the selector at the top of the page (all customers of the data
   pack; those without an active policy are marked and cannot buy). Their most recently confirmed wallet
   policy applies and is shown read-only. Then type a request, e.g.
   *"Buy the 27-inch monitor at PixelHarbor for CHF 289"*.
2. **Review**: the agent (`backend/src/agent/shopping-agent.ts`) shows, read-only, what it understood
   — catalogue product, quantity, price, delivery, shop and total — plus any doubt (e.g. a shop name
   that imitates one you know). The chat is deliberately minimal: no suggested products and no extra
   options to tweak. If it is not right, cancel and ask again. The customer's wallet policy alone decides.
3. **Try to buy**: the agent submits it as a schema-valid authorization event and wallet control
   answers `approve`, `decline` or `step_up`, with the checks and evidence.

**Asked you = an answer is expected.** A step-up (from the chat, a scenario replay or the hosted
simulator) is marked *Waiting for you*. Clicking that transaction — the row in *All transactions*, the
*Decide* button on its chat card, or the pending row in *Purchases* — opens a modal: why it was paused,
what exactly would be bought (with the untrusted shop text, flagged if it tried to give instructions),
the impact on rolling limits and a countdown, with **Approve** / **Decline** and an optional note.
Closing it keeps the purchase waiting; if nobody answers in time it is not made. Each answer is logged
by the backend (`[resolve]` with origin and user agent).

As the brief requires, wallet control is independent of the agent: the request and the offer can
never change the policy, which is read as currently confirmed (tightening applies immediately,
revocation stops the chat). Chat purchases use the real clock and are delegated by the policy itself
rather than by the scenario fixture windows. Below the chat, **All transactions** lists every decision
(chat, replays, simulator) with its outcome and reasons, filterable by approved / declined / asked.

## Customer control

- **Draft → confirm**: on *Wallet policy* the customer picks who the policy is for (any customer of the
  data pack; it applies to their delegated card, or their most used card) and writes the instruction in
  their own words. It is compiled into checks with explanations, the phrase each came from, and open
  questions. Active policies are listed in a table (customer, policy, checks, uncertainty choice,
  confirmation date) with *Details* (checks, run launcher, history), *Tighten* and *Revoke*. Nothing is enforced until the customer confirms. The exact original wording
  is stored and sent to the platform.
- **One active policy per card**: confirming a new policy replaces the previous one for that card
  (revoked on the platform, `superseded` locally; purchases waiting under it are declined). The draft
  warns before this happens.
- **Tighten**: only adds rules or moves `uncertainty_policy` to `decline` (applies to new runs).
- **Revoke**: withdraws permission; offline pending step-ups are declined, new runs are refused.
- **Step-up**: the customer approves or declines in the inbox (120 s window; unanswered = not paid).

## Demo script

1. *Connection check* → interpret, confirm, run: approved with no friction.
2. *Manipulated agent* → injection text flagged (AU0040 asks you), lookalike seller declined,
   duplicate declined, add-on declined, legitimate re-quote approved.
3. *Household budget* → split order paused; approve it in the inbox; then revoke the policy.
