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
 *
 * The agent is not limited to the 66-item data-pack catalogue: it will propose whatever
 * product the customer names. A catalogue match (when there is one) gives a reliable
 * category and reference price; anything else gets a best-effort category guess and a
 * price taken from what the customer stated. Either way, wallet control decides the
 * purchase the same way — a rule such as "only IT0017" or "only groceries" applies
 * identically to a catalogue product and a free-text one.
 */

export interface OfferItem { item_id: string; item_name: string; item_category: string; typical_chf: number; min_chf: number; max_chf: number; score?: number }
export interface OfferMerchant { merchant_id: string; merchant_name: string; merchant_category: string; merchant_country: string; merchant_city: string; familiar_purchases: number }

/**
 * Field names mirror the official item/authorization schema (resource/data/schemas/
 * authorization_event.schema.json) so matching an offer against wallet-policy rules and
 * building the final AuthorizationEvent from it need no renaming: unit_price and
 * delivery_fee are in `currency` (never suffixed "_chf") — only a fully normalised total
 * (billing_amount_chf) ever carries that suffix, exactly as the schema does it.
 */
export interface PurchaseOffer {
  request_text: string;
  item_id: string | null;
  /** Always populated once a product is recognised, catalogued or not. */
  item_name: string | null;
  item_category: string | null;
  quantity: number;
  unit_price: number | null;
  currency: Currency;
  budget: number | null;
  merchant_id: string | null;
  size: string | null;
  customer_device_id: string;
  item_details: string;
  order_returnable: TermFlag;
  delivery_fee: number;
  fulfillment_method: 'delivery' | 'digital' | 'pickup';
}

export interface InterpretedRequest {
  offer: PurchaseOffer;
  /** The catalogue match, if the product happens to be one of the data pack's 66 items. */
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

/**
 * Best-effort category guess for a product that is not in the catalogue, using the same
 * category vocabulary as items.csv / merchants.csv. It only ever narrows a rule check
 * ("items.item_category in [...]"); guessing wrong makes the purchase uncertain or
 * declined, never silently approved outside the category.
 */
const PRODUCT_CATEGORY_HINTS: [RegExp, string][] = [
  [/\b(bicycle|bike|helmet|running shoes?|trainers?|hiking boots?|tent|ski(s|ing)?|snowboard|racket|yoga mat|scooter|skateboard|dumbbells?|treadmill|football|basketball)\b/i, 'sporting_goods'],
  [/\b(phones?|smartphones?|laptops?|computers?|monitors?|tablets?|headphones?|earbuds?|chargers?|cameras?|tv|television|consoles?|keyboards?|mice|mouse|printers?|routers?|drones?|speakers?|smartwatch(es)?|e-?readers?|fitness trackers?|games?|gaming|hard drives?|ssds?|webcams?|projectors?)\b/i, 'electronics'],
  [/\b(shirt|t-?shirt|jacket|coat|jeans|trousers|dress|shoes?|boots|sweater|hoodie|scarf|gloves|socks|hat|cap|belt|handbag|backpack)\b/i, 'clothing'],
  [/\b(bread|milk|eggs?|fruit|vegetables?|banana|apple|rice|pasta|cheese|coffee|tea|groceries?|snacks?|meat|fish|yogh?urt|cereal)\b/i, 'groceries'],
  [/\b(book|novel|textbook|magazine|comic)\b/i, 'books'],
  [/\b(sofa|couch|chair|table|lamp|rug|curtains?|cushion|shelf|shelving|mattress|blender|kettle|toaster|vacuum|air fryer|grill|cookware|pan|pot)\b/i, 'household'],
  [/\b(paint|drill|hammer|screwdriver|toolkit|nails?|screws?|ladder|saw|wrench)\b/i, 'home_improvement'],
  [/\b(perfume|makeup|lipstick|skincare|shampoo|cosmetics?|moisturi[sz]er|sunscreen)\b/i, 'cosmetics'],
  [/\bgift ?(card|voucher)s?\b/i, 'gift_card'],
  [/\b(train|rail|bus|tram)\s*(ticket|pass)?\b/i, 'transport'],
  [/\b(fuel|petrol|diesel|charging session)\b/i, 'fuel'],
  [/\b(restaurant|dinner|lunch|breakfast|dining|meal)\b/i, 'dining'],
  [/\b(food delivery|takeaway|takeout|delivery order)\b/i, 'food_delivery'],
  [/\b(hotel|room|stay|night'?s? stay|resort|booking\.?com)\b/i, 'hotel'],
  [/\b(membership|gym pass|club fee|annual fee)\b/i, 'membership'],
  [/\b(subscriptions?|monthly plans?|streaming plans?)\b/i, 'subscriptions'],
];

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

function guessCategory(text: string): string {
  for (const [re, cat] of PRODUCT_CATEGORY_HINTS) if (re.test(text)) return cat;
  return 'general';
}

const AMOUNT_RE = [
  /\b(?:up to|at most|no more than|not more than|max(?:imum)?|under|below|for|at|costs?|priced)?\s*(?:CHF|EUR|GBP|USD|Fr\.?)\s?\d+(?:[.,]\d{1,2})?\b/gi,
  /\b\d+(?:[.,]\d{1,2})?\s?(?:CHF|EUR|GBP|USD|francs?)\b/gi,
];

/** Removes a matched merchant name (and its "from"/"at" connector) so it cannot be mistaken for product words. */
function stripMerchantName(text: string, merchantName: string | null): string {
  if (!merchantName) return text;
  const esc = merchantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b(from|at)\\s+${esc}\\b`, 'i'), ' ').replace(new RegExp(esc, 'i'), ' ');
}

/** Best-effort product name for text that did not match the catalogue: strip the shop, the price, and boilerplate. */
export function extractProductName(text: string, merchantName: string | null): string | null {
  let s = stripMerchantName(text, merchantName);
  for (const re of AMOUNT_RE) s = s.replace(re, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^(please\s+)?(buy|order|get|purchase|grab|pick up)\s+(me\s+)?/i, '');
  s = s.replace(/^(a|an|the|some|one|two|three|four|five|\d{1,2})\s*(?:x|pcs|pieces|units|×)?\s+/i, '');
  s = s.replace(/\s+(each|per unit|per item|per piece|a unit|a piece|apiece)\.?$/i, '');
  s = s.replace(/\b(from|at|for|per)\s*$/i, '').replace(/[.,!?]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (s.length < 2) return null;
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function interpretRequest(db: DatabaseSync, cardId: string, text: string): InterpretedRequest {
  const opts = shopOptions(db, cardId);
  const notes: string[] = [];
  const questions: string[] = [];
  const lower = text.toLowerCase();

  const namedMerchant = findMerchant(text, opts.merchants) ?? null;
  // Score against the text with the shop name removed, so e.g. "Alpine Basket" cannot make an
  // unrelated request match the catalogue's "Weekly grocery basket" through the shared word "basket".
  const candidates = scoreItems(stripMerchantName(text, namedMerchant?.merchant_name ?? null), opts.items).slice(0, 5);
  const catalogueItem = candidates[0] ?? null;

  // Strip currency amounts first so a bare quantity number ("2 drones") isn't confused with
  // a price ("300chf") and a quantity right before a unit word ("2x", "2 pcs") is still caught.
  const lowerWithoutAmount = AMOUNT_RE.reduce((s, re) => s.replace(re, ' '), lower);
  // A bare number ("2 drones") is only read as a quantity right after the purchase verb, never
  // mid-sentence — otherwise "shoes size 43 at ..." would misread the shoe size as a quantity.
  const afterVerb = lowerWithoutAmount.replace(/^(please\s+)?(buy|order|get|purchase|grab|pick up)\s+(me\s+)?/i, '');
  const qty = lowerWithoutAmount.match(/\b(\d{1,2})\s*(?:x|pcs|pieces|units|×)\b/)
    ?? afterVerb.match(/^(\d{1,2})\s*(?:x|pcs|pieces|units|×)?\s+/)
    ?? lowerWithoutAmount.match(/\b(two|three|four|five)\b/);
  const qtyWords: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const quantity = qty ? (Number(qty[1]) || qtyWords[qty[1]] || 1) : 1;

  const amount = parseAmount(text);
  const budget = amount ? roundHalfEven(amount.value * (fxRates()[amount.currency] ?? 1)) : null;
  const exact = amount && /\b(for|at|costs?|priced)\s+(chf|eur|gbp|usd|fr)?\s?\d/i.test(text) && !/\b(up to|max|maximum|at most|no more than|or less|under|below|budget)\b/i.test(text);

  let itemName: string | null;
  let itemCategory: string | null;
  let itemId: string | null;
  let unit: number | null;

  if (catalogueItem) {
    itemName = catalogueItem.item_name;
    itemCategory = catalogueItem.item_category;
    itemId = catalogueItem.item_id;
    unit = budget ? (exact ? budget : Math.min(catalogueItem.typical_chf, budget / quantity)) : catalogueItem.typical_chf;
    notes.push(`Product: “${itemName}” (${itemCategory}), the closest catalogue match.`);
    if (candidates.length > 1 && (candidates[1].score ?? 0) >= (candidates[0].score ?? 0) - 0.05) {
      questions.push(`“${candidates[0].item_name}” and “${candidates[1].item_name}” match equally well. Check the product.`);
    }
    notes.push(budget
      ? exact ? `Price: CHF ${roundHalfEven(unit).toFixed(2)} per unit, as you asked.` : `Price: CHF ${roundHalfEven(unit).toFixed(2)} per unit, within your budget of CHF ${budget.toFixed(2)}.`
      : `Price: CHF ${roundHalfEven(unit).toFixed(2)}, the usual price for this product.`);
  } else {
    itemName = extractProductName(text, namedMerchant?.merchant_name ?? null);
    itemId = null;
    itemCategory = itemName ? guessCategory(text) : null;
    unit = budget ? (exact ? budget : budget / quantity) : null;
    if (itemName) {
      notes.push(`Product: “${itemName}”, as you described it — not in this shop's product catalogue, so category (${itemCategory}) and price are our best guess.`);
      questions.push(`“${itemName}” is not a known product. Check the price and category before buying.`);
    } else {
      questions.push('I could not tell what product to buy. Please name it.');
    }
    if (unit != null) notes.push(`Price: CHF ${roundHalfEven(unit).toFixed(2)} per unit, as you asked.`);
    else if (itemName) questions.push('State a price (e.g. “for CHF 40”) so the agent knows what to offer.');
  }

  let merchant = namedMerchant;
  if (merchant) {
    notes.push(`Shop: ${merchant.merchant_name} (${merchant.merchant_city}, ${merchant.merchant_country}), as you asked.`);
    const known = opts.merchants.find((k) => k.familiar_purchases > 0 && k.merchant_id !== merchant!.merchant_id && isLookalike(merchant!.merchant_name, k.merchant_name));
    if (known) questions.push(`“${merchant.merchant_name}” looks like “${known.merchant_name}”, a shop you know. Is it the right one?`);
  } else if (itemCategory) {
    const cat = SHOP_FOR[itemCategory];
    const pool = opts.merchants.filter((m) => (cat ? m.merchant_category === cat : true));
    merchant = pool.find((m) => m.familiar_purchases > 0) ?? pool.find((m) => m.merchant_country === 'CH') ?? pool[0] ?? null;
    if (merchant) notes.push(`Shop: ${merchant.merchant_name}, ${merchant.familiar_purchases ? `where this card has ${merchant.familiar_purchases} earlier purchase(s)` : 'a shop this card has not used before'}.`);
  }
  if (!merchant) questions.push('Which shop should the agent use?');

  const size = text.match(/\bsize\s+([0-9]{2}(?:\.5)?|XXS|XS|S|M|L|XL|XXL)\b/i)?.[1]?.toUpperCase() ?? null;
  const digital = itemCategory ? DIGITAL.has(itemCategory) : false;
  const description = catalogueItem ? (db.prepare('SELECT item_description AS d FROM items WHERE item_id = ?').get(catalogueItem.item_id) as { d: string }).d : '';
  const details = [description.replace(/\.$/, ''), size ? `size ${size}` : '', digital ? '' : 'returns accepted within 30 days'].filter(Boolean).join('; ');
  notes.push(digital ? 'Delivery: digital, returns do not apply.' : 'Delivery: home delivery; the simulated shop offers 30-day returns (you can change that).');
  notes.push('Everything above is only the agent\'s proposal. Your wallet policy decides, and nothing here can change it.');

  const device = opts.devices[0]?.id ?? 'DVC-NEW-SANDBOX';
  return {
    offer: {
      request_text: text,
      item_id: itemId,
      item_name: itemName,
      item_category: itemCategory,
      quantity,
      unit_price: unit != null ? roundHalfEven(unit) : null,
      currency: 'CHF',
      budget,
      merchant_id: merchant?.merchant_id ?? null,
      size,
      customer_device_id: device,
      item_details: details,
      order_returnable: digital ? 'not_applicable' : 'true',
      delivery_fee: itemCategory === 'groceries' ? 6 : 0,
      fulfillment_method: digital ? 'digital' : 'delivery',
    },
    item: catalogueItem, merchant, item_candidates: candidates, notes, questions,
  };
}
