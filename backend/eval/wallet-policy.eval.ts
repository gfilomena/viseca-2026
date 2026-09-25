/**
 * Eval for the wallet-policy interpreter (compileInstructionOpenAI, via the real
 * POST /api/mandates entry point — never reimplements the OpenAI call itself).
 *
 * Grading is a single general rubric judged by claude-haiku-4-5, not a hardcoded
 * per-case checklist of expected fields — a correct interpretation can reasonably
 * reach the same outcome through different field combinations, and a fixed checklist
 * would flag that as a false failure. The rubric is the same for all 15 cases.
 *
 * Three cases additionally replay SCEN0004's real purchase_attempts.csv rows (via
 * POST /api/runs, the same offline-replay path a real user hits) and check the engine's
 * actual decision — that's checking real behavior against real data, not a hardcoded
 * option list, so it stays as a direct assertion.
 *
 * Run: node --disable-warning=ExperimentalWarning backend/eval/wallet-policy.eval.ts
 * Requires: the backend running on :3000 with OPENAI_API_KEY set, and ANTHROPIC_API_KEY
 * for the judge (falls back to a warning, no grade, if absent — never a fake pass).
 */
import Anthropic from '@anthropic-ai/sdk';

const BASE = 'http://localhost:3000';

interface Case { id: string; instruction: string; note: string }

const CASES: Case[] = [
  { id: '1-hotel', instruction: 'Book me a hotel in Zurich next to the main station for 2 nights, 12 to 14 October, under CHF 400.', note: 'amount + hotel category; dates/nights have no field' },
  { id: '2-monitor', instruction: "Buy a 27-inch monitor from a shop I've used before, max CHF 400.", note: 'amount + familiarity; closest to an existing scenario' },
  { id: '3-spotify', instruction: 'Renew my Spotify subscription, but never more than CHF 15 per month.', note: 'subscriptions category + period-scoped amount' },
  { id: '4-swiss', instruction: 'Only buy from Swiss shops, up to CHF 200 per order. Ask me when uncertain.', note: 'merchant country + amount + explicit uncertainty policy' },
  { id: '5-chf-only', instruction: 'I only want to pay in CHF, nothing else. Buy groceries up to CHF 80 per week.', note: 'currency + groceries + period amount' },
  { id: '6-new-only', instruction: 'Only buy new items, never second-hand or refurbished, for electronics up to CHF 600.', note: 'item condition has no field — should become a question' },
  { id: '7-exact-model', instruction: 'Buy me the Sony WH-1000XM5 headphones, exactly that model, nothing else, for at most CHF 350.', note: 'model not in catalogue — item match should be flagged uncertain' },
  { id: '8-two-sizes', instruction: 'Buy me running shoes, but only size 42 or 43, up to CHF 180.', note: 'size only supports one exact value, not a choice of two' },
  { id: '9-free-returns', instruction: 'Only free returns, no return shipping fee ever. Buy me a jacket for CHF 150.', note: 'who pays return shipping has no field, distinct from return window' },
  { id: '10-named-merchants', instruction: 'Groceries only from Migros or Coop, budget CHF 100 per week.', note: 'named-merchant whitelist has no field, only category/country' },
  { id: '11-electronics-familiar', instruction: "Buy electronics, but only from shops I've used before, and never more than CHF 500 per purchase or CHF 1000 per month.", note: 'two amount scopes + category + familiarity in one sentence' },
  { id: '12-no-product', instruction: "I'm not sure what to buy yet, just don't go over CHF 50 and ask me for anything uncertain.", note: 'no product named — should raise a question, not guess' },
  { id: '13-weekends', instruction: 'Buy dining out delivery for me on weekends only, up to CHF 60 each time.', note: 'day-of-week has no field, only an hour-of-day window' },
  { id: '14-exclusion', instruction: 'Never buy gift cards or subscriptions, everything else is fine up to CHF 300.', note: 'category exclusion (not_in) across two categories' },
  { id: '15-approve-uncertain', instruction: "Approve everything automatically, don't bother asking me, just keep it under CHF 20 per purchase.", note: 'least-safe uncertainty_policy, set deliberately' },
];

// --- End-to-end cases: replay real SCEN0004 purchase_attempts.csv rows against the confirmed
// policy and check the engine's actual decision — real behavior against real data, not a checklist.
const E2E_CUSTOMER = 'CU0019'; // Oliver Graf, card CA0039 — SCEN0004's real customer
interface E2ECase { id: string; instruction: string; expect: { authorization_id: string; decision: 'approved' | 'declined' | 'pending'; reasonIncludes?: string }[] }
const E2E_CASES: E2ECase[] = [
  { id: 'e2e-1-monitor-familiar', instruction: "Buy a 27-inch monitor from a shop I've used before, max CHF 400.",
    expect: [
      { authorization_id: 'AU0035', decision: 'approved' }, // CHF 289 @ ME0022, 6 prior approved purchases
      { authorization_id: 'AU0037', decision: 'declined', reasonIncludes: 'amount' }, // CHF 520, over the 400 limit
    ] },
  { id: 'e2e-2-chf-only', instruction: 'Only purchases in Swiss Francs (CHF) are allowed. Buy electronics up to CHF 500.',
    expect: [
      { authorization_id: 'AU0038', decision: 'declined', reasonIncludes: 'currency' }, // USD 450 -> fails the currency rule
      { authorization_id: 'AU0035', decision: 'approved' }, // CHF 289, passes currency + amount
    ] },
  { id: 'e2e-3-electronics-familiar', instruction: "Buy electronics, but only from shops I've used before, and never more than CHF 500 per purchase or CHF 1000 per month.",
    expect: [
      { authorization_id: 'AU0037', decision: 'declined', reasonIncludes: 'amount' }, // CHF 520 > 500 per-purchase
      { authorization_id: 'AU0035', decision: 'approved' }, // CHF 289, familiar, under both limits
    ] },
];

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface Draft { id: string; hard_rules: { field: string; operator: string; value: unknown }[]; open_questions: string[] }
async function draftFor(instruction: string, customerId: string): Promise<Draft> {
  return post<Draft>('/api/mandates', { instruction, customer_id: customerId });
}

// --- One general rubric judge (claude-haiku-4-5), shared by every case — no per-case field checklist.
const RUBRIC = `You grade whether a wallet-control policy draft correctly captures a bank customer's instruction to
their AI shopping agent. The draft's hard_rules are evaluated later by a deterministic engine; the draft never
decides a purchase itself.

A correct draft:
1. Adds a rule for every constraint the instruction explicitly states that a real check could enforce
   (amount limits, item/merchant category, merchant country or currency, size, familiarity with the shop,
   return window, delivery time, fulfilment method, quantity, no-add-ons). Different but equally valid field
   choices are fine — judge intent captured, not exact field names.
2. Never invents a constraint the instruction didn't state, and never loosens one it did.
3. Never adds a rule that is trivially always true regardless of the purchase (e.g. "at least 0" on any
   numeric field) — that looks enforced but enforces nothing, and is a failure even if well-intentioned.
4. When the instruction states a constraint with no realistic way to check it (item condition, who pays
   return shipping, a named-shop whitelist, a day-of-week restriction, exact model/date specifics), the draft
   must raise it as an open_question in plain English — not fabricate a rule for it, and not silently drop it.
5. uncertainty_policy should match what the instruction says (or default to "ask" with a question, if unstated).

Answer with exactly one line PASS or FAIL, then one sentence of reasoning naming the specific rule or
open_question that made you decide.`;

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
async function judge(instruction: string, note: string, draft: Draft): Promise<{ pass: boolean | null; reason: string }> {
  if (!anthropic) return { pass: null, reason: '(no ANTHROPIC_API_KEY — not graded)' };
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: RUBRIC,
    messages: [{
      role: 'user',
      content: `Customer instruction: "${instruction}"\nWhat this case is meant to stress: ${note}\n\n` +
        `hard_rules produced:\n${JSON.stringify(draft.hard_rules, null, 2)}\n\n` +
        `open_questions raised:\n${draft.open_questions.map((q) => `- ${q}`).join('\n') || '(none)'}\n\n` +
        `Grade per the rubric. PASS or FAIL, then one sentence.`,
    }],
  });
  const text = resp.content.find((b) => b.type === 'text')?.text.trim() ?? '';
  return { pass: /^PASS/i.test(text), reason: text };
}

async function gradeCase(c: Case) {
  const draft = await draftFor(c.instruction, 'CU0001');
  const g = await judge(c.instruction, c.note, draft);
  return { id: c.id, ...g, hard_rules: draft.hard_rules, open_questions: draft.open_questions };
}

async function gradeE2E(c: E2ECase) {
  const draft = await draftFor(c.instruction, E2E_CUSTOMER);
  await post(`/api/mandates/${draft.id}/confirm`);
  const run = await post<{ id: string }>('/api/runs', { scenario_id: 'SCEN0004', mandate_id: draft.id });
  let decisions: any[] = [];
  for (let i = 0; i < 150; i++) {
    decisions = await get<any[]>(`/api/decisions?run_id=${run.id}`);
    if (decisions.length >= 11) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const results = c.expect.map((e) => {
    const d = decisions.find((x) => x.source_authorization_id === e.authorization_id);
    const statusOk = d?.status === e.decision;
    const reasonOk = !e.reasonIncludes || (d?.reason_codes ?? []).some((r: string) => r.includes(e.reasonIncludes!));
    return { authorization_id: e.authorization_id, expected: e.decision, actual: d?.status, reasonOk, pass: statusOk && reasonOk, message: d?.customer_message };
  });
  return { id: c.id, pass: results.every((r) => r.pass), results };
}

async function main() {
  console.log(`Running ${CASES.length} interpretation cases (rubric-judged) + ${E2E_CASES.length} end-to-end cases against ${BASE}...\n`);
  const caseResults = [];
  for (const c of CASES) {
    const r = await gradeCase(c);
    caseResults.push(r);
    const mark = r.pass === null ? '?' : r.pass ? '✔' : '✘';
    console.log(`${mark} ${r.id}  ${r.reason}`);
  }
  const e2eResults = [];
  for (const c of E2E_CASES) {
    const r = await gradeE2E(c);
    e2eResults.push(r);
    console.log(`${r.pass ? '✔' : '✘'} ${r.id}` + r.results.map((x) => `\n    ${x.pass ? 'ok' : 'FAIL'} ${x.authorization_id}: expected ${x.expected}, got ${x.actual}${x.pass ? '' : ` — "${x.message}"`}`).join(''));
  }
  const graded = caseResults.filter((r) => r.pass !== null);
  const passed = graded.filter((r) => r.pass).length + e2eResults.filter((r) => r.pass).length;
  const total = graded.length + e2eResults.length;
  console.log(`\n${passed}/${total} passed${graded.length < caseResults.length ? ` (${caseResults.length - graded.length} interpretation case(s) ungraded — no ANTHROPIC_API_KEY)` : ''}`);
  const fs = await import('node:fs');
  fs.writeFileSync('backend/eval/results.json', JSON.stringify({ caseResults, e2eResults }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
