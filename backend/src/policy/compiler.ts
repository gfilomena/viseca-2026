import type { Currency, HardRule, UncertaintyPolicy } from '../domain/types.ts';

/**
 * Deterministic natural-language → wallet-policy compiler.
 *
 * It never guesses silently: every rule carries a plain-language explanation and
 * the source phrase it came from, and anything it cannot map is returned as an
 * open question for the customer to review before confirming.
 */

export interface CatalogueItem { item_id: string; item_name: string; item_category: string }

export interface RuleExplanation {
  rule: HardRule;
  text: string;
  source: string;
}

/** Soft intents the engine re-derives from the instruction (they are not hard rules). */
export interface PolicyIntents {
  session_strict: boolean;
  requested_item_ids: string[];
  requested_item_names: string[];
}

export interface PolicyDraft {
  instruction: string;
  hard_rules: HardRule[];
  uncertainty_policy: UncertaintyPolicy;
  guidance: string[];
  open_questions: string[];
  explanations: RuleExplanation[];
  intents: PolicyIntents;
}

// Field vocabulary understood by the engine (see README "Rule vocabulary").
export const FIELDS = {
  amount: 'authorization.billing_amount_chf',
  currency: 'authorization.currency',
  fulfillment: 'authorization.fulfillment_method',
  returnDays: 'authorization.return_window_days',
  deliveryDays: 'authorization.delivery_within_days',
  localHour: 'authorization.local_hour',
  merchantCategory: 'merchant.merchant_category',
  merchantCountry: 'merchant.merchant_country',
  familiarity: 'merchant.prior_approved_purchases',
  itemId: 'items.item_id',
  itemCategory: 'items.item_category',
  size: 'items.attribute.size',
  quantity: 'items.quantity_total',
  unrequested: 'basket.unrequested_lines',
} as const;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fourteen: 14, thirty: 30,
};

export const ITEM_CATEGORY_SYNONYMS: Record<string, RegExp> = {
  groceries: /\bgrocer(y|ies)\b/,
  clothing: /\b(clothing|clothes|apparel)\b/,
  electronics: /\belectronics?\b/,
  // "book" is also a verb ("book a hotel"): only the noun forms count.
  books: /\bbooks\b|\be-?books?\b|\b(a|the|one|some|new|paperback|reference) book\b/,
  hotel: /\bhotels?\b|\b(accommodation|serviced apartment)s?\b/,
  transport: /\b(train|rail|bus|tram|transit|transport|public transport)\b( tickets?| pass(es)?)?/,
  fuel: /\b(fuel|petrol|diesel|gasoline|ev charging|charging session)s?\b/,
  dining: /\b(restaurant|dinner reservation|lunch|brunch|dining)s?\b/,
  food_delivery: /\b(food|meal) delivery\b|\btake-?aways?\b/,
  home_improvement: /\b(diy|home improvement|tools?|paint)\b/,
  household: /\bhousehold (items|products|goods|essentials)\b/,
  gift_card: /\bgift ?(cards?|vouchers?)\b|\bvouchers?\b/,
  cosmetics: /\b(cosmetics|beauty|fragrances?)\b/,
  subscriptions: /\bsubscriptions?\b/,
  membership: /\bmemberships?\b/,
  sporting_goods: /\bsport(s|ing)? (goods|equipment|gear)\b/,
};

const MERCHANT_CATEGORY_SYNONYMS: Record<string, RegExp> = {
  sporting_goods: /\b(sports?|sporting( goods)?|running) (retailer|shop|store|specialist)s?\b/,
  electronics: /\belectronics (retailer|shop|store)s?\b/,
  groceries: /\b(grocery|supermarket|grocer)s? (shop|store)?\b(?!.*item)/,
  clothing: /\b(clothing|fashion) (retailer|shop|store)s?\b/,
};

const STOPWORDS = new Set(
  ('a an the my our me i we you it for of to in on at from with and or but only any each per ' +
    'buy order orders ordered item items shop shops store seller sellers retailer pay purchase ' +
    'delivery total days day keep ask when uncertain anything nothing more less than no not up ' +
    'can be within chose choose did do add ever before used use regularly bought have has ' +
    'replace worn new size chf eur usd gbp including below above or other that this may agent ' +
    'ordinary specialist sports sporting returned return pause looks like someone driving session')
    .split(' '),
);

export const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));

function matchCatalogueItems(instruction: string, catalogue: CatalogueItem[]): CatalogueItem[] {
  const words = new Set(tokens(instruction).filter((t) => !STOPWORDS.has(t)));
  let best: CatalogueItem[] = [];
  let bestCount = 0;
  for (const item of catalogue) {
    const itemTokens = tokens(item.item_name);
    const matched = itemTokens.filter((t) => words.has(t)).length;
    const coverage = matched / itemTokens.length;
    // Must match the head noun (last word of the catalogue name) and most of the name.
    if (!words.has(itemTokens[itemTokens.length - 1]) || coverage < 0.6 || matched < 2) continue;
    if (matched > bestCount) { best = [item]; bestCount = matched; }
    else if (matched === bestCount) best.push(item);
  }
  return best;
}

export function parseAmount(clause: string): { value: number; currency: Currency } | undefined {
  const m = clause.match(/\b(CHF|EUR|GBP|USD|Fr\.?)\s?(\d+(?:[.,]\d{1,2})?)/i) ??
    clause.match(/(\d+(?:[.,]\d{1,2})?)\s?(CHF|EUR|GBP|USD|francs?)\b/i);
  if (!m) return undefined;
  const [a, b] = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const cur = a.toUpperCase().startsWith('FR') ? 'CHF' : (a.toUpperCase() as Currency);
  return { value: Number(b.replace(',', '.')), currency: cur };
}

function parsePeriodDays(clause: string): number | undefined {
  const m = clause.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty)\s+(day|week|month)s?\b/i);
  if (m) {
    const n = /\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
    return n * ({ day: 1, week: 7, month: 30 } as const)[m[2].toLowerCase() as 'day' | 'week' | 'month'];
  }
  if (/\b(per|a|each|every) week\b|\bweekly\b/i.test(clause)) return 7;
  if (/\b(per|a|each|every) month\b|\bmonthly\b/i.test(clause)) return 30;
  if (/\b(per|a|each|every) day\b|\bdaily\b/i.test(clause)) return 1;
  return undefined;
}

export function compileInstruction(instruction: string, catalogue: CatalogueItem[]): PolicyDraft {
  const text = instruction.trim();
  const lower = text.toLowerCase();
  const rules: RuleExplanation[] = [];
  const guidance: string[] = [];
  const openQuestions: string[] = [];
  const add = (rule: HardRule, explanation: string, source: string) => rules.push({ rule, text: explanation, source });

  // Split into clauses so "each order ≤ X, and total across 7 days ≤ Y" gives two rules.
  // "CHF 100 per purchase and CHF 400 per month" is also split, before a second amount.
  const clauses = text
    .split(/(?<=[.!?;])\s+|,\s*(?:and|but)\s+|\s+(?:and|but|,)\s+(?=(?:(?:up to|at most|max(?:imum)?|no more than|not more than|under|below|less than)\s+)?(?:CHF|EUR|GBP|USD|Fr\.?)\s?\d)/i)
    .map((c) => c.trim()).filter(Boolean);
  const consumed = new Set<string>();

  // --- Money limits ---------------------------------------------------------
  for (const clause of clauses) {
    const amount = parseAmount(clause);
    if (!amount) continue;
    consumed.add(clause);
    const strict = /\b(less than|under|below)\b/i.test(clause) && !/\bat or below\b|\bor less\b/i.test(clause);
    const operator = strict ? '<' : '<=';
    const perPurchase = /\b(per|each|every|a single|one) (purchase|order|payment|transaction|item)\b/i.test(clause);
    const periodDays = !perPurchase && (/\b(total|across|in any|altogether|combined|overall)\b/i.test(clause) || /\b(per|a|each|every) (week|month|day)\b|\b(weekly|monthly|daily)\b/i.test(clause))
      ? parsePeriodDays(clause)
      : undefined;
    const rule: HardRule = { field: FIELDS.amount, operator, value: amount.value, currency: amount.currency, scope: periodDays ? 'period' : 'purchase' };
    if (periodDays) rule.period_days = periodDays;
    const cur = amount.currency;
    add(
      rule,
      periodDays
        ? `Total approved agent spending in any rolling ${periodDays}-day window must stay ${operator === '<' ? 'below' : 'at or below'} ${cur} ${amount.value}. Only purchases that end up approved count (including ones you approve yourself); declined or still-pending ones do not.`
        : `Each order's full charged amount (including delivery, converted to CHF at the fixed rate) must be ${operator === '<' ? 'below' : 'at or below'} ${cur} ${amount.value}.`,
      clause,
    );
  }

  // --- What may be bought ---------------------------------------------------
  const matchedItems = matchCatalogueItems(text, catalogue);
  const exclusion = lower.match(/\b(no|not|never|avoid|without|except|excluding)\b[^.]*?\b(gift ?cards?|vouchers?|cosmetics|beauty|subscriptions?|memberships?|alcohol)/);
  const includedCategories = Object.entries(ITEM_CATEGORY_SYNONYMS)
    .filter(([, re]) => re.test(lower))
    .map(([cat]) => cat)
    .filter((cat) => !(exclusion && ITEM_CATEGORY_SYNONYMS[cat].test(exclusion[0])));

  if (matchedItems.length > 0) {
    add(
      { field: FIELDS.itemId, operator: 'in', value: matchedItems.map((i) => i.item_id) },
      `Every cart line must be the requested product: ${matchedItems.map((i) => `“${i.item_name}” (${i.item_id})`).join(', ')}. Substitutes, different models or unrelated items are not accepted.`,
      matchedItems.map((i) => i.item_name).join(', '),
    );
    openQuestions.push(
      `We matched your request to ${matchedItems.map((i) => `“${i.item_name}”`).join(' / ')}. Similar products (for example a different variant) will be declined — is that what you want?`,
    );
  } else if (includedCategories.length > 0) {
    add(
      { field: FIELDS.itemCategory, operator: 'in', value: includedCategories },
      `Every cart line must be in the category ${includedCategories.join(', ')}. A shop's category alone is not enough: each item in the basket is checked.`,
      includedCategories.join(', '),
    );
  } else {
    openQuestions.push('We could not tell which products the agent may buy. Please add a product or category, otherwise only amount and shop checks apply.');
  }
  if (exclusion) {
    const cats = Object.entries(ITEM_CATEGORY_SYNONYMS).filter(([, re]) => re.test(exclusion[0])).map(([c]) => c);
    if (cats.length) add({ field: FIELDS.itemCategory, operator: 'not_in', value: cats }, `Baskets containing ${cats.join(', ')} are never allowed.`, exclusion[0]);
  }

  const qty = lower.match(/\b(one|a single|1)\s+(?:[a-z-]+\s+){0,3}(item|product|thing)\b/);
  if (qty) add({ field: FIELDS.quantity, operator: '<=', value: 1 }, 'The basket may contain at most one unit in total.', qty[0]);

  const size = text.match(/\bsize\s+([0-9]{2}(?:\.5)?|XXS|XS|S|M|L|XL|XXL)\b/i);
  if (size) {
    add(
      { field: FIELDS.size, operator: '=', value: size[1].toUpperCase() },
      `The product must be size ${size[1].toUpperCase()}. The size is read from the shop's product text; if no size is stated we ask you.`,
      size[0],
    );
  }

  if (/\b(do not|don't|never)\s+add\b|\bnothing (else|extra)\b|\bdid not ask for\b|\bno (add-?ons|extras)\b/i.test(text)) {
    add({ field: FIELDS.unrequested, operator: '<=', value: 0 }, 'No extra lines: add-ons, protection plans or anything else you did not request make the order fail.', 'do not add anything');
  }

  // --- Order terms ----------------------------------------------------------
  const ret = lower.match(/return(?:ed|able|s)?\b[^.]*?\bwithin\s+(\d+|[a-z]+)\s+days/) ?? lower.match(/(\d+)[- ]day returns?/);
  if (ret) {
    const n = /\d/.test(ret[1]) ? Number(ret[1]) : NUMBER_WORDS[ret[1]];
    add(
      { field: FIELDS.returnDays, operator: '>=', value: n },
      `The order must be returnable for at least ${n} days. “Final sale” or non-returnable counts as 0 days; if the shop states no return terms, the purchase is treated as uncertain.`,
      ret[0],
    );
  }
  if (/\bfor delivery\b|\bdelivered\b|\bhome delivery\b/i.test(text)) {
    add({ field: FIELDS.fulfillment, operator: 'in', value: ['delivery'] }, 'Orders must be delivered (not digital or pick-up).', 'for delivery');
  }
  const arrive = lower.match(/\b(?:arrive[sd]?|deliver(?:ed|y)?|ship(?:ped|s)?|receive[sd]?)\b[^.]*?\bwithin\s+(\d+|[a-z]+)\s+(?:working\s+|business\s+|calendar\s+)?days/);
  if (arrive) {
    const n = /\d/.test(arrive[1]) ? Number(arrive[1]) : NUMBER_WORDS[arrive[1]];
    add(
      { field: FIELDS.deliveryDays, operator: '<=', value: n },
      `The order must arrive within ${n} days of purchase. If the order carries no delivery date, the purchase is treated as uncertain.`,
      arrive[0],
    );
  }

  // --- Who may be paid ------------------------------------------------------
  for (const [cat, re] of Object.entries(MERCHANT_CATEGORY_SYNONYMS)) {
    const m = lower.match(re);
    if (m && cat !== 'groceries') {
      add({ field: FIELDS.merchantCategory, operator: 'in', value: [cat] }, `The seller must be a ${cat.replace('_', ' ')} retailer (by its registered merchant category / MCC), not a general or unrelated shop.`, m[0]);
    }
  }
  const regular = /\b(use|shop at|buy from|order from)\s+regularly\b|\bregular (shop|seller|store)s?\b/i.exec(text);
  const before = /\b(used|bought from|shopped at|ordered from|bought at)\s+before\b|\bshops? i know\b|\bfamiliar (shop|seller)s?\b/i.exec(text);
  if (regular) {
    add({ field: FIELDS.familiarity, operator: '>=', value: 3 }, 'The shop must be one you use regularly: at least 3 earlier approved purchases on this card at that exact merchant (lookalike names do not count).', regular[0]);
  } else if (before) {
    add({ field: FIELDS.familiarity, operator: '>=', value: 1 }, 'The shop must be one you have bought from before: at least 1 earlier approved purchase on this card at that exact merchant (lookalike names do not count).', before[0]);
  }
  if (/\b(swiss|switzerland)[- ]?(based )?(shops?|sellers?|merchants?|stores?)\b|\bonly (in|from) switzerland\b/i.test(text)) {
    add({ field: FIELDS.merchantCountry, operator: 'in', value: ['CH'] }, 'The seller must be based in Switzerland.', 'Swiss shops');
  }
  const chfOnly = text.match(/\b(?:chf|swiss francs?)\s+only\b|\bonly\s+(?:pay|purchases?|charges?|transactions?)(?:\s+\S+){0,2}\s+in\s+(?:chf|swiss francs?)\b/i);
  if (chfOnly) {
    add({ field: FIELDS.currency, operator: 'in', value: ['CHF'] }, 'Only purchases charged in Swiss Francs (CHF) are allowed.', chfOnly[0]);
  }

  // --- Time windows ---------------------------------------------------------
  const hours = lower.match(/\bbetween\s+(\d{1,2})(?::00)?\s*(?:h|am|pm)?\s*(?:and|-|to)\s*(\d{1,2})(?::00)?\s*(?:h|am|pm)?/);
  if (hours) {
    add({ field: FIELDS.localHour, operator: '>=', value: Number(hours[1]) }, `Purchases only from ${hours[1]}:00 Swiss time.`, hours[0]);
    add({ field: FIELDS.localHour, operator: '<', value: Number(hours[2]) }, `Purchases only until ${hours[2]}:00 Swiss time.`, hours[0]);
  } else if (/\b(not|never|no purchases?) (at night|overnight)\b/i.test(text)) {
    add({ field: FIELDS.localHour, operator: '>=', value: 6 }, 'No purchases between midnight and 06:00 Swiss time.', 'not at night');
  }

  // --- Uncertainty ----------------------------------------------------------
  let uncertainty: UncertaintyPolicy = 'ask';
  if (/\b(decline|reject|block|cancel)\b[^.]*\b(uncertain|unsure|in doubt|unclear)\b|\bwhen in doubt,? (don't|do not|decline)/i.test(text)) uncertainty = 'decline';
  else if (/\b(approve|go ahead|proceed)\b[^.]*\b(uncertain|unsure|in doubt)\b/i.test(text)) uncertainty = 'approve';
  else if (!/\b(ask|check with|confirm with|pause)\b/i.test(text)) {
    openQuestions.push('You did not say what to do when we are unsure. We will ask you (step-up) by default — change it if you prefer automatic decline.');
  }

  const sessionStrict = /\bsomeone other than me\b|\bsession\b|\baccount takeover\b|\bnot me\b|\bhijack/i.test(text);
  if (sessionStrict) {
    guidance.push('Session integrity: a new device, a burst of attempts, night-time activity or an unfamiliar country pauses the purchase for your confirmation.');
  }

  // Standing protections that apply to every policy.
  guidance.push(
    'Shop-provided text (product descriptions) is treated as untrusted data. Instructions hidden in it are ignored and flagged; they can never loosen your limits.',
    'Duplicate orders (same shop, same items, similar amount within 24 hours of an approved or pending one) are stopped.',
    'Sellers whose names imitate a shop you know are treated as impersonation and declined.',
    'Rules are combined with AND: any failed rule declines the purchase; missing information triggers your uncertainty choice.',
  );
  if (rules.some((r) => r.rule.field === FIELDS.familiarity)) {
    openQuestions.push('Unknown shops fail the “familiar shop” rule and are declined. Should an unfamiliar shop be asked about instead? (You can only tighten later, not loosen.)');
  }
  if (!rules.some((r) => r.rule.field === FIELDS.amount)) {
    openQuestions.push('No spending limit was found. Please state a maximum per order — without it we only rely on other checks.');
  }

  const unmatched = clauses.filter((c) => !consumed.has(c) && tokens(c).filter((t) => !STOPWORDS.has(t)).length > 3 && !rules.some((r) => c.toLowerCase().includes(r.source.toLowerCase())) && !/\bask me\b|\buncertain\b|someone other than me/i.test(c));
  for (const c of unmatched) openQuestions.push(`We may not have fully understood: “${c}”. Please check the rules above cover it.`);

  return {
    instruction,
    hard_rules: rules.map((r) => r.rule),
    uncertainty_policy: uncertainty,
    guidance,
    open_questions: openQuestions,
    explanations: rules,
    intents: {
      session_strict: sessionStrict,
      requested_item_ids: matchedItems.map((i) => i.item_id),
      requested_item_names: matchedItems.map((i) => i.item_name),
    },
  };
}

/** Plain-language rendering of any rule, including ones added later by the customer. */
export function describeRule(rule: HardRule): string {
  const op: Record<string, string> = { '<': 'below', '<=': 'at most', '=': 'exactly', '!=': 'not', '>': 'more than', '>=': 'at least', in: 'one of', not_in: 'none of' };
  const v = Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value);
  switch (rule.field) {
    case FIELDS.amount:
      return rule.scope === 'period'
        ? `Spending in any ${rule.period_days ?? '?'}-day window ${op[rule.operator]} ${rule.currency ?? 'CHF'} ${v}`
        : `Each order ${op[rule.operator]} ${rule.currency ?? 'CHF'} ${v} (incl. delivery)`;
    case FIELDS.familiarity: return `Shop has ${op[rule.operator]} ${v} earlier approved purchase(s) on this card`;
    case FIELDS.itemId: return `Cart items ${op[rule.operator]}: ${v}`;
    case FIELDS.itemCategory: return `Item categories ${op[rule.operator]}: ${v}`;
    case FIELDS.size: return `Size ${op[rule.operator]} ${v}`;
    case FIELDS.returnDays: return `Return window ${op[rule.operator]} ${v} days`;
    case FIELDS.deliveryDays: return `Delivery time ${op[rule.operator]} ${v} days`;
    case FIELDS.merchantCategory: return `Shop category ${op[rule.operator]}: ${v}`;
    case FIELDS.merchantCountry: return `Shop country ${op[rule.operator]}: ${v}`;
    case FIELDS.currency: return `Currency ${op[rule.operator]}: ${v}`;
    case FIELDS.quantity: return `Total quantity ${op[rule.operator]} ${v}`;
    case FIELDS.unrequested: return 'No unrequested add-ons';
    case FIELDS.fulfillment: return `Fulfilment ${op[rule.operator]}: ${v}`;
    case FIELDS.localHour: return `Swiss local hour ${op[rule.operator]} ${v}`;
    default: return `${rule.field} ${rule.operator} ${v}`;
  }
}
