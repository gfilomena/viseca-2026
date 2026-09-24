// Shapes mirror resource/data/schemas/authorization_event.schema.json.

export type Decision = 'approve' | 'decline' | 'step_up';
export type UncertaintyPolicy = 'ask' | 'decline' | 'approve';
export type Operator = '<' | '<=' | '=' | '!=' | '>' | '>=' | 'in' | 'not_in';
export type Currency = 'CHF' | 'EUR' | 'GBP' | 'USD';

export interface HardRule {
  field: string;
  operator: Operator;
  value: number | string | string[];
  currency?: Currency | null;
  scope?: 'purchase' | 'period' | null;
  period_days?: number | null;
}

export interface Merchant {
  merchant_id: string;
  merchant_name: string;
  merchant_category: string;
  merchant_mcc: string;
  merchant_country: string;
  merchant_city: string;
  availability: 'online' | 'store' | 'store_and_online' | 'atm';
  recurring_capable: 'true' | 'false';
}

export interface CartLine {
  line_no: number;
  item_id: string;
  item_name: string;
  item_category: string;
  quantity: number;
  unit_price: number;
  currency: Currency;
  item_details: string;
}

export type TermFlag = 'true' | 'false' | 'unknown' | 'not_applicable';

export interface Authorization {
  authorization_id: string;
  source_authorization_id: string;
  scenario_id: string;
  replay_order: number;
  mandate_id: string;
  profile_id: string;
  card_id: string;
  initiator_type: 'agent';
  merchant: Merchant;
  timestamp: string;
  amount: number;
  currency: Currency;
  billing_amount_chf: number;
  items_subtotal: number;
  delivery_fee: number;
  channel: string;
  customer_device_id: string;
  authority_status: 'active' | 'revoked' | 'expired';
  card_status_at_attempt: 'active' | 'blocked';
  spend_in_period_before_chf: number | null;
  recent_attempt_count_10m: number;
  fulfillment_method: string;
  delivery_by: string | null;
  order_returnable: TermFlag;
  order_cancellable: TermFlag;
  related_authorization_id: string | null;
  related_authorization_status: 'pending' | 'approved' | 'declined' | 'cancelled' | null;
  purchase_description: string;
  items: CartLine[];
}

export interface EventMandate {
  mandate_id: string;
  status: 'active' | 'superseded' | 'revoked' | 'expired';
  customer_id: string;
  card_id: string;
  instruction: string;
  hard_rules: HardRule[];
  uncertainty_policy: UncertaintyPolicy;
  profile_id: string;
}

export interface RecentAuthorization {
  authorization_id: string;
  timestamp: string;
  merchant_id: string;
  billing_amount_chf: number;
  status: 'approved' | 'declined' | 'pending' | 'cancelled';
}

export interface AuthorizationEvent {
  type: 'authorization.request';
  request_id: string;
  deadline_at: string;
  authorization: Authorization;
  mandate: EventMandate;
  context: { approved_spend_in_period_chf: number | null; recent_authorizations: RecentAuthorization[] };
  runtime: { received_at: string; history_window_minutes: number; context_basis: string };
}

/** Outcome of a single check, shown to the customer. */
export type CheckStatus = 'pass' | 'fail' | 'uncertain' | 'info';
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  rule?: HardRule;
}

export interface EngineResult {
  decision: Decision;
  reason_codes: string[];
  customer_message: string;
  checks: Check[];
  evidence: string[];
  latency_ms: number;
}
