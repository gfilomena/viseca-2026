import type { AuthorizationEvent, Check, Decision, EngineResult, HardRule } from '../domain/types.ts';
import { chf, roundHalfEven } from '../domain/money.ts';
import { FIELDS, describeRule, type PolicyIntents } from '../policy/compiler.ts';
import type { CardProfile } from './profile.ts';
import { detectInjection, extractFacts, isLookalike, type InjectionFinding } from './untrusted.ts';
import { parsePreferences, preferenceConflicts } from './preferences.ts';

/** An earlier decision in the same run, used for rolling limits, duplicates and familiarity. */
export interface PriorDecision {
  authorization_id: string;
  sim_timestamp: string;
  merchant_id: string;
  billing_amount_chf: number;
  item_signature: string;
  customer_device_id: string | null;
  status: 'approved' | 'declined' | 'pending' | 'expired';
}

export interface CatalogueEntry { item_name: string; min: number; max: number }

export interface EngineInput {
  event: AuthorizationEvent;
  profile: CardProfile;
  prior: PriorDecision[];
  fx: Record<string, number>;
  catalogue: Map<string, CatalogueEntry>;
  intents: PolicyIntents;
  /** Describes the delegation when there is no fixture authority (e.g. sandbox purchases). */
  delegation?: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const itemSignature = (e: AuthorizationEvent) =>
  e.authorization.items.map((i) => `${i.item_id}x${i.quantity}`).sort().join('+');

function zurichHour(iso: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }).format(new Date(iso))) % 24;
}

function compare(actual: number | string, op: HardRule['operator'], expected: HardRule['value']): boolean {
  if (op === 'in' || op === 'not_in') {
    const list = (Array.isArray(expected) ? expected : [String(expected)]).map((s) => s.toLowerCase());
    const hit = list.includes(String(actual).toLowerCase());
    return op === 'in' ? hit : !hit;
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    const a = roundHalfEven(actual), b = roundHalfEven(expected);
    switch (op) {
      case '<': return a < b; case '<=': return a <= b; case '>': return a > b;
      case '>=': return a >= b; case '=': return a === b; case '!=': return a !== b;
    }
  }
  const a = String(actual).toLowerCase(), b = String(expected).toLowerCase();
  if (op === '=') return a === b;
  if (op === '!=') return a !== b;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return compare(na, op, nb);
  return false;
}

const REASON_BY_FIELD: Record<string, string> = {
  [FIELDS.amount]: 'amount_over_limit',
  [FIELDS.itemId]: 'item_not_requested',
  [FIELDS.itemCategory]: 'item_category_not_allowed',
  [FIELDS.size]: 'item_attribute_mismatch',
  [FIELDS.returnDays]: 'return_terms_insufficient',
  [FIELDS.deliveryDays]: 'delivery_too_slow',
  [FIELDS.merchantCategory]: 'merchant_category_not_allowed',
  [FIELDS.merchantCountry]: 'merchant_country_not_allowed',
  [FIELDS.familiarity]: 'unfamiliar_merchant',
  [FIELDS.quantity]: 'quantity_exceeded',
  [FIELDS.unrequested]: 'unrequested_addon',
  [FIELDS.fulfillment]: 'fulfillment_not_allowed',
  [FIELDS.localHour]: 'outside_time_window',
};

export function evaluate(input: EngineInput): EngineResult {
  const t0 = performance.now();
  const { event, profile, prior, fx, catalogue, intents } = input;
  const a = event.authorization;
  const m = a.merchant;
  const checks: Check[] = [];
  const evidence: string[] = [];
  const reasons = new Set<string>();
  const nowMs = Date.parse(a.timestamp);
  const rules = event.mandate.hard_rules ?? [];

  const approvedPrior = prior.filter((p) => p.status === 'approved');
  const facts = a.items.map((l) => ({ line: l, facts: extractFacts(l.item_details), injections: detectInjection(l.line_no, l.item_details) }));
  const injections: InjectionFinding[] = facts.flatMap((f) => f.injections);

  // ---- Platform / lifecycle preconditions -----------------------------------
  if (event.mandate.status !== 'active') {
    checks.push({ id: 'mandate', label: 'Wallet policy active', status: 'fail', detail: `The wallet policy is ${event.mandate.status}.` });
    reasons.add('mandate_inactive');
  }
  if (a.authority_status !== 'active' || a.card_status_at_attempt !== 'active') {
    checks.push({ id: 'card', label: 'Card and delegation active', status: 'fail', detail: `Authority ${a.authority_status}, card ${a.card_status_at_attempt}.` });
    reasons.add('card_or_authority_inactive');
  }

  // ---- Customer rules (hard) ------------------------------------------------
  const requestedIds = rules.filter((r) => r.field === FIELDS.itemId && r.operator === 'in').flatMap((r) => r.value as string[]);
  const requestedCats = rules.filter((r) => r.field === FIELDS.itemCategory && r.operator === 'in').flatMap((r) => r.value as string[]);
  const isRequested = (l: (typeof a.items)[number]) =>
    requestedIds.length ? requestedIds.includes(l.item_id) : requestedCats.length ? requestedCats.includes(l.item_category) : true;

  const merchantFamiliarity = (profile.merchantCounts.get(m.merchant_id) ?? 0) +
    approvedPrior.filter((p) => p.merchant_id === m.merchant_id).length;

  let purchaseLimitChf: number | undefined;

  rules.forEach((rule, idx) => {
    const id = `rule:${idx}`;
    const label = describeRule(rule);
    const push = (status: Check['status'], detail: string) => {
      checks.push({ id, label, status, detail, rule });
      if (status === 'fail') reasons.add(REASON_BY_FIELD[rule.field] ?? 'policy_rule_failed');
      if (status === 'uncertain') reasons.add(`${REASON_BY_FIELD[rule.field] ?? 'policy_rule'}_uncertain`);
    };
    const limitChf = typeof rule.value === 'number' ? roundHalfEven(rule.value * (fx[rule.currency ?? 'CHF'] ?? 1)) : NaN;

    switch (rule.field) {
      case FIELDS.amount: {
        if (rule.scope === 'period') {
          const days = rule.period_days ?? 30;
          const from = nowMs - days * DAY;
          const inWindow = approvedPrior.filter((p) => { const t = Date.parse(p.sim_timestamp); return t > from && t <= nowMs; });
          const spent = roundHalfEven(inWindow.reduce((s, p) => s + p.billing_amount_chf, 0));
          const total = roundHalfEven(spent + a.billing_amount_chf);
          evidence.push(`Approved agent spend in the ${days} days before this order: ${chf(spent)} (${inWindow.length} order(s)); platform counter: ${event.context.approved_spend_in_period_chf ?? 'n/a'}.`);
          push(compare(total, rule.operator, limitChf) ? 'pass' : 'fail',
            `${chf(spent)} already approved + ${chf(a.billing_amount_chf)} now = ${chf(total)} vs limit ${chf(limitChf)}.`);
        } else {
          purchaseLimitChf = purchaseLimitChf === undefined ? limitChf : Math.min(purchaseLimitChf, limitChf);
          const conv = a.currency === 'CHF' ? '' : ` (${a.currency} ${a.amount.toFixed(2)} × ${fx[a.currency]})`;
          push(compare(a.billing_amount_chf, rule.operator, limitChf) ? 'pass' : 'fail',
            `Charged ${chf(a.billing_amount_chf)}${conv}, incl. delivery ${a.delivery_fee.toFixed(2)}; limit ${chf(limitChf)}.`);
        }
        break;
      }
      case FIELDS.itemId:
      case FIELDS.itemCategory: {
        const key = rule.field === FIELDS.itemId ? 'item_id' : 'item_category';
        const bad = a.items.filter((l) => !compare(l[key], rule.operator, rule.value));
        push(bad.length ? 'fail' : 'pass', bad.length
          ? `Not allowed: ${bad.map((l) => `“${l.item_name}” (${l.item_category})`).join(', ')}.`
          : `All ${a.items.length} line(s) match: ${a.items.map((l) => l.item_name).join(', ')}.`);
        break;
      }
      case FIELDS.size: {
        const stated = facts.filter((f) => isRequested(f.line) && f.facts.size);
        if (!stated.length) push('uncertain', 'The shop does not state a size for the requested product.');
        else {
          const bad = stated.filter((f) => !compare(f.facts.size!, rule.operator, rule.value));
          push(bad.length ? 'fail' : 'pass', `Shop states size ${stated.map((f) => f.facts.size).join(', ')}.`);
        }
        break;
      }
      case FIELDS.returnDays: {
        if (a.order_returnable === 'false') { push('fail', 'The order is marked as not returnable.'); break; }
        if (a.order_returnable === 'not_applicable') { push('uncertain', 'Returns do not apply to this kind of order.'); break; }
        const relevant = facts.filter((f) => isRequested(f.line));
        const known = relevant.filter((f) => f.facts.returnDays !== undefined && f.facts.returnDays !== null);
        if (!known.length) { push('uncertain', 'The shop does not state how long the order can be returned.'); break; }
        const minDays = Math.min(...known.map((f) => f.facts.returnDays as number));
        const detail = known.some((f) => f.facts.noReturns) ? 'Final sale / no returns.' : `Returns accepted within ${minDays} days.`;
        push(compare(minDays, rule.operator, rule.value) ? 'pass' : 'fail', detail);
        break;
      }
      case FIELDS.deliveryDays: {
        if (a.fulfillment_method !== 'delivery') { push('uncertain', 'This order is not a home delivery, so no delivery date applies.'); break; }
        if (!a.delivery_by) { push('uncertain', 'The order does not state a delivery date.'); break; }
        const days = Math.ceil((Date.parse(a.delivery_by) - Date.parse(a.timestamp)) / DAY);
        push(compare(days, rule.operator, rule.value) ? 'pass' : 'fail', `Expected delivery in ${days} day(s), by ${a.delivery_by}.`);
        break;
      }
      case FIELDS.merchantCategory:
        push(compare(m.merchant_category, rule.operator, rule.value) ? 'pass' : 'fail', `${m.merchant_name} is registered as ${m.merchant_category} (MCC ${m.merchant_mcc}).`);
        break;
      case FIELDS.merchantCountry:
        push(compare(m.merchant_country, rule.operator, rule.value) ? 'pass' : 'fail', `${m.merchant_name} is in ${m.merchant_city}, ${m.merchant_country}.`);
        break;
      case FIELDS.familiarity:
        push(compare(merchantFamiliarity, rule.operator, rule.value) ? 'pass' : 'fail',
          `${merchantFamiliarity} earlier approved purchase(s) on this card at ${m.merchant_name} (${m.merchant_id}).`);
        break;
      case FIELDS.quantity: {
        const q = a.items.reduce((s, l) => s + l.quantity, 0);
        push(compare(q, rule.operator, rule.value) ? 'pass' : 'fail', `Basket contains ${q} unit(s).`);
        break;
      }
      case FIELDS.unrequested: {
        if (!requestedIds.length && !requestedCats.length) { push('uncertain', 'No requested product is defined to compare the basket with.'); break; }
        const extra = a.items.filter((l) => !isRequested(l));
        push(compare(extra.length, rule.operator, rule.value) ? 'pass' : 'fail',
          extra.length ? `Unrequested: ${extra.map((l) => `“${l.item_name}” ${l.currency} ${l.unit_price.toFixed(2)}`).join(', ')}.` : 'Nothing extra in the basket.');
        break;
      }
      case FIELDS.fulfillment:
        push(compare(a.fulfillment_method, rule.operator, rule.value) ? 'pass' : 'fail', `Fulfilment: ${a.fulfillment_method}.`);
        break;
      case FIELDS.localHour: {
        const h = zurichHour(a.timestamp);
        push(compare(h, rule.operator, rule.value) ? 'pass' : 'fail', `Order placed at ${h}:00 Swiss time.`);
        break;
      }
      default:
        push('uncertain', `This rule (${rule.field}) is not understood by the engine, so it cannot be confirmed.`);
    }
  });

  // ---- Built-in protections (independent of the customer's wording) --------
  if (injections.length) {
    reasons.add('merchant_text_manipulation');
    checks.push({
      id: 'injection', label: 'Shop text contains instructions', status: 'uncertain',
      detail: `Ignored ${injections.length} instruction(s) hidden in the product text (${[...new Set(injections.map((i) => i.reason))].join('; ')}). Your limits were applied unchanged.`,
    });
    for (const i of injections) evidence.push(`Untrusted text on line ${i.line_no}: “…${i.excerpt}…”`);
  }

  const lookalike = [...profile.merchantNames.entries()].find(([id, name]) => id !== m.merchant_id && isLookalike(m.merchant_name, name));
  if (lookalike) {
    reasons.add('lookalike_merchant');
    checks.push({ id: 'lookalike', label: 'Seller identity', status: 'fail', detail: `“${m.merchant_name}” (${m.merchant_id}) imitates “${lookalike[1]}” (${lookalike[0]}), a shop you know. It is a different merchant.` });
  }

  const sig = itemSignature(event);
  const dup = prior.find((p) => p.merchant_id === m.merchant_id && p.item_signature === sig &&
    (p.status === 'approved' || p.status === 'pending') &&
    Math.abs(p.billing_amount_chf - a.billing_amount_chf) <= Math.max(1, 0.05 * a.billing_amount_chf) &&
    nowMs - Date.parse(p.sim_timestamp) < DAY && nowMs >= Date.parse(p.sim_timestamp));
  if (dup) {
    const pending = dup.status === 'pending';
    reasons.add(pending ? 'possible_duplicate_pending' : 'duplicate_order');
    checks.push({ id: 'duplicate', label: 'Duplicate order', status: pending ? 'uncertain' : 'fail',
      detail: `Same shop, same items and ${chf(dup.billing_amount_chf)} already ${dup.status} (${dup.authorization_id}) ${Math.round((nowMs - Date.parse(dup.sim_timestamp)) / 60000)} min earlier.` });
  }

  if (a.related_authorization_id) {
    const st = a.related_authorization_status;
    const ok = st === 'declined' || st === 'cancelled';
    if (!ok) reasons.add('related_order_open');
    checks.push({ id: 'related', label: 'Re-quote of an earlier order', status: ok ? 'info' : 'uncertain',
      detail: ok ? `Replaces ${a.related_authorization_id}, which was ${st}; judged on its own facts, no double charge.`
        : `Relates to ${a.related_authorization_id} which is ${st ?? 'unknown'}: paying both could double-charge you.` });
  }

  if (purchaseLimitChf !== undefined) {
    const recent = prior.filter((p) => p.merchant_id === m.merchant_id && (p.status === 'approved' || p.status === 'pending') &&
      nowMs - Date.parse(p.sim_timestamp) <= HOUR && nowMs >= Date.parse(p.sim_timestamp));
    const combined = roundHalfEven(recent.reduce((s, p) => s + p.billing_amount_chf, 0) + a.billing_amount_chf);
    if (recent.length && !dup && combined > purchaseLimitChf) {
      reasons.add('possible_split_order');
      checks.push({ id: 'split', label: 'Possible split order', status: 'uncertain',
        detail: `${recent.length + 1} orders at ${m.merchant_name} within an hour total ${chf(combined)}, above your ${chf(purchaseLimitChf)} per-order limit.` });
    }
  }

  // Consistency of the payment message itself.
  const expectedBilling = roundHalfEven(a.amount * (fx[a.currency] ?? NaN));
  const lineTotal = roundHalfEven(a.items.reduce((s, l) => s + l.unit_price * l.quantity, 0));
  if (!Number.isFinite(expectedBilling) || Math.abs(expectedBilling - a.billing_amount_chf) > 0.01) {
    reasons.add('amount_inconsistent');
    checks.push({ id: 'fx', label: 'Amount consistency', status: 'uncertain', detail: `Billing ${chf(a.billing_amount_chf)} does not match ${a.currency} ${a.amount} at the fixed rate (${chf(expectedBilling)}).` });
  } else if (Math.abs(roundHalfEven(lineTotal + a.delivery_fee) - a.amount) > 0.01) {
    reasons.add('amount_inconsistent');
    checks.push({ id: 'cart', label: 'Amount consistency', status: 'uncertain', detail: `Cart lines (${lineTotal.toFixed(2)}) + delivery (${a.delivery_fee.toFixed(2)}) ≠ charged ${a.amount.toFixed(2)} ${a.currency}.` });
  }
  for (const l of a.items) {
    const c = catalogue.get(l.item_id);
    if (!c) continue;
    const unitChf = roundHalfEven(l.unit_price * (fx[l.currency] ?? 1));
    if (unitChf > c.max * 1.1) {
      checks.push({ id: `price:${l.line_no}`, label: 'Price plausibility', status: 'info', detail: `“${l.item_name}” at ${chf(unitChf)} is above the usual range (${chf(c.min)}–${chf(c.max)}).` });
    }
  }

  // ---- Card, account and delegation (issuer reference data) -----------------
  {
    const fails: string[] = [];
    const notes: string[] = [];
    const fail = (reason: string, text: string) => { reasons.add(reason); fails.push(text); };
    const day = a.timestamp.slice(0, 10);
    const c = profile.card;
    if (c) {
      if (c.status !== 'active') fail('card_inactive', `the card is ${c.status}`);
      if (c.expires_on && day >= c.expires_on) fail('card_expired', `the card expired on ${c.expires_on}`);
      if (!c.online_enabled && a.channel !== 'in_store' && a.channel !== 'atm') fail('card_online_disabled', 'online payments are switched off for this card');
      if (!c.international_enabled && m.merchant_country !== 'CH') fail('card_international_disabled', `payments abroad are switched off, and the shop is in ${m.merchant_country}`);
      notes.push(`card ${c.status}, valid until ${c.expires_on ?? '?'}, online ${c.online_enabled ? 'on' : 'off'}, abroad ${c.international_enabled ? 'on' : 'off'}`);
    } else {
      notes.push('card not found in reference data');
    }
    const acc = profile.account;
    if (acc) {
      if (acc.status !== 'active') fail('account_inactive', `the account is ${acc.status}`);
      if (acc.per_transaction_limit_chf != null && a.billing_amount_chf > acc.per_transaction_limit_chf) {
        fail('issuer_transaction_limit', `${chf(a.billing_amount_chf)} is above the account's ${chf(acc.per_transaction_limit_chf)} per-transaction limit`);
      }
      if (acc.monthly_limit_chf != null) {
        const month = a.timestamp.slice(0, 7);
        const used = roundHalfEven((profile.monthlySpend.get(month) ?? 0) +
          approvedPrior.filter((p) => p.sim_timestamp.startsWith(month)).reduce((sum, p) => sum + p.billing_amount_chf, 0));
        if (used + a.billing_amount_chf > acc.monthly_limit_chf) {
          fail('issuer_monthly_limit', `${chf(used)} already used this month + ${chf(a.billing_amount_chf)} exceeds the account's ${chf(acc.monthly_limit_chf)} monthly limit`);
        }
        notes.push(`account limits ${chf(acc.per_transaction_limit_chf ?? 0)} per payment, ${chf(acc.monthly_limit_chf)} per month (${chf(used)} used in ${month})`);
      }
    }
    if (input.delegation) notes.push(`delegation: ${input.delegation}`);
    if (profile.authorities.length) {
      const t = Date.parse(a.timestamp);
      const covering = profile.authorities.filter((x) => Date.parse(x.valid_from) <= t && t <= Date.parse(x.valid_until));
      if (!covering.length) fail('authority_outside_validity', `the agent's delegation for this card is not valid on ${day}`);
      else notes.push(`delegation ${covering[0].authority_id} valid until ${covering[0].valid_until.slice(0, 10)}`);
    }
    checks.push({
      id: 'issuer', label: 'Card, account and delegation',
      status: fails.length ? 'fail' : 'pass',
      detail: fails.length ? `${fails.join('; ')}.` : `OK: ${notes.join('; ')}.`,
    });
  }

  // ---- Customer profile preferences (soft) ------------------------------------
  {
    const prefs = parsePreferences(profile.customer?.shopping_preferences);
    const requestedLines = a.items.filter(isRequested);
    const returnsKnown = a.order_returnable === 'false' || a.order_returnable === 'not_applicable' ||
      facts.some((f) => isRequested(f.line) && f.facts.returnDays != null && !f.facts.returnUnstated);
    const conflicts = preferenceConflicts(prefs, { lines: a.items, isRequested, requestedLines, returnsKnown, fulfillment: a.fulfillment_method });
    if (conflicts.length) {
      reasons.add('customer_preference_conflict');
      const text = conflicts.join('; ');
      checks.push({
        id: 'preferences', label: 'Your stated preferences', status: 'uncertain',
        detail: `${text.charAt(0).toUpperCase()}${text.slice(1)}. This is not part of your policy, so we ask rather than decline.`,
      });
    }
  }

  // ---- Session / behavioural signals ----------------------------------------
  const cautions: string[] = [];
  const knownDevice = (profile.deviceCounts.get(a.customer_device_id) ?? 0) > 0 ||
    approvedPrior.some((p) => p.customer_device_id === a.customer_device_id);
  if (!knownDevice) {
    if (intents.session_strict) {
      reasons.add('new_device');
      checks.push({ id: 'device', label: 'Device', status: 'uncertain', detail: `Device ${a.customer_device_id} has never been used with this card before.` });
    } else cautions.push(`new device ${a.customer_device_id}`);
  }
  if (a.recent_attempt_count_10m >= 2) {
    reasons.add('high_velocity');
    checks.push({ id: 'velocity', label: 'Burst of attempts', status: 'uncertain', detail: `${a.recent_attempt_count_10m} other purchase attempts in the previous 10 minutes.` });
  }
  const hour = zurichHour(a.timestamp);
  if (hour < 6) cautions.push(`unusual hour (${hour}:00 Swiss time)`);
  if (!profile.countries.has(m.merchant_country)) cautions.push(`first purchase from a shop in ${m.merchant_country}`);
  if (profile.amountP95 > 0 && a.billing_amount_chf > profile.amountP95 * 1.5) cautions.push(`amount well above this card's usual (${chf(profile.amountP95)} p95)`);
  if (cautions.length) {
    const escalate = cautions.length >= 2 || (intents.session_strict && cautions.length >= 1 && !knownDevice);
    if (escalate) reasons.add('unusual_session');
    checks.push({ id: 'session', label: 'Unusual activity', status: escalate ? 'uncertain' : 'info', detail: `Signals: ${cautions.join('; ')}.` });
  }

  evidence.push(
    `Merchant ${m.merchant_name} (${m.merchant_id}, ${m.merchant_category}, ${m.merchant_country}): ${merchantFamiliarity} earlier approved purchase(s) on card ${a.card_id}.`,
    `Device ${a.customer_device_id}: ${knownDevice ? 'known' : 'new'} for this card.`,
    `Charged ${a.currency} ${a.amount.toFixed(2)} = ${chf(a.billing_amount_chf)} (delivery ${a.delivery_fee.toFixed(2)} included).`,
  );

  // ---- Combine ---------------------------------------------------------------
  const fails = checks.filter((c) => c.status === 'fail');
  const uncertain = checks.filter((c) => c.status === 'uncertain');
  let decision: Decision;
  const policy = event.mandate.uncertainty_policy;
  if (fails.length) decision = 'decline';
  else if (uncertain.length) decision = policy === 'ask' ? 'step_up' : policy;
  else decision = 'approve';
  if (decision === 'approve' && !fails.length && !uncertain.length) reasons.add('within_policy');
  if (uncertain.length && !fails.length) reasons.add(`uncertainty_policy_${policy}`);

  const who = `${chf(a.billing_amount_chf)} at ${m.merchant_name}`;
  // Built-in protections (impersonation, duplicates, manipulation) explain more than a generic rule miss, so lead with them.
  const ranked = (list: Check[]) => [...list].sort((x, y) => Number(x.id.startsWith('rule:')) - Number(y.id.startsWith('rule:')));
  let bullets = ranked(fails.length ? fails : uncertain).slice(0, 3).map((c) => `${c.label}: ${c.detail}`).join(' ');
  if (fails.length && injections.length) bullets += ' Note: the shop\'s product text tried to instruct the payment system; it was ignored.';
  const customer_message =
    decision === 'approve' && !uncertain.length ? `Approved ${who}: it meets all ${rules.length} of your rules.`
      : decision === 'approve' ? `Approved ${who} despite uncertainty, as your policy says. ${bullets}`
        : decision === 'decline' && fails.length ? `Declined ${who}. ${bullets}`
          : decision === 'decline' ? `Declined ${who} because something is uncertain and your policy says decline when unsure. ${bullets}`
            : `Please confirm ${who}. We are not sure: ${bullets}`;

  return {
    decision,
    reason_codes: [...reasons],
    customer_message: customer_message.slice(0, 900),
    checks,
    evidence,
    latency_ms: Math.round((performance.now() - t0) * 100) / 100,
  };
}
