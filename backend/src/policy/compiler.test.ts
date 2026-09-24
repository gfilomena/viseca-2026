import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { compileInstruction, type CatalogueItem } from './compiler.ts';

const catalogue = (parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../resource/data/items.csv')), { columns: true }) as any[])
  .map((r) => ({ item_id: r.item_id, item_name: r.item_name, item_category: r.item_category })) as CatalogueItem[];
const rules = (t: string) => compileInstruction(t, catalogue).hard_rules
  .map((r) => `${r.field} ${r.operator} ${JSON.stringify(r.value)}${r.scope === 'period' ? ` /${r.period_days}d` : ''}`);

test('"book" as a verb is not the books category; hotels are recognised', () => {
  const r = rules('Book a hotel in Lucerne under 300 EUR, only between 8 and 20.');
  assert.ok(r.includes('items.item_category in ["hotel"]'), r.join(' | '));
  assert.ok(!r.some((x) => x.includes('"books"')), r.join(' | '));
  assert.ok(r.includes('authorization.billing_amount_chf < 300'));
  assert.ok(r.includes('authorization.local_hour >= 8') && r.includes('authorization.local_hour < 20'));
  assert.ok(rules('Buy me two paperback books.').includes('items.item_category in ["books"]'));
});

test('a delivery-time phrase adds a delivery_within_days rule, distinct from the return window', () => {
  assert.deepEqual(rules('The item should arrive within 3 working days.'), ['authorization.delivery_within_days <= 3']);
  assert.deepEqual(rules('Buy shoes, only if the order can be delivered within 5 days and returned within 14 days.'),
    ['authorization.return_window_days >= 14', 'authorization.fulfillment_method in ["delivery"]', 'authorization.delivery_within_days <= 5']);
});

test('two amounts in one sentence give a per-purchase and a period limit', () => {
  assert.deepEqual(rules('Max CHF 100 per purchase and CHF 400 per month.'), [
    'authorization.billing_amount_chf <= 100',
    'authorization.billing_amount_chf <= 400 /30d',
  ]);
  assert.deepEqual(rules("Don't spend more than 50 francs a week on books.").slice(0, 1), ['authorization.billing_amount_chf <= 50 /7d']);
});

test('the five public instructions keep their interpretation', () => {
  const c = (id: string) => (parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../resource/data/scenario_catalogue.csv')), { columns: true }) as any[]).find((r) => r.scenario_id === id).cardholder_instruction;
  assert.deepEqual(rules(c('SCEN0000')), ['authorization.billing_amount_chf <= 20', 'items.item_category in ["groceries"]', 'items.quantity_total <= 1', 'merchant.prior_approved_purchases >= 3']);
  assert.deepEqual(rules(c('SCEN0001')), ['authorization.billing_amount_chf <= 120', 'authorization.billing_amount_chf <= 300 /7d', 'items.item_category in ["groceries"]', 'authorization.fulfillment_method in ["delivery"]']);
  assert.deepEqual(rules(c('SCEN0002')), ['authorization.billing_amount_chf <= 200', 'items.item_id in ["IT0014"]', 'items.attribute.size = "43"', 'authorization.return_window_days >= 14', 'merchant.merchant_category in ["sporting_goods"]']);
  assert.deepEqual(rules(c('SCEN0003')), ['authorization.billing_amount_chf <= 250', 'items.item_category in ["clothing"]', 'merchant.prior_approved_purchases >= 1']);
  assert.deepEqual(rules(c('SCEN0004')), ['authorization.billing_amount_chf <= 400', 'items.item_id in ["IT0017"]', 'basket.unrequested_lines <= 0', 'merchant.prior_approved_purchases >= 1']);
});

test('the exact original wording is kept', () => {
  const original = '  Buy groceries for CHF 50 or less.  ';
  assert.equal(compileInstruction(original, catalogue).instruction, original);
});
