import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretRequestOpenAI } from './openai-interpreter.ts';
import type { ShopOptions } from './shopping-agent.ts';

const opts: ShopOptions = {
  items: [{ item_id: 'IT0017', item_name: '27-inch monitor', item_category: 'electronics', typical_chf: 270, min_chf: 200, max_chf: 340 }],
  merchants: [{ merchant_id: 'ME0022', merchant_name: 'PixelHarbor', merchant_category: 'electronics', merchant_country: 'CH', merchant_city: 'Zurich', familiar_purchases: 2 }],
  devices: [{ id: 'DVC-785971', label: 'DVC-785971 · used 5×' }],
};

const fake = (parsed: unknown, finish_reason = 'stop') => ({
  chat: { completions: { parse: async () => ({ choices: [{ finish_reason, message: { parsed } }] }) } },
}) as any;

const base = { item_id: null, item_name: null, item_category: null, quantity: 1, unit_price: null, budget: null, merchant_id: null, size: null, fulfillment_method: 'delivery' as const, notes: [], questions: [] };

test('a bare "N <product>" free-text request is turned into an offer, quantity and price read correctly', async () => {
  const out = await interpretRequestOpenAI('buy 2 drones from PixelHarbor for 300chf each', opts, fake({
    ...base, item_name: 'Drones', item_category: 'electronics', quantity: 2, unit_price: 300, merchant_id: 'ME0022', notes: ['Drones, CHF 300 each, from PixelHarbor.'],
  }));
  assert.ok(out);
  assert.equal(out!.offer.item_name, 'Drones');
  assert.equal(out!.offer.item_category, 'electronics');
  assert.equal(out!.offer.quantity, 2);
  assert.equal(out!.offer.unit_price, 300);
  assert.equal(out!.offer.merchant_id, 'ME0022');
  assert.equal(out!.item, null); // not a catalogue match
});

test('a catalogue match fills in the real item id, category and reference price', async () => {
  const out = await interpretRequestOpenAI('Buy the 27-inch monitor at PixelHarbor for CHF 289', opts, fake({
    ...base, item_id: 'IT0017', item_name: '27-inch monitor', unit_price: 289, merchant_id: 'ME0022',
  }));
  assert.ok(out);
  assert.equal(out!.offer.item_id, 'IT0017');
  assert.equal(out!.offer.item_category, 'electronics'); // taken from the real catalogue row, not the model
  assert.equal(out!.item?.item_id, 'IT0017');
});

test('a hallucinated catalogue or shop id is rejected rather than trusted', async () => {
  const badItem = await interpretRequestOpenAI('x', opts, fake({ ...base, item_id: 'IT9999', item_name: 'Fake' }));
  assert.equal(badItem, null);
  const badMerchant = await interpretRequestOpenAI('x', opts, fake({ ...base, merchant_id: 'ME9999' }));
  assert.equal(badMerchant, null);
});

test('failures, refusals and no-key all fall back cleanly (null, never throws)', async () => {
  const timeout = await interpretRequestOpenAI('x', opts,
    { chat: { completions: { parse: async () => { throw new Error('boom'); } } } } as any);
  assert.equal(timeout, null);
  const filtered = await interpretRequestOpenAI('x', opts, fake(null, 'content_filter'));
  assert.equal(filtered, null);
  const noKey = await interpretRequestOpenAI('x', opts);
  assert.equal(noKey, null);
});
