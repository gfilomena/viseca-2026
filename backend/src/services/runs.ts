import { randomUUID } from 'node:crypto';
import { getDb, json } from '../db/db.ts';
import { liveEnabled } from '../config.ts';
import type { AuthorizationEvent, EventMandate } from '../domain/types.ts';
import { api } from '../remote/client.ts';
import { publish } from './bus.ts';
import { getDecision, listDecisions, recordDecision, setResolution, markRemote, type DecisionRecord } from './decisions.ts';
import { getMandate, PolicyError } from './mandates.ts';

export interface Run {
  id: string;
  mode: 'offline' | 'live' | 'sandbox';
  scenario_id: string;
  mandate_id: string;
  mandate_snapshot: EventMandate;
  remote_run_id: string | null;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
  error: string | null;
}

const toRun = (r: any): Run => ({ ...r, mandate_snapshot: json(r.mandate_snapshot) });

export function listRuns(): (Run & { counts: Record<string, number> })[] {
  const runs = (getDb().prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as any[]).map(toRun);
  const counts = getDb().prepare('SELECT run_id, status, COUNT(*) AS n FROM decisions GROUP BY run_id, status').all() as { run_id: string; status: string; n: number }[];
  return runs.map((r) => ({ ...r, counts: Object.fromEntries(counts.filter((c) => c.run_id === r.id).map((c) => [c.status, c.n])) }));
}

export function getRun(id: string): Run {
  const r = getDb().prepare('SELECT * FROM runs WHERE id = ? OR remote_run_id = ?').get(id, id);
  if (!r) throw new PolicyError(`Run ${id} not found`, 404);
  return toRun(r);
}

function insertRun(run: Run) {
  getDb().prepare('INSERT INTO runs (id, mode, scenario_id, mandate_id, mandate_snapshot, remote_run_id, status, created_at, error) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(run.id, run.mode, run.scenario_id, run.mandate_id, JSON.stringify(run.mandate_snapshot), run.remote_run_id, run.status, run.created_at, run.error);
  publish({ type: 'run', run_id: run.id });
}

export { insertRun };

export function setRunStatus(id: string, status: Run['status'], error: string | null = null) {
  getDb().prepare('UPDATE runs SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  publish({ type: 'run', run_id: id });
}

/**
 * Records a hosted run started from this app. The worker may already have seen its
 * first event and created the record (the poll can return before the POST does);
 * in that case adopt that record so decisions and the UI point at the same run.
 */
export function registerLiveRun(remoteRunId: string, run: Run): Run {
  const existing = getDb().prepare('SELECT * FROM runs WHERE remote_run_id = ?').get(remoteRunId);
  if (existing) {
    getDb().prepare('UPDATE runs SET mandate_id = ?, scenario_id = ? WHERE remote_run_id = ?').run(run.mandate_id, run.scenario_id, remoteRunId);
    publish({ type: 'run', run_id: (existing as any).id });
    return getRun(remoteRunId);
  }
  insertRun({ ...run, remote_run_id: remoteRunId });
  return getRun(remoteRunId);
}

/** Live runs discovered from the poll envelope (e.g. started outside this app). */
export function ensureLiveRun(remoteRunId: string, event: AuthorizationEvent): Run {
  const existing = getDb().prepare('SELECT * FROM runs WHERE remote_run_id = ?').get(remoteRunId);
  if (existing) return toRun(existing);
  const run: Run = {
    id: `RUN-${randomUUID().slice(0, 8)}`, mode: 'live', scenario_id: event.authorization.scenario_id, mandate_id: event.mandate.mandate_id,
    mandate_snapshot: event.mandate, remote_run_id: remoteRunId, status: 'running', created_at: new Date().toISOString(), error: null,
  };
  insertRun(run);
  return run;
}

// ---------------------------------------------------------------------------
// Offline replay: build schema-conformant events from the CSV data pack.
// ---------------------------------------------------------------------------

function buildOfflineEvents(scenarioId: string, run: Run): AuthorizationEvent[] {
  const db = getDb();
  const attempts = db.prepare('SELECT * FROM purchase_attempts WHERE scenario_id = ? ORDER BY replay_order').all(scenarioId) as any[];
  if (!attempts.length) throw new PolicyError(`Scenario ${scenarioId} has no purchase attempts`, 404);
  const liveId = (src: string) => `${run.id}-${src}`;
  return attempts.map((p) => {
    const m = db.prepare('SELECT * FROM merchants WHERE merchant_id = ?').get(p.merchant_id) as any;
    const items = db.prepare('SELECT * FROM purchase_attempt_items WHERE authorization_id = ? ORDER BY line_no').all(p.authorization_id) as any[];
    return {
      type: 'authorization.request',
      request_id: `req-${liveId(p.authorization_id)}`,
      deadline_at: '', // assigned when delivered
      authorization: {
        authorization_id: liveId(p.authorization_id),
        source_authorization_id: p.authorization_id,
        scenario_id: p.scenario_id,
        replay_order: p.replay_order,
        mandate_id: run.mandate_snapshot.mandate_id,
        profile_id: run.mandate_snapshot.profile_id,
        card_id: p.card_id,
        initiator_type: 'agent',
        merchant: {
          merchant_id: m.merchant_id, merchant_name: m.merchant_name, merchant_category: m.merchant_category, merchant_mcc: String(m.merchant_mcc),
          merchant_country: m.merchant_country, merchant_city: m.merchant_city, availability: m.availability, recurring_capable: m.recurring_capable,
        },
        timestamp: p.timestamp,
        amount: p.amount, currency: p.currency, billing_amount_chf: p.billing_amount_chf, items_subtotal: p.items_subtotal, delivery_fee: p.delivery_fee,
        channel: p.channel, customer_device_id: p.customer_device_id, authority_status: p.authority_status, card_status_at_attempt: p.card_status_at_attempt,
        spend_in_period_before_chf: p.spend_in_period_before_chf ?? null, recent_attempt_count_10m: p.recent_attempt_count_10m,
        fulfillment_method: p.fulfillment_method, delivery_by: p.delivery_by ?? null,
        order_returnable: p.order_returnable, order_cancellable: p.order_cancellable,
        related_authorization_id: p.related_authorization_id ? liveId(p.related_authorization_id) : null,
        related_authorization_status: null, // filled from our own decisions at delivery time
        purchase_description: p.purchase_description,
        items: items.map((l) => ({
          line_no: l.line_no, item_id: l.item_id, item_name: l.item_name, item_category: l.item_category,
          quantity: l.quantity, unit_price: l.unit_price, currency: l.currency, item_details: l.item_details ?? '',
        })),
      },
      mandate: run.mandate_snapshot,
      context: { approved_spend_in_period_chf: null, recent_authorizations: [] },
      runtime: { received_at: '', history_window_minutes: 10, context_basis: 'run_decisions_and_scenario_timestamps' },
    } as AuthorizationEvent;
  });
}

export function withDeliveryContext(e: AuthorizationEvent, runId: string): AuthorizationEvent {
  const now = new Date();
  const a = e.authorization;
  const t = Date.parse(a.timestamp);
  const prior = listDecisions({ run_id: runId }).filter((d) => d.authorization_id !== a.authorization_id);
  if (a.related_authorization_id) {
    const rel = getDecision(a.related_authorization_id);
    const st = rel?.status === 'expired' ? 'declined' : rel?.status;
    a.related_authorization_status = st ?? null;
  }
  const approvedAll = prior.filter((d) => d.status === 'approved');
  return {
    ...e,
    deadline_at: new Date(now.getTime() + 8000).toISOString(),
    context: {
      approved_spend_in_period_chf: Math.round(approvedAll.reduce((s, d) => s + d.billing_amount_chf, 0) * 100) / 100,
      recent_authorizations: prior
        .filter((d) => { const dt = Date.parse(d.sim_timestamp); return dt < t && dt >= t - 10 * 60_000; })
        .map((d) => ({ authorization_id: d.authorization_id, timestamp: d.sim_timestamp, merchant_id: d.merchant_id, billing_amount_chf: d.billing_amount_chf, status: d.status === 'expired' ? 'declined' : d.status })),
    },
    runtime: { ...e.runtime, received_at: now.toISOString() },
  };
}

export async function startRun(scenarioId: string, mandateId: string, mode: 'offline' | 'live', stepMs = 700): Promise<Run> {
  const m = getMandate(mandateId);
  if (m.status !== 'active') throw new PolicyError(m.status === 'revoked' ? 'This policy was revoked; create and confirm a new one.' : 'Confirm the policy before the agent can shop.', 409);
  const authority = getDb().prepare('SELECT a.* FROM purchase_attempts p JOIN scenario_authorities a ON a.authority_id = p.authority_id WHERE p.scenario_id = ? LIMIT 1').get(scenarioId) as any;
  if (!authority) throw new PolicyError(`Unknown scenario ${scenarioId}`, 404);

  const snapshot: EventMandate = {
    mandate_id: m.remote_mandate_id ?? m.id, status: 'active', customer_id: authority.customer_id, card_id: authority.card_id,
    instruction: m.instruction, hard_rules: m.hard_rules, uncertainty_policy: m.uncertainty_policy, profile_id: `LOCAL-${authority.authority_id}`,
  };
  const run: Run = {
    id: `RUN-${randomUUID().slice(0, 8)}`, mode, scenario_id: scenarioId, mandate_id: m.id, mandate_snapshot: snapshot,
    remote_run_id: null, status: 'running', created_at: new Date().toISOString(), error: null,
  };

  if (mode === 'live') {
    if (!liveEnabled()) throw new PolicyError('Live mode needs TEAM_API_KEY on the backend.', 400);
    if (!m.remote_mandate_id) throw new PolicyError('This policy was confirmed offline; create and confirm a new one with the API key configured.', 409);
    const res = await api('/v1/scenario-runs', { method: 'POST', body: { scenario_id: scenarioId, mandate_id: m.remote_mandate_id } });
    const remoteRunId = res.data?.run_id ?? res.data?.data?.run_id;
    if (!remoteRunId) throw new PolicyError('The simulator did not return a run_id.', 502);
    return registerLiveRun(remoteRunId, run); // the worker receives and answers the events
  }

  insertRun(run);
  const events = buildOfflineEvents(scenarioId, run);
  void (async () => {
    try {
      for (const e of events) {
        if (getMandate(m.id).status === 'revoked') {
          setRunStatus(run.id, 'completed', 'Stopped: the customer revoked the wallet policy.');
          return;
        }
        recordDecision(withDeliveryContext(e, run.id), run.id);
        await new Promise((r) => setTimeout(r, stepMs));
      }
      setRunStatus(run.id, 'completed');
    } catch (err) {
      setRunStatus(run.id, 'failed', String((err as Error).message));
    }
  })();
  return run;
}

/** The real customer's answer to a step-up. Never invented by the system. */
export async function resolveStepUp(authorizationId: string, decision: 'approve' | 'decline', note?: string): Promise<DecisionRecord> {
  const d = getDecision(authorizationId);
  if (!d) throw new PolicyError('Unknown authorization', 404);
  if (d.status !== 'pending') throw new PolicyError(`This purchase is already ${d.status}.`, 409);
  const run = getRun(d.run_id);
  const message = note?.trim() || (decision === 'approve' ? 'The customer confirmed this purchase.' : 'The customer rejected this purchase.');
  if (run.mode === 'live') {
    try {
      await api(`/v1/authorizations/${encodeURIComponent(authorizationId)}/resolve`, {
        method: 'POST', body: { decision, customer_message: message, evidence: d.evidence.slice(0, 10) },
      });
    } catch (e) {
      // Most likely the platform already closed it (e.g. the human window ran out): sync and explain.
      await reconcileLive({ only: authorizationId, force: true });
      const now = getDecision(authorizationId)!;
      if (now.status !== 'pending') throw new PolicyError(`The simulator had already closed this purchase as ${now.status}; your answer was not applied.`, 409);
      throw e;
    }
  }
  return setResolution(authorizationId, decision === 'approve' ? 'approved' : 'declined', 'customer', message);
}

/** Offline human window: an unanswered step-up is never approved by default. */
export function expireStalePending() {
  const rows = getDb().prepare(`SELECT d.authorization_id FROM decisions d JOIN runs r ON r.id = d.run_id
    WHERE d.status = 'pending' AND r.mode != 'live' AND d.human_deadline_at < ?`).all(new Date().toISOString()) as { authorization_id: string }[];
  for (const r of rows) setResolution(r.authorization_id, 'expired', 'timeout', 'No answer from the customer in time; the purchase was not made.');
}

type PlatformAuthorization = { authorization_id?: string; id?: string; status?: string; final_status?: string; decision?: string };
export type PlatformLister = () => Promise<PlatformAuthorization[]>;

const defaultLister: PlatformLister = async () => {
  const res = await api('/v1/authorizations');
  const d: any = res.data;
  const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.authorizations) ? d.authorizations : Array.isArray(d?.data?.authorizations) ? d.data.authorizations : [];
  return list as PlatformAuthorization[];
};

/** Maps a platform status onto ours; null while the platform still considers it open. */
export function mapPlatformStatus(raw: string | undefined): 'approved' | 'declined' | 'expired' | null {
  const s = (raw ?? '').toLowerCase();
  if (['approved', 'approve', 'resolved_approved'].includes(s)) return 'approved';
  if (['declined', 'decline', 'rejected', 'cancelled', 'canceled', 'resolved_declined', 'revoked'].includes(s)) return 'declined';
  if (['expired', 'timeout', 'timed_out'].includes(s)) return 'expired';
  return null;
}

const GRACE_MS = 30_000;

/**
 * Keeps live decisions in line with the hosted platform:
 * - step-ups whose human window has passed, and
 * - decisions whose submission failed (they are not counted as spend meanwhile).
 * If the platform cannot tell us, a step-up is closed as expired after a grace period:
 * an unanswered purchase is never treated as approved.
 */
export async function reconcileLive(opts: { only?: string; force?: boolean; lister?: PlatformLister } = {}): Promise<number> {
  const now = Date.now();
  const rows = (getDb().prepare(`SELECT d.authorization_id, d.status, d.human_deadline_at, d.remote_error FROM decisions d JOIN runs r ON r.id = d.run_id
    WHERE r.mode = 'live' AND (d.status = 'pending' OR d.remote_error IS NOT NULL)`).all() as { authorization_id: string; status: string; human_deadline_at: string | null; remote_error: string | null }[])
    .filter((r) => (opts.only ? r.authorization_id === opts.only : true))
    .filter((r) => opts.force || r.remote_error || (r.human_deadline_at && Date.parse(r.human_deadline_at) < now));
  if (!rows.length) return 0;

  let platform: PlatformAuthorization[] | null = null;
  try { platform = await (opts.lister ?? defaultLister)(); } catch { platform = null; }
  let changed = 0;
  for (const r of rows) {
    const p = platform?.find((x) => (x.authorization_id ?? x.id) === r.authorization_id);
    const mapped = mapPlatformStatus(p?.final_status ?? p?.status ?? p?.decision);
    if (mapped && (mapped !== r.status || r.remote_error)) {
      setResolution(r.authorization_id, mapped, 'platform', `Final status reported by the simulator: ${mapped}.`);
      getDb().prepare('UPDATE decisions SET remote_error = NULL WHERE authorization_id = ?').run(r.authorization_id);
      changed++;
    } else if (!mapped && r.status === 'pending' && r.human_deadline_at && Date.parse(r.human_deadline_at) + GRACE_MS < now) {
      setResolution(r.authorization_id, 'expired', 'timeout', 'No answer in time and no final status from the simulator; the purchase is treated as not made.');
      changed++;
    }
  }
  return changed;
}

/** Revoking a policy withdraws consent for anything still waiting in offline runs. */
export function cascadeRevocation(mandateId: string) {
  const rows = getDb().prepare(`SELECT d.authorization_id FROM decisions d JOIN runs r ON r.id = d.run_id
    WHERE d.status = 'pending' AND r.mode != 'live' AND r.mandate_id = ?`).all(mandateId) as { authorization_id: string }[];
  for (const r of rows) setResolution(r.authorization_id, 'declined', 'revocation', 'Declined because you revoked the wallet policy.');
}

export { markRemote };
