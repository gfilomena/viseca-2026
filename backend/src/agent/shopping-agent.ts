import type { DatabaseSync } from 'node:sqlite';
import type { Currency, TermFlag } from '../domain/types.ts';
import { roundHalfEven } from '../domain/money.ts';
import { parseAmount, tokens } from '../policy/compiler.ts';
import { getCardProfile } from '../engine/profile.ts';
import { isLookalike } from '../engine/untrusted.ts';
import { fxRates } from '../services/catalog.ts';

/**
 * A deliberately simple *simulated* shopping agent for the sandbox chat.
 *
 * It is not part of wallet control: it turns the customer's shopping request into a
 * proposed purchase (product, shop, price, terms). The customer reviews and may edit
 * the offer — including the shop's product text, to try manipulation — before the
 * agent submits it. The wallet control engine then judges it against the confirmed
 * policy only; nothing in the request or the offer can change that policy.
 */

export interface OfferItem { item_id: string; item_name: string; item_category: string; typical_chf: number; min_chf: number; max_chf: number; score?: number }
export interface OfferMerchant { merchant_id: string; merchant_name: string; merchant_category: string; merchant_country: string; merchant_city: string; familiar_purchases: number }

export interface PurchaseOffer {
  request_text: string;
  item_id: string | null;
  quantity: number;
  unit_price_chf: number | null;
  budget_chf: number | null;
  merchant_id: string | null;
  size: string | null;
  customer_device_id: string;
  item_details: string;
  order_returnable: TermFlag;
  delivery_fee_chf: number;
  fulfillment_method: 'delivery' | 'digital' | 'pickup';
}

export interface InterpretedRequest {
  offer: PurchaseOffer;
  item: OfferItem | null;
  merchant: OfferMerchant | null;
  item_candidates: OfferItem[];
  /** What the agent assumed, in plain language. */
  notes: string[];
  /** Things the customer should check before the agent tries to buy. */
  questions: string[];
}

export interface ShopOptions {
  items: OfferItem[];
  merchants: OfferMerchant[];
  devices: { id: string; label: string }[];
}

const DIGITAL = new Set(['gift_card', 'subscriptions', 'membership']);
const STOP = new Set(('a an the my our me i we you it for of to in on at from with and or buy get order purchase please want need ' +
  'would like some new chf eur usd gbp up max maximum most than less no more budget about around size shop store seller').split(' '));

/** Merchant category that normally sells an item category (none for basket-only categories). */
const SHOP_FOR: Record<string, string | undefined> = {
  groceries: 'groceries', clothing: 'clothing', electronics: 'electronics', sporting_goods: 'sporting_goods',
  books: 'books', household: 'household', subscriptions: 'subscriptions', hotel: 'hotel', fuel: 'fuel',
  transport: 'transport', dining: 'dining', food_delivery: 'food_delivery', home_improvement: 'home_improvement',
};

export const currencyFor = (country: string): Currency =>
  country === 'CH' ? 'CHF' : country === 'GB' ? 'GBP' : country === 'US' ? 'USD' : 'EUR';

export function shopOptions(db: DatabaseSync, cardId: string): ShopOptions {
  const profile = getCardProfile(db, cardId);
  const items = (db.prepare('SELECT item_id, item_name, item_category, unit_price_typical_chf AS typical_chf, unit_price_min_chf AS min_chf, unit_price_max_chf AS max_chf FROM items ORDER BY item_category, item_name').all() as unknown as OfferItem[]);
  const merchants = (db.prepare('SELECT merchant_id, merchant_name, merchant_category, merchant_country, merchant_city FROM merchants ORDER BY merchant_name').all() as unknown as OfferMerchant[])
    .map((m) => ({ ...m, familiar_purchases: profile.merchantCounts.get(m.merchant_id) ?? 0 }))
    .sort((a, b) => b.familiar_purchases - a.familiar_purchases || a.merchant_name.localeCompare(b.merchant_name));
  const devices = [...profile.deviceCounts.entries()].sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id, label: `${id} · used ${n}×` }));
  devices.push({ id: 'DVC-NEW-SANDBOX', label: 'A new device (never used with this card)' });
  return { items, merchants, devices };
}

function scoreItems(text: string, items: OfferItem[]): OfferItem[] {
  const words = new Set(tokens(text).filter((t) => !STOP.has(t)));
  return items
    .map((item) => {
      const it = tokens(item.item_name);
      const matched = it.filter((t) => words.has(t)).length;
      const head = words.has(it[it.length - 1]) ? 0.5 : 0;
      const categoryHit = tokens(item.item_category.replace('_', ' ')).some((t) => words.has(t)) ? 0.25 : 0;
      return { ...item, score: matched / it.length + head + categoryHit + matched * 0.01 };
    })
    .filter((i) => (i.score ?? 0) >= 0.5)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function findMerchant(text: string, merchants: OfferMerchant[]): OfferMerchant | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const flat = norm(text);
  // Longest exact name first, so "PixelHarbour" is not read as "PixelHarbor" (or vice versa).
  return [...merchants].sort((a, b) => b.merchant_name.length - a.merchant_name.length).find((m) => flat.includes(norm(m.merchant_name)));
}

export function interpretRequest(db: DatabaseSync, cardId: string, text: string): InterpretedRequest {
  const opts = shopOptions(db, cardId);
  const notes: string[] = [];
  const questions: string[] = [];
  const lower = text.toLowerCase();

  const candidates = scoreItems(text, opts.items).slice(0, 5);
  const item = candidates[0] ?? null;
  if (item) notes.push(`Product: “${item.item_name}” (${item.item_category}), the closest catalogue match.`);
  else questions.push('I could not match a product in the catalogue. Pick one below.');
  if (candidates.length > 1 && (candidates[1].score ?? 0) >= (candidates[0].score ?? 0) - 0.05) {
    questions.push(`“${candidates[0].item_name}” and “${candidates[1].item_name}” match equally well. Check the product.`);
  }

  const qty = lower.match(/\b(\d{1,2})\s*(?:x|pcs|pieces|units|×)\b/) ?? lower.match(/\b(two|three|four|five)\b/);
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const quantity = qty ? (Number(qty[1]) || words[qty[1]] || 1) : 1;

  const amount = parseAmount(text);
  const budget = amount ? roundHalfEven(amount.value * (fxRates()[amount.currency] ?? 1)) : null;
  const exact = amount && /\b(for|at|costs?|priced)\s+(chf|eur|gbp|usd|fr)?\s?\d/i.test(text) && !/\b(up to|max|maximum|at most|no more than|or less|under|below|budget)\b/i.test(text);
  const unit = item ? (budget ? (exact ? budget / quantity : Math.min(item.typical_chf, budget / quantity)) : item.typical_chf) : budget;
  if (item) notes.push(budget
    ? exact ? `Price: CHF ${roundHalfEven(unit!).toFixed(2)} per unit, as you asked.` : `Price: CHF ${roundHalfEven(unit!).toFixed(2)} per unit, within your budget of CHF ${budget.toFixed(2)}.`
    : `Price: CHF ${roundHalfEven(unit!).toFixed(2)}, the usual price for this product.`);

  let merchant = findMerchant(text, opts.merchants) ?? null;
  if (merchant) {
    notes.push(`Shop: ${merchant.merchant_name} (${merchant.merchant_city}, ${merchant.merchant_country}), as you asked.`);
    const known = opts.merchants.find((k) => k.familiar_purchases > 0 && k.merchant_id !== merchant!.merchant_id && isLookalike(merchant!.merchant_name, k.merchant_name));
    if (known) questions.push(`“${merchant.merchant_name}” looks like “${known.merchant_name}”, a shop you know. Is it the right one?`);
  } else if (item) {
    const cat = SHOP_FOR[item.item_category];
    const pool = opts.merchants.filter((m) => (cat ? m.merchant_category === cat : true));
    merchant = pool.find((m) => m.familiar_purchases > 0) ?? pool.find((m) => m.merchant_country === 'CH') ?? pool[0] ?? null;
    if (merchant) notes.push(`Shop: ${merchant.merchant_name}, ${merchant.familiar_purchases ? `where this card has ${merchant.familiar_purchases} earlier purchase(s)` : 'a shop this card has not used before'}.`);
  }
  if (!merchant) questions.push('Which shop should the agent use?');

  const size = text.match(/\bsize\s+([0-9]{2}(?:\.5)?|XXS|XS|S|M|L|XL|XXL)\b/i)?.[1]?.toUpperCase() ?? null;
  const digital = item ? DIGITAL.has(item.item_category) : false;
  const description = item ? (db.prepare('SELECT item_description AS d FROM items WHERE item_id = ?').get(item.item_id) as { d: string }).d : '';
  const details = [description.replace(/\.$/, ''), size ? `size ${size}` : '', digital ? '' : 'returns accepted within 30 days'].filter(Boolean).join('; ');
  notes.push(digital ? 'Delivery: digital, returns do not apply.' : 'Delivery: home delivery; the simulated shop offers 30-day returns (you can change that).');
  notes.push('Everything above is only the agent\'s proposal. Your wallet policy decides, and nothing here can change it.');

  const device = opts.devices[0]?.id ?? 'DVC-NEW-SANDBOX';
  return {
    offer: {
      request_text: text,
      item_id: item?.item_id ?? null,
      quantity,
      unit_price_chf: unit != null ? roundHalfEven(unit) : null,
      budget_chf: budget,
      merchant_id: merchant?.merchant_id ?? null,
      size,
      customer_device_id: device,
      item_details: details,
      order_returnable: digital ? 'not_applicable' : 'true',
      delivery_fee_chf: item?.item_category === 'groceries' ? 6 : 0,
      fulfillment_method: digital ? 'digital' : 'delivery',
    },
    item, merchant, item_candidates: candidates, notes, questions,
  };
}
