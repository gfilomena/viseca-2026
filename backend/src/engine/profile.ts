import type { DatabaseSync } from 'node:sqlite';

/**
 * Behavioural baseline of one card, built from approved historical rows
 * (authorization_history.csv). Cached in memory so decisions stay fast.
 */
export interface CardProfile {
  card_id: string;
  customer_id: string | null;
  merchantCounts: Map<string, number>;       // merchant_id -> approved purchases
  merchantNames: Map<string, string>;        // merchant_id -> name (familiar merchants)
  deviceCounts: Map<string, number>;         // device -> approved rows
  countries: Set<string>;
  amountP95: number;
  purchaseCount: number;
  lastApprovedAt: string | null;
  /** cards.csv — the card as it stands today. */
  card: { status: string; first_used_on: string | null; expires_on: string | null; online_enabled: boolean; international_enabled: boolean; virtual_card: boolean } | null;
  /** accounts.csv — issuer limits and account status. */
  account: { account_id: string; status: string; per_transaction_limit_chf: number | null; monthly_limit_chf: number | null } | null;
  /** customers.csv — stated preferences, used only as soft signals. */
  customer: { customer_id: string; persona_name: string; shopping_preferences: string } | null;
  /** scenario_authorities.csv — delegation windows for this card. */
  authorities: { authority_id: string; valid_from: string; valid_until: string; initial_status: string }[];
  /** Approved historical spend on the whole account (all its cards; refunds net off) per calendar month "YYYY-MM". */
  monthlySpend: Map<string, number>;
}

const cache = new Map<string, CardProfile>();

export function getCardProfile(db: DatabaseSync, cardId: string): CardProfile {
  const hit = cache.get(cardId);
  if (hit) return hit;
  const rows = db.prepare(
    `SELECT customer_id, merchant_id, merchant_name, merchant_country, customer_device_id, billing_amount_chf, timestamp
       FROM authorization_history
      WHERE card_id = ? AND status = 'approved' AND transaction_type = 'purchase'
      ORDER BY timestamp`,
  ).all(cardId) as { customer_id: string; merchant_id: string; merchant_name: string; merchant_country: string; customer_device_id: string | null; billing_amount_chf: number; timestamp: string }[];

  const card = db.prepare('SELECT * FROM cards WHERE card_id = ?').get(cardId) as any;
  const account = card ? db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(card.account_id) as any : undefined;
  const customer = account ? db.prepare('SELECT customer_id, persona_name, shopping_preferences FROM customers WHERE customer_id = ?').get(account.customer_id) as any : undefined;
  const authorities = db.prepare('SELECT authority_id, valid_from, valid_until, initial_status FROM scenario_authorities WHERE card_id = ?').all(cardId) as any[];
  const monthly = db.prepare(
    `SELECT substr(timestamp, 1, 7) AS month, SUM(billing_amount_chf) AS spend FROM authorization_history
      WHERE account_id = ? AND status = 'approved' GROUP BY month`,
  ).all(card?.account_id ?? '') as { month: string; spend: number }[];
  const bool = (v: unknown) => String(v) === 'true';

  const p: CardProfile = {
    card_id: cardId,
    customer_id: rows[0]?.customer_id ?? account?.customer_id ?? null,
    merchantCounts: new Map(),
    merchantNames: new Map(),
    deviceCounts: new Map(),
    countries: new Set(),
    amountP95: 0,
    purchaseCount: rows.length,
    lastApprovedAt: rows.at(-1)?.timestamp ?? null,
    card: card ? {
      status: card.status, first_used_on: card.first_used_on, expires_on: card.expires_on,
      online_enabled: bool(card.online_enabled), international_enabled: bool(card.international_enabled), virtual_card: bool(card.virtual_card),
    } : null,
    account: account ? { account_id: account.account_id, status: account.status, per_transaction_limit_chf: account.per_transaction_limit_chf, monthly_limit_chf: account.monthly_limit_chf } : null,
    customer: customer ?? null,
    authorities,
    monthlySpend: new Map(monthly.map((m) => [m.month, m.spend])),
  };
  for (const r of rows) {
    p.merchantCounts.set(r.merchant_id, (p.merchantCounts.get(r.merchant_id) ?? 0) + 1);
    p.merchantNames.set(r.merchant_id, r.merchant_name);
    if (r.customer_device_id) p.deviceCounts.set(r.customer_device_id, (p.deviceCounts.get(r.customer_device_id) ?? 0) + 1);
    p.countries.add(r.merchant_country);
  }
  const amounts = rows.map((r) => r.billing_amount_chf).sort((a, b) => a - b);
  p.amountP95 = amounts.length ? amounts[Math.floor(0.95 * (amounts.length - 1))] : 0;
  cache.set(cardId, p);
  return p;
}

export function clearProfileCache() { cache.clear(); }
