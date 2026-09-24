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
  status: 'draft' | 'active' | 'revoked';
  scenario_id: string | null;
  card_id: string | null;
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
  impact?: { rule: string; limit_chf: number; total_if_approved_chf: number; breaches: boolean }[];
  event?: { authorization: { items: CartLine[]; merchant: { merchant_name: string; merchant_city: string; merchant_country: string; merchant_category: string; merchant_mcc: string }; customer_device_id: string; delivery_fee: number; currency: string; amount: number; order_returnable: string; fulfillment_method: string; recent_attempt_count_10m: number } };
}

export interface PackReport { ok: boolean; verified_at: string; pack_version: string | null; errors: string[]; warnings: string[]; checks: { name: string; ok: boolean; detail: string }[] }

export interface Health { ok: boolean; engine: string; live: boolean; pack: PackReport | null; worker: { running: boolean; lastError: string | null; handled: number }; data: Record<string, number> }

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
