export type Decision = 'approve' | 'decline' | 'step_up';
export type UncertaintyPolicy = 'ask' | 'decline' | 'approve';
export type DecisionStatus = 'approved' | 'declined' | 'pending' | 'expired';

export interface HardRule {
  field: string;
  operator: '<' | '<=' | '=' | '!=' | '>' | '>=' | 'in' | 'not_in';
  value: number | string | string[];
  currency?: string | null;
  scope?: 'purchase' | 'period' | null;
  period_days?: number | null;
}

export interface RuleExplanation { rule: HardRule; text: string; source: string }

export interface Mandate {
  id: string;
  remote_mandate_id: string | null;
  status: 'draft' | 'active' | 'revoked' | 'superseded';
  scenario_id: string | null;
  card_id: string | null;
  customer_id?: string | null;
  persona_name?: string | null;
  instruction: string;
  hard_rules: HardRule[];
  rule_labels?: string[];
  uncertainty_policy: UncertaintyPolicy;
  guidance: string[];
  open_questions: string[];
  explanations: RuleExplanation[];
  audit: { at: string; action: string; detail: string }[];
  created_at: string;
  confirmed_at: string | null;
  revoked_at: string | null;
}

export interface Scenario {
  scenario_id: string;
  scenario_name: string;
  cardholder_instruction: string;
  control_theme: string;
  event_count: number;
  customer_id: string;
  card_id: string;
  persona_name: string;
}

export interface Run {
  id: string;
  mode: 'offline' | 'live';
  scenario_id: string;
  mandate_id: string;
  remote_run_id: string | null;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
  error: string | null;
  counts?: Partial<Record<DecisionStatus, number>>;
}

export interface Check { id: string; label: string; status: 'pass' | 'fail' | 'uncertain' | 'info'; detail: string; rule?: HardRule }

export interface CartLine { line_no: number; item_id: string; item_name: string; item_category: string; quantity: number; unit_price: number; currency: string; item_details: string }

export interface DecisionRow {
  authorization_id: string;
  run_id: string;
  source_authorization_id: string;
  replay_order: number;
  sim_timestamp: string;
  merchant_id: string;
  merchant_name: string;
  merchant_category?: string;
  billing_amount_chf: number;
  amount?: number;
  currency?: string;
  items?: string[];
  engine_decision: Decision;
  status: DecisionStatus;
  reason_codes: string[];
  customer_message: string;
  checks: Check[];
  evidence: string[];
  latency_ms: number;
  remote_submitted: number;
  remote_error: string | null;
  human_deadline_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  run_mode?: 'offline' | 'live' | 'sandbox';
  scenario_id?: string;
  impact?: { rule: string; limit_chf: number; total_if_approved_chf: number; breaches: boolean }[];
  event?: { authorization: { items: CartLine[]; merchant: { merchant_name: string; merchant_city: string; merchant_country: string; merchant_category: string; merchant_mcc: string }; customer_device_id: string; delivery_fee: number; currency: string; amount: number; order_returnable: string; fulfillment_method: string; recent_attempt_count_10m: number } };
}

export interface PackReport { ok: boolean; verified_at: string; pack_version: string | null; errors: string[]; warnings: string[]; checks: { name: string; ok: boolean; detail: string }[] }

export interface PlatformState {
  checked_at: string | null; reachable: boolean | null; live: boolean; bootstrap_ok: boolean | null;
  human_window_seconds: number; human_window_source: 'default' | 'bootstrap';
  decision_deadline_seconds: number; decision_deadline_source: 'default' | 'bootstrap';
  reset_enabled: boolean | null;
  local_pack_version: string | null; remote_pack_version: string | null; pack_match: boolean | null; error: string | null;
}

export interface Health { ok: boolean; engine: string; live: boolean; pack: PackReport | null; platform?: PlatformState; policy_llm?: { enabled: boolean; model: string }; worker: { running: boolean; lastError: string | null; handled: number }; data: Record<string, number> }

export interface CardProfile {
  card: Record<string, string | number>;
  merchants: { merchant_id: string; merchant_name: string; approved_purchases: number }[];
  devices: Record<string, number>;
  countries: string[];
  amount_p95_chf: number;
  purchases: number;
  authorities: { authority_id: string; valid_from: string; valid_until: string; initial_status: string }[];
  monthly_spend: Record<string, number>;
  preferences: { phrase: string; kind: 'avoid' | 'expect'; type: string }[];
}

export interface OfferItem { item_id: string; item_name: string; item_category: string; typical_chf: number; min_chf: number; max_chf: number }
export interface OfferMerchant { merchant_id: string; merchant_name: string; merchant_category: string; merchant_country: string; merchant_city: string; familiar_purchases: number }

export interface PurchaseOffer {
  request_text: string;
  item_id: string | null;
  /** Always populated once a product is recognised, catalogued or not. */
  item_name: string | null;
  item_category: string | null;
  quantity: number;
  unit_price_chf: number | null;
  budget_chf: number | null;
  merchant_id: string | null;
  size: string | null;
  customer_device_id: string;
  item_details: string;
  order_returnable: 'true' | 'false' | 'unknown' | 'not_applicable';
  delivery_fee_chf: number;
  fulfillment_method: 'delivery' | 'digital' | 'pickup';
}

export interface InterpretedRequest {
  offer: PurchaseOffer;
  item: OfferItem | null;
  merchant: OfferMerchant | null;
  item_candidates: OfferItem[];
  notes: string[];
  questions: string[];
}

export interface ShopOptions { items: OfferItem[]; merchants: OfferMerchant[]; devices: { id: string; label: string }[] }
