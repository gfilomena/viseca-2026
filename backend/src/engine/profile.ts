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

  const p: CardProfile = {
    card_id: cardId,
    customer_id: rows[0]?.customer_id ?? null,
    merchantCounts: new Map(),
    merchantNames: new Map(),
    deviceCounts: new Map(),
    countries: new Set(),
    amountP95: 0,
    purchaseCount: rows.length,
    lastApprovedAt: rows.at(-1)?.timestamp ?? null,
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
