import { randomUUID } from 'node:crypto';
import { getDb } from '../db/db.ts';
import type { AuthorizationEvent, EventMandate } from '../domain/types.ts';
import { roundHalfEven } from '../domain/money.ts';
import { currencyFor, interpretRequest, shopOptions, type InterpretedRequest, type PurchaseOffer, type ShopOptions } from '../agent/shopping-agent.ts';
import { fxRates } from './catalog.ts';
import { getMandate, PolicyError, type Mandate } from './mandates.ts';
import { getRun, insertRun, withDeliveryContext, type Run } from './runs.ts';
import { approvalImpact, recordDecision, type DecisionRecord } from './decisions.ts';

/**
 * Sandbox shopping: the customer chats with a simulated agent, reviews its proposed
 * purchase and lets it try to buy. Each attempt becomes a schema-conformant
 * authorization event judged by the same engine as scenario and live runs, against
 * the wallet policy *as currently confirmed* (tightening applies immediately here).
 */

function activeMandateWithCard(mandateId: string): Mandate & { card_id: string } {
  const m = getMandate(mandateId);
  if (m.status !== 'active') {
    throw new PolicyError(m.status === 'revoked' ? 'This wallet policy was revoked, so the agent may not buy anything with it.'
      : m.status === 'superseded' ? 'This wallet policy was replaced by a newer one.' : 'Confirm the wallet policy first.', 409);
  }
  if (!m.card_id) throw new PolicyError('This policy is not linked to a card. Create it from one of the example customers.', 409);
  return m as Mandate & { card_id: string };
}

export function sandboxOptions(mandateId: string): ShopOptions {
  return shopOptions(getDb(), activeMandateWithCard(mandateId).card_id);
}

export function interpretForMandate(mandateId: string, text: string): InterpretedRequest {
  if (!text?.trim()) throw new PolicyError('Tell the agent what to buy.');
  return interpretRequest(getDb(), activeMandateWithCard(mandateId).card_id, text.trim());
}

function sandboxRun(m: Mandate & { card_id: string }, snapshot: EventMandate): Run {
  const row = getDb().prepare("SELECT id FROM runs WHERE mode = 'sandbox' AND mandate_id = ?").get(m.id) as { id: string } | undefined;
  if (row) return getRun(row.id);
  insertRun({
    id: `SBX-${randomUUID().slice(0, 8)}`, mode: 'sandbox', scenario_id: m.scenario_id ?? 'SCEN0000', mandate_id: m.id,
    mandate_snapshot: snapshot, remote_run_id: null, status: 'running', created_at: new Date().toISOString(), error: null,
  });
  return sandboxRun(m, snapshot);
}

export function buildSandboxEvent(offer: PurchaseOffer, m: Mandate & { card_id: string }, snapshot: EventMandate, run: Run, now = new Date()): AuthorizationEvent {
  const db = getDb();
  if (!offer.item_id) throw new PolicyError('Pick a product.');
  if (!offer.merchant_id) throw new PolicyError('Pick a shop.');
  const qty = Math.trunc(Number(offer.quantity));
  const unitChf = Number(offer.unit_price_chf);
  const deliveryChf = Number(offer.delivery_fee_chf ?? 0);
  if (!(qty >= 1 && qty <= 99)) throw new PolicyError('Quantity must be between 1 and 99.');
  if (!(unitChf > 0)) throw new PolicyError('The price must be above zero.');
  if (!(deliveryChf >= 0)) throw new PolicyError('The delivery fee cannot be negative.');

  const item = db.prepare('SELECT item_id, item_name, item_category FROM items WHERE item_id = ?').get(offer.item_id) as { item_id: string; item_name: string; item_category: string } | undefined;
  const merchant = db.prepare('SELECT * FROM merchants WHERE merchant_id = ?').get(offer.merchant_id) as any;
  if (!item) throw new PolicyError(`Unknown product ${offer.item_id}`);
  if (!merchant) throw new PolicyError(`Unknown shop ${offer.merchant_id}`);

  // The shop charges in its local currency; billing is converted back at the fixed rate.
  const fx = fxRates();
  const currency = currencyFor(merchant.merchant_country);
  const unitPrice = roundHalfEven(unitChf / fx[currency]);
  const delivery = roundHalfEven(deliveryChf / fx[currency]);
  const subtotal = roundHalfEven(unitPrice * qty);
  const amount = roundHalfEven(subtotal + delivery);
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prior = getDb().prepare('SELECT sim_timestamp FROM decisions WHERE run_id = ?').all(run.id) as { sim_timestamp: string }[];
  const t = now.getTime();
  const id = `SBX-${randomUUID().slice(0, 12)}`;

  const event: AuthorizationEvent = {
    type: 'authorization.request',
    request_id: `req-${id}`,
    deadline_at: '',
    authorization: {
      authorization_id: id,
      source_authorization_id: id,
      scenario_id: run.scenario_id,
      replay_order: prior.length + 1,
      mandate_id: m.remote_mandate_id ?? m.id,
      profile_id: 'SANDBOX',
      card_id: m.card_id,
      initiator_type: 'agent',
      merchant: {
        merchant_id: merchant.merchant_id, merchant_name: merchant.merchant_name, merchant_category: merchant.merchant_category,
        merchant_mcc: String(merchant.merchant_mcc), merchant_country: merchant.merchant_country, merchant_city: merchant.merchant_city,
        availability: merchant.availability, recurring_capable: merchant.recurring_capable,
      },
      timestamp,
      amount,
      currency,
      billing_amount_chf: roundHalfEven(amount * fx[currency]),
      items_subtotal: subtotal,
      delivery_fee: delivery,
      channel: 'ecommerce',
      customer_device_id: offer.customer_device_id || 'DVC-NEW-SANDBOX',
      authority_status: 'active',
      card_status_at_attempt: 'active',
      spend_in_period_before_chf: null,
      recent_attempt_count_10m: prior.filter((p) => { const pt = Date.parse(p.sim_timestamp); return pt < t && pt >= t - 10 * 60_000; }).length,
      fulfillment_method: offer.fulfillment_method || 'delivery',
      delivery_by: null,
      order_returnable: offer.order_returnable || 'unknown',
      order_cancellable: 'unknown',
      related_authorization_id: null,
      related_authorization_status: null,
      purchase_description: `${item.item_name} order`,
      items: [{
        line_no: 1, item_id: item.item_id, item_name: item.item_name, item_category: item.item_category,
        quantity: qty, unit_price: unitPrice, currency, item_details: String(offer.item_details ?? '').slice(0, 2000),
      }],
    },
    mandate: snapshot,
    context: { approved_spend_in_period_chf: null, recent_authorizations: [] },
    runtime: { received_at: '', history_window_minutes: 10, context_basis: 'run_decisions_and_scenario_timestamps' },
  };
  return withDeliveryContext(event, run.id);
}

function currentCustomer(cardId: string): string {
  const r = getDb().prepare('SELECT a.customer_id FROM cards c JOIN accounts a ON a.account_id = c.account_id WHERE c.card_id = ?').get(cardId) as { customer_id: string } | undefined;
  return r?.customer_id ?? 'UNKNOWN';
}

/** The agent submits the reviewed offer; wallet control decides. */
export function tryToBuy(mandateId: string, offer: PurchaseOffer): DecisionRecord & { impact: ReturnType<typeof approvalImpact> } {
  const m = activeMandateWithCard(mandateId);
  const snapshot: EventMandate = {
    mandate_id: m.remote_mandate_id ?? m.id, status: 'active', customer_id: currentCustomer(m.card_id), card_id: m.card_id,
    instruction: m.instruction, hard_rules: m.hard_rules, uncertainty_policy: m.uncertainty_policy, profile_id: 'SANDBOX',
  };
  const run = sandboxRun(m, snapshot);
  const { record } = recordDecision(buildSandboxEvent(offer, m, snapshot, run), run.id);
  return { ...record, impact: record.status === 'pending' ? approvalImpact(record) : [] };
}
