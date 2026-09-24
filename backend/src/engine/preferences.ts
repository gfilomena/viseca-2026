import type { CartLine } from '../domain/types.ts';

/**
 * Customer profile preferences (customers.csv) are not part of the confirmed
 * policy, so they can never decline a purchase. When a basket goes against one,
 * the purchase is treated as uncertain and the customer's uncertainty choice applies.
 */

export interface Preference { phrase: string; kind: 'avoid' | 'expect'; test: PreferenceTest }
type PreferenceTest =
  | { type: 'category'; categories: string[] }
  | { type: 'addons' }
  | { type: 'terms'; terms: string[] }
  | { type: 'returns' }
  | { type: 'warranty' }
  | { type: 'fulfillment'; avoid: string };

const CATEGORY_WORDS: [RegExp, string[]][] = [
  [/gift ?(vouchers?|cards?)/, ['gift_card']],
  [/(premium|membership)/, ['membership']],
  [/subscriptions?/, ['subscriptions']],
  [/(fashion|clothing|apparel)/, ['clothing']],
  [/(cosmetics|beauty|fragrance)/, ['cosmetics']],
];

const STOP = new Set(['no', 'the', 'and', 'or', 'a', 'an', 'automatic', 'unrequested', 'purchases', 'services', 'products', 'items']);

export function parsePreferences(text: string | null | undefined): Preference[] {
  if (!text) return [];
  const out: Preference[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\b(?:avoids?|no|without|rather than)\s+([^;.,]+)/g)) {
    const phrase = m[1].trim();
    if (/^(home )?delivery$/.test(phrase)) { out.push({ phrase, kind: 'avoid', test: { type: 'fulfillment', avoid: 'delivery' } }); continue; }
    const cats = CATEGORY_WORDS.filter(([re]) => re.test(phrase)).flatMap(([, c]) => c);
    if (/\b(add-?ons?|upgrades?|bundled|extras?|substitutions?|financing)\b/.test(phrase)) {
      out.push({ phrase, kind: 'avoid', test: { type: 'addons' } });
    }
    if (cats.length) out.push({ phrase, kind: 'avoid', test: { type: 'category', categories: cats } });
    else if (!out.some((p) => p.phrase === phrase)) {
      const terms = phrase.split(/[^a-z0-9-]+/).filter((t) => t.length > 2 && !STOP.has(t));
      if (terms.length) out.push({ phrase, kind: 'avoid', test: { type: 'terms', terms } });
    }
  }
  if (/\b(clear )?return (terms|window)\b|\bwith returns\b/.test(lower)) out.push({ phrase: 'clear return terms', kind: 'expect', test: { type: 'returns' } });
  if (/\bwarranty\b/.test(lower)) out.push({ phrase: 'clear warranty terms', kind: 'expect', test: { type: 'warranty' } });
  return out;
}

export interface PreferenceContext {
  lines: CartLine[];
  isRequested: (l: CartLine) => boolean;
  requestedLines: CartLine[];
  returnsKnown: boolean;
  fulfillment: string;
}

/** Returns a human-readable reason for every preference the basket goes against. */
export function preferenceConflicts(prefs: Preference[], ctx: PreferenceContext): string[] {
  const out: string[] = [];
  for (const p of prefs) {
    const t = p.test;
    if (t.type === 'category') {
      const hit = ctx.lines.filter((l) => t.categories.includes(l.item_category));
      if (hit.length) out.push(`you avoid ${p.phrase}, but the basket has ${hit.map((l) => `“${l.item_name}”`).join(', ')}`);
    } else if (t.type === 'addons') {
      const hit = ctx.lines.filter((l) => !ctx.isRequested(l) || /\b(add-?on|optional|upgrade|financing|billed monthly)\b/i.test(l.item_details));
      if (hit.length) out.push(`you prefer ${p.phrase.startsWith('no ') ? p.phrase : `no ${p.phrase}`}, but the basket has ${hit.map((l) => `“${l.item_name}”`).join(', ')}`);
    } else if (t.type === 'terms') {
      const hit = ctx.lines.filter((l) => t.terms.every((term) => `${l.item_name} ${l.item_details}`.toLowerCase().includes(term.replace(/s$/, ''))));
      if (hit.length) out.push(`you avoid ${p.phrase}, which matches ${hit.map((l) => `“${l.item_name}”`).join(', ')}`);
    } else if (t.type === 'returns') {
      if (!ctx.returnsKnown) out.push('you prefer clear return terms, but the shop does not state them');
    } else if (t.type === 'fulfillment') {
      if (ctx.fulfillment === t.avoid) out.push(`you prefer store collection rather than ${t.avoid}, but this order is for ${ctx.fulfillment}`);
    } else if (t.type === 'warranty') {
      const missing = ctx.requestedLines.filter((l) => !/\bwarranty\b/i.test(l.item_details));
      if (missing.length && ctx.requestedLines.length) out.push(`you prefer clear warranty terms, but none is stated for ${missing.map((l) => `“${l.item_name}”`).join(', ')}`);
    }
  }
  return out;
}
