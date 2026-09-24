import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { compileInstruction, type CatalogueItem } from './compiler.ts';
import { reviewDraft, toRule } from './llm.ts';

const catalogue = (parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../resource/data/items.csv')), { columns: true }) as any[])
  .map((r) => ({ item_id: r.item_id, item_name: r.item_name, item_category: r.item_category })) as CatalogueItem[];
const ctx = { catalogue, merchantCategories: ['groceries', 'hotel', 'sporting_goods'] };
const base = { value_number: null, value_text: null, value_list: null, currency: null, scope: null, period_days: null, source_phrase: 'x', explanation: 'x' };

/** Minimal stand-in for the SDK client: returns a fixed parsed output (or throws). */
const fake = (parsed_output: unknown, extra: Record<string, unknown> = {}) => ({
  messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output, ...extra }) },
}) as any;

test('valid suggestions are added and marked; invalid and duplicate ones are dropped', async () => {
  const draft = compileInstruction('Only Swiss shops, hotel stays up to CHF 300 per night.', catalogue);
  const before = draft.hard_rules.length;
  const out = await reviewDraft(draft, ctx, fake({
    add_rules: [
      { ...base, field: 'merchant.merchant_category', operator: 'in', value_list: ['hotel'], source_phrase: 'hotel stays', explanation: 'Only hotels may be paid.' },
      { ...base, field: 'items.item_category', operator: 'in', value_list: ['spaceships'] }, // unknown category
      { ...base, field: 'authorization.billing_amount_chf', operator: 'in', value_number: 5 }, // wrong operator
      draft.hard_rules[0] && { ...base, field: draft.hard_rules[0].field, operator: draft.hard_rules[0].operator, value_number: typeof draft.hard_rules[0].value === 'number' ? draft.hard_rules[0].value : null, value_list: Array.isArray(draft.hard_rules[0].value) ? draft.hard_rules[0].value : null, currency: draft.hard_rules[0].currency ?? null, scope: draft.hard_rules[0].scope ?? null },
    ].filter(Boolean),
    open_questions: ['Is “per night” meant per booking?'],
  }));
  assert.equal(out.used, true);
  assert.equal(out.draft.hard_rules.length, before + 1);
  assert.deepEqual(out.draft.hard_rules.at(-1), { field: 'merchant.merchant_category', operator: 'in', value: ['hotel'] });
  assert.match(out.draft.explanations.at(-1)!.text, /suggested by the language model/);
  assert.ok(out.draft.open_questions.some((q) => q.includes('per night')));
  // Original rules are never removed or changed.
  assert.deepEqual(out.draft.hard_rules.slice(0, before), draft.hard_rules);
});

test('failures and refusals keep the built-in draft', async () => {
  const draft = compileInstruction('Buy groceries for CHF 50 or less.', catalogue);
  const timeout = await reviewDraft(draft, ctx, { messages: { parse: async () => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); } } } as any);
  assert.equal(timeout.used, false);
  assert.equal(timeout.draft, draft);
  assert.match(timeout.note, /timeout/);
  const refusal = await reviewDraft(draft, ctx, fake(null, { stop_reason: 'refusal' }));
  assert.equal(refusal.used, false);
  assert.equal(refusal.draft, draft);
});

test('without POLICY_LLM=on nothing is called', async () => {
  const draft = compileInstruction('Buy groceries for CHF 50 or less.', catalogue);
  const out = await reviewDraft(draft, ctx);
  assert.equal(out.used, false);
  assert.equal(out.draft, draft);
});

test('rule conversion enforces the vocabulary', () => {
  assert.deepEqual(toRule({ ...base, field: 'authorization.billing_amount_chf', operator: '<=', value_number: 400, scope: 'period', period_days: 30 } as any, ctx),
    { field: 'authorization.billing_amount_chf', operator: '<=', value: 400, currency: 'CHF', scope: 'period', period_days: 30 });
  assert.equal(typeof toRule({ ...base, field: 'authorization.billing_amount_chf', operator: '<=', value_number: 400, scope: 'period' } as any, ctx), 'string');
  assert.equal(typeof toRule({ ...base, field: 'merchant.merchant_country', operator: 'in', value_list: ['Switzerland'] } as any, ctx), 'string');
  assert.deepEqual(toRule({ ...base, field: 'items.attribute.size', operator: '=', value_text: 'm' } as any, ctx), { field: 'items.attribute.size', operator: '=', value: 'M' });
});

test('a numeric rule that is always true (">= 0") is rejected, not silently accepted', () => {
  // Regression: a constraint with no matching field ("only pay in CHF") was observed getting
  // mis-mapped onto authorization.billing_amount_chf >= 0 and authorization.return_window_days >= 0 —
  // both trivially true for every real purchase, so the "rule" enforced nothing.
  assert.equal(typeof toRule({ ...base, field: 'authorization.billing_amount_chf', operator: '>=', value_number: 0 } as any, ctx), 'string');
  assert.equal(typeof toRule({ ...base, field: 'authorization.return_window_days', operator: '>=', value_number: 0 } as any, ctx), 'string');
  // A real, non-zero threshold on the same fields is still accepted.
  assert.equal(typeof toRule({ ...base, field: 'authorization.return_window_days', operator: '>=', value_number: 14 } as any, ctx), 'object');
});

test('authorization.currency is a real field for "only pay in CHF" style instructions', () => {
  assert.deepEqual(toRule({ ...base, field: 'authorization.currency', operator: 'in', value_list: ['CHF'] } as any, ctx), { field: 'authorization.currency', operator: 'in', value: ['CHF'] });
  assert.equal(typeof toRule({ ...base, field: 'authorization.currency', operator: 'in', value_list: ['XYZ'] } as any, ctx), 'string');
});
