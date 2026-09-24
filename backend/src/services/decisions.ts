import { getDb, json } from '../db/db.ts';
import { config } from '../config.ts';
import type { AuthorizationEvent, Check, Decision, EngineResult } from '../domain/types.ts';
import { evaluate, itemSignature, type PriorDecision } from '../engine/engine.ts';
import { getCardProfile } from '../engine/profile.ts';
import { cataloguePrices, fxRates, intentsFor } from './catalog.ts';
import { publish } from './bus.ts';

export type DecisionStatus = 'approved' | 'declined' | 'pending' | 'expired';

export interface DecisionRecord {
  authorization_id: string;
  run_id: string;
  source_authorization_id: string;
  replay_order: number;
  sim_timestamp: string;
  card_id: string;
  merchant_id: string;
  merchant_name: string;
  customer_device_id: string | null;
  billing_amount_chf: number;
  item_signature: string;
  event: AuthorizationEvent;
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
}

const toRecord = (r: any): DecisionRecord => ({
  ...r, event: json(r.event), reason_codes: json(r.reason_codes), checks: json(r.checks), evidence: json(r.evidence),
});

export function getDecision(authorizationId: string): DecisionRecord | undefined {
  const r = getDb().prepare('SELECT * FROM decisions WHERE authorization_id = ?').get(authorizationId);
  return r ? toRecord(r) : undefined;
}

export function listDecisions(filter: { run_id?: string; status?: string } = {}): DecisionRecord[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.run_id) { where.push('run_id = ?'); args.push(filter.run_id); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const sql = `SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`;
  return (getDb().prepare(sql).all(...args) as any[]).map(toRecord);
}

export function priorDecisions(runId: string, beforeSim: string, excludeId: string): PriorDecision[] {
  return getDb().prepare(
    `SELECT authorization_id, sim_timestamp, merchant_id, billing_amount_chf, item_signature, customer_device_id, status
       FROM decisions WHERE run_id = ? AND authorization_id != ? AND sim_timestamp <= ?
        AND remote_error IS NULL -- a live answer the platform never received does not count as spend
      ORDER BY sim_timestamp`,
  ).all(runId, excludeId, beforeSim) as unknown as PriorDecision[];
}

/** Pure evaluation using stored run state. Never throws on odd input: falls back to a safe step_up/decline. */
export function decide(event: AuthorizationEvent, runId: string): EngineResult {
  try {
    const a = event.authorization;
    const mode = (getDb().prepare('SELECT mode FROM runs WHERE id = ?').get(runId) as { mode: string } | undefined)?.mode;
    const base = getCardProfile(getDb(), a.card_id);
    return evaluate({
      event,
      // Sandbox purchases are delegated by the confirmed wallet policy itself; the scenario
      // fixture authorities only describe the replay windows of the public scenarios.
      profile: mode === 'sandbox' ? { ...base, authorities: [] } : base,
      delegation: mode === 'sandbox' ? 'wallet policy (sandbox)' : undefined,
      prior: priorDecisions(runId, a.timestamp, a.authorization_id),
      fx: fxRates(),
      catalogue: cataloguePrices(),
      intents: intentsFor(event.mandate.instruction),
    });
  } catch (e) {
    const fallback: Decision = event?.mandate?.uncertainty_policy === 'approve' ? 'decline' : event?.mandate?.uncertainty_policy === 'decline' ? 'decline' : 'step_up';
    return {
      decision: fallback,
      reason_codes: ['engine_error_safe_fallback'],
      customer_message: 'We could not fully evaluate this purchase, so it was not approved automatically.',
      checks: [{ id: 'engine', label: 'Engine', status: 'uncertain', detail: String((e as Error).message) }],
      evidence: [],
      latency_ms: 0,
    };
  }
}

/** Idempotent: a repeated delivery of the same live authorization returns the saved result. */
export function recordDecision(event: AuthorizationEvent, runId: string): { record: DecisionRecord; duplicateDelivery: boolean } {
  const a = event.authorization;
  const existing = getDecision(a.authorization_id);
  if (existing) return { record: existing, duplicateDelivery: true };

  const result = decide(event, runId);
  const status: DecisionStatus = result.decision === 'approve' ? 'approved' : result.decision === 'decline' ? 'declined' : 'pending';
  const createdAt = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO decisions (authorization_id, run_id, source_authorization_id, replay_order, sim_timestamp, card_id, merchant_id, merchant_name,
      customer_device_id, billing_amount_chf, item_signature, event, engine_decision, status, reason_codes, customer_message, checks, evidence,
      latency_ms, human_deadline_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    a.authorization_id, runId, a.source_authorization_id, a.replay_order, a.timestamp, a.card_id, a.merchant.merchant_id, a.merchant.merchant_name,
    a.customer_device_id, a.billing_amount_chf, itemSignature(event), JSON.stringify(event), result.decision, status,
    JSON.stringify(result.reason_codes), result.customer_message, JSON.stringify(result.checks), JSON.stringify(result.evidence),
    result.latency_ms, status === 'pending' ? new Date(Date.now() + config.humanWindowSeconds * 1000).toISOString() : null, createdAt,
  );
  publish({ type: 'decision', authorization_id: a.authorization_id, run_id: runId });
  return { record: getDecision(a.authorization_id)!, duplicateDelivery: false };
}

export function markRemote(authorizationId: string, ok: boolean, error?: string) {
  getDb().prepare('UPDATE decisions SET remote_submitted = ?, remote_error = ? WHERE authorization_id = ?').run(ok ? 1 : 0, error ?? null, authorizationId);
  const d = getDecision(authorizationId);
  if (d) publish({ type: 'decision', authorization_id: authorizationId, run_id: d.run_id });
}

export function setResolution(authorizationId: string, status: DecisionStatus, by: string, note: string) {
  getDb().prepare('UPDATE decisions SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE authorization_id = ?')
    .run(status, by, new Date().toISOString(), note, authorizationId);
  const d = getDecision(authorizationId)!;
  publish({ type: 'decision', authorization_id: authorizationId, run_id: d.run_id });
  return d;
}

export function engineResultOf(d: DecisionRecord) {
  return { decision: d.engine_decision, reason_codes: d.reason_codes, customer_message: d.customer_message, evidence: d.evidence };
}

export interface ApprovalImpact { rule: string; limit_chf: number; total_if_approved_chf: number; breaches: boolean }

/**
 * What approving a paused purchase *now* would do to rolling limits, given
 * everything approved since. Shown to the customer before they answer.
 */
export function approvalImpact(d: DecisionRecord): ApprovalImpact[] {
  const fx: Record<string, number> = fxRates();
  const t = Date.parse(d.sim_timestamp);
  const approved = listDecisions({ run_id: d.run_id }).filter((x) => x.status === 'approved' && !x.remote_error && x.authorization_id !== d.authorization_id);
  return d.event.mandate.hard_rules
    .filter((r) => r.field === 'authorization.billing_amount_chf' && r.scope === 'period' && typeof r.value === 'number')
    .map((r) => {
      const days = (r.period_days ?? 30) * 86_400_000;
      const limit = Math.round((r.value as number) * (fx[r.currency ?? 'CHF'] ?? 1) * 100) / 100;
      // Every window that would contain this purchase ends at t or at a later approved purchase within `days`.
      const anchors = [t, ...approved.map((x) => Date.parse(x.sim_timestamp)).filter((s) => s >= t && s < t + days)];
      const worst = Math.max(...anchors.map((s) =>
        approved.filter((x) => { const xt = Date.parse(x.sim_timestamp); return xt > s - days && xt <= s; }).reduce((sum, x) => sum + x.billing_amount_chf, 0) + d.billing_amount_chf));
      const total = Math.round(worst * 100) / 100;
      return { rule: `${r.period_days}-day limit`, limit_chf: limit, total_if_approved_chf: total, breaches: !(r.operator === '<' ? total < limit : total <= limit) };
    });
}
