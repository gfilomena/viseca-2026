import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { CatalogueItem } from './compiler.ts';
import { compileInstructionOpenAI } from './openai-compiler.ts';

const catalogue = (parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../resource/data/items.csv')), { columns: true }) as any[])
  .map((r) => ({ item_id: r.item_id, item_name: r.item_name, item_category: r.item_category })) as CatalogueItem[];
const ctx = { catalogue, merchantCategories: ['groceries', 'hotel', 'sporting_goods'] };
const base = { value_number: null, value_text: null, value_list: null, currency: null, scope: null, period_days: null, source_phrase: 'x', explanation: 'x' };

/** Minimal stand-in for the OpenAI SDK client used by the interpreter under test. */
const fake = (parsed: unknown, finish_reason = 'stop') => ({
  chat: { completions: { parse: async () => ({ choices: [{ finish_reason, message: { parsed } }] }) } },
}) as any;

test('a full draft is built from the model output, with the same vocabulary guardrails as the review layer', async () => {
  const out = await compileInstructionOpenAI('Only hotels, up to CHF 300 per night, ask me when unsure.', ctx, fake({
    hard_rules: [
      { ...base, field: 'merchant.merchant_category', operator: 'in', value_list: ['hotel'], source_phrase: 'hotels', explanation: 'Only hotels may be paid.' },
      { ...base, field: 'authorization.billing_amount_chf', operator: '<=', value_number: 300, currency: 'CHF', scope: 'purchase', source_phrase: 'CHF 300 per night', explanation: 'At most CHF 300 per order.' },
      { ...base, field: 'items.item_category', operator: 'in', value_list: ['spaceships'], source_phrase: 'x', explanation: 'bogus' }, // unknown category, rejected
    ],
    uncertainty_policy: 'ask',
    session_strict: false,
    guidance: [],
    open_questions: [],
  }));
  assert.equal(out.used, true);
  assert.ok(out.draft);
  assert.equal(out.draft!.hard_rules.length, 2); // the bogus category rule is dropped
  assert.deepEqual(out.draft!.hard_rules[0], { field: 'merchant.merchant_category', operator: 'in', value: ['hotel'] });
  assert.equal(out.draft!.uncertainty_policy, 'ask');
  assert.match(out.note, /OpenAI/);
});

test('failures and refusals signal a fallback instead of throwing', async () => {
  const timeout = await compileInstructionOpenAI('Buy groceries for CHF 50 or less.', ctx,
    { chat: { completions: { parse: async () => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); } } } } as any);
  assert.equal(timeout.used, false);
  assert.equal(timeout.draft, null);
  assert.match(timeout.note, /unavailable/);

  const filtered = await compileInstructionOpenAI('Buy groceries for CHF 50 or less.', ctx, fake(null, 'content_filter'));
  assert.equal(filtered.used, false);
  assert.equal(filtered.draft, null);
});

test('without OPENAI_API_KEY nothing is called', async () => {
  const out = await compileInstructionOpenAI('Buy groceries for CHF 50 or less.', ctx);
  assert.equal(out.used, false);
  assert.equal(out.draft, null);
  assert.match(out.note, /off/);
});
