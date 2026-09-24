import { randomUUID } from 'node:crypto';
import { getDb, json } from '../db/db.ts';
import { liveEnabled } from '../config.ts';
import type { HardRule, UncertaintyPolicy } from '../domain/types.ts';
import { compileInstruction, describeRule, type RuleExplanation } from '../policy/compiler.ts';
import { api } from '../remote/client.ts';
import { catalogueItems } from './catalog.ts';
import { parsePreferences } from '../engine/preferences.ts';
import { publish } from './bus.ts';

export interface Mandate {
  id: string;
  remote_draft_id: string | null;
  remote_mandate_id: string | null;
  status: 'draft' | 'active' | 'revoked';
  scenario_id: string | null;
  card_id: string | null;
  instruction: string;
  hard_rules: HardRule[];
  uncertainty_policy: UncertaintyPolicy;
  guidance: string[];
  open_questions: string[];
  explanations: RuleExplanation[];
  audit: { at: string; action: string; detail: string }[];
  created_at: string;
  confirmed_at: string | null;
  revoked_at: string | null;
}

export class PolicyError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const pick = (o: any, k: string) => o?.[k] ?? o?.data?.[k] ?? o?.mandate?.[k] ?? o?.data?.mandate?.[k];
const now = () => new Date().toISOString();

function rowToMandate(r: any): Mandate {
  return {
    ...r,
    hard_rules: json(r.hard_rules), guidance: json(r.guidance), open_questions: json(r.open_questions),
    explanations: json(r.explanations), audit: json(r.audit),
  };
}

export function listMandates(): Mandate[] {
  return (getDb().prepare('SELECT * FROM mandates ORDER BY created_at DESC').all() as any[]).map(rowToMandate);
}

export function getMandate(id: string): Mandate {
  const r = getDb().prepare('SELECT * FROM mandates WHERE id = ? OR remote_mandate_id = ?').get(id, id);
  if (!r) throw new PolicyError(`Mandate ${id} not found`, 404);
  return rowToMandate(r);
}

function save(m: Mandate) {
  getDb().prepare(
    `INSERT OR REPLACE INTO mandates (id, remote_draft_id, remote_mandate_id, status, scenario_id, card_id, instruction, hard_rules,
      uncertainty_policy, guidance, open_questions, explanations, audit, created_at, confirmed_at, revoked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(m.id, m.remote_draft_id, m.remote_mandate_id, m.status, m.scenario_id, m.card_id, m.instruction,
    JSON.stringify(m.hard_rules), m.uncertainty_policy, JSON.stringify(m.guidance), JSON.stringify(m.open_questions),
    JSON.stringify(m.explanations), JSON.stringify(m.audit), m.created_at, m.confirmed_at, m.revoked_at);
  publish({ type: 'mandate', mandate_id: m.id });
}

/** Step 1: interpret the customer's words into a reviewable draft (nothing is enforced yet). */
export function createDraft(instruction: string, scenarioId: string | null = null): Mandate {
  if (!instruction?.trim()) throw new PolicyError('Instruction is required');
  const d = compileInstruction(instruction, catalogueItems());
  const card = scenarioId
    ? (getDb().prepare('SELECT a.card_id FROM purchase_attempts p JOIN scenario_authorities a ON a.authority_id = p.authority_id WHERE p.scenario_id = ? LIMIT 1').get(scenarioId) as { card_id: string } | undefined)?.card_id ?? null
    : null;
  const prefs = card
    ? (getDb().prepare('SELECT cu.shopping_preferences AS p FROM cards c JOIN accounts a ON a.account_id = c.account_id JOIN customers cu ON cu.customer_id = a.customer_id WHERE c.card_id = ?').get(card) as { p: string } | undefined)?.p
    : undefined;
  if (prefs && parsePreferences(prefs).length) {
    d.guidance.push(`Your profile preferences (“${prefs}”) are soft signals: a basket that goes against them is treated as uncertain, never declined on that basis alone.`);
  }
  d.guidance.push('Card, account and delegation limits from your bank (card status and expiry, online/abroad switches, per-payment and monthly account limits, delegation window) always apply.');
  const m: Mandate = {
    id: `LM-${randomUUID().slice(0, 8)}`, remote_draft_id: null, remote_mandate_id: null, status: 'draft',
    scenario_id: scenarioId, card_id: card, instruction: d.instruction, hard_rules: d.hard_rules,
    uncertainty_policy: d.uncertainty_policy, guidance: d.guidance, open_questions: d.open_questions,
    explanations: d.explanations, audit: [{ at: now(), action: 'drafted', detail: `${d.hard_rules.length} checks interpreted from the instruction` }],
    created_at: now(), confirmed_at: null, revoked_at: null,
  };
  save(m);
  return m;
}

/** While still a draft, the customer may freely edit the interpreted checks. */
export function editDraft(id: string, patch: { hard_rules?: HardRule[]; uncertainty_policy?: UncertaintyPolicy }): Mandate {
  const m = getMandate(id);
  if (m.status !== 'draft') throw new PolicyError('Only drafts can be edited freely; active policies can only be tightened.', 409);
  if (patch.hard_rules) {
    validateRules(patch.hard_rules);
    m.hard_rules = patch.hard_rules;
    m.explanations = patch.hard_rules.map((rule) => m.explanations.find((e) => JSON.stringify(e.rule) === JSON.stringify(rule)) ?? { rule, text: describeRule(rule), source: 'edited by customer' });
  }
  if (patch.uncertainty_policy) m.uncertainty_policy = patch.uncertainty_policy;
  m.audit.push({ at: now(), action: 'edited', detail: 'Draft edited by customer' });
  save(m);
  return m;
}

/** Step 2: the customer agrees. Mirrors the policy to the hosted API when a team key is configured. */
export async function confirmDraft(id: string): Promise<Mandate> {
  const m = getMandate(id);
  if (m.status !== 'draft') throw new PolicyError(`Mandate is ${m.status}`, 409);
  if (liveEnabled()) {
    const created = await api('/v1/mandates', {
      method: 'POST',
      body: { instruction: m.instruction, hard_rules: m.hard_rules.map(stripNulls), uncertainty_policy: m.uncertainty_policy, guidance: m.guidance, open_questions: m.open_questions },
    });
    m.remote_draft_id = pick(created.data, 'draft_id');
    const confirmed = await api(`/v1/mandates/${m.remote_draft_id}/confirm`, { method: 'POST', body: { confirmed: true } });
    m.remote_mandate_id = pick(confirmed.data, 'mandate_id');
  }
  m.status = 'active';
  m.confirmed_at = now();
  m.audit.push({ at: now(), action: 'confirmed', detail: m.remote_mandate_id ? `Active as ${m.remote_mandate_id}` : 'Active (local)' });
  save(m);
  return m;
}

/**
 * Tighten an active policy. Rules are combined with AND, so adding a rule can only
 * restrict further; existing rules are never removed or replaced. The uncertainty
 * policy may only move towards "decline".
 */
export async function tighten(id: string, patch: { add_rules?: HardRule[]; uncertainty_policy?: UncertaintyPolicy }): Promise<Mandate> {
  const m = getMandate(id);
  if (m.status !== 'active') throw new PolicyError(`Only active policies can be tightened (this one is ${m.status}).`, 409);
  const add = patch.add_rules ?? [];
  validateRules(add);
  if (patch.uncertainty_policy && patch.uncertainty_policy !== m.uncertainty_policy && patch.uncertainty_policy !== 'decline') {
    throw new PolicyError('The uncertainty policy can only be tightened to "decline".');
  }
  const body: Record<string, unknown> = {};
  if (add.length) body.hard_rules = [...m.hard_rules, ...add].map(stripNulls);
  if (patch.uncertainty_policy && patch.uncertainty_policy !== m.uncertainty_policy) body.uncertainty_policy = patch.uncertainty_policy;
  if (!Object.keys(body).length) return m;
  if (liveEnabled() && m.remote_mandate_id) await api(`/v1/mandates/${m.remote_mandate_id}`, { method: 'PATCH', body });
  m.hard_rules = [...m.hard_rules, ...add];
  m.explanations = [...m.explanations, ...add.map((rule) => ({ rule, text: describeRule(rule), source: 'added by customer' }))];
  if (body.uncertainty_policy) m.uncertainty_policy = body.uncertainty_policy as UncertaintyPolicy;
  m.audit.push({ at: now(), action: 'tightened', detail: [add.length ? `${add.length} rule(s) added` : '', body.uncertainty_policy ? `uncertainty → ${body.uncertainty_policy}` : ''].filter(Boolean).join(', ') + ' (applies to new runs)' });
  save(m);
  return m;
}

export async function revoke(id: string): Promise<Mandate> {
  const m = getMandate(id);
  if (m.status === 'revoked') return m;
  if (liveEnabled() && m.remote_mandate_id) await api(`/v1/mandates/${m.remote_mandate_id}`, { method: 'DELETE' });
  m.status = 'revoked';
  m.revoked_at = now();
  m.audit.push({ at: now(), action: 'revoked', detail: 'Permission withdrawn by the customer' });
  save(m);
  return m;
}

const OPS = new Set(['<', '<=', '=', '!=', '>', '>=', 'in', 'not_in']);
function validateRules(rules: HardRule[]) {
  for (const r of rules) {
    if (!r || typeof r.field !== 'string' || !r.field) throw new PolicyError('Each rule needs a field');
    if (!OPS.has(r.operator)) throw new PolicyError(`Invalid operator ${r.operator}`);
    const v = r.value as unknown;
    const ok = typeof v === 'number' || typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) throw new PolicyError(`Invalid value for ${r.field}`);
    if (r.period_days != null && (!Number.isInteger(r.period_days) || r.period_days < 1)) throw new PolicyError('period_days must be a whole number ≥ 1');
  }
}

/** The API wants unused optional fields omitted rather than null. */
function stripNulls(r: HardRule): HardRule {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined)) as unknown as HardRule;
}
