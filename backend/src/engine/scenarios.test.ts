import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolated database for the test run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.TEAM_API_KEY = '';

const { seed } = await import('../db/seed.ts');
const { getDb } = await import('../db/db.ts');
const { createDraft, confirmDraft, revoke } = await import('../services/mandates.ts');
const { startRun, resolveStepUp, cascadeRevocation } = await import('../services/runs.ts');
const { listDecisions, getDecision, approvalImpact } = await import('../services/decisions.ts');

seed(getDb());

async function replay(scenarioId: string, onPending?: (id: string, src: string) => Promise<void>, stepMs = 0) {
  const { cardholder_instruction } = getDb().prepare('SELECT cardholder_instruction FROM scenario_catalogue WHERE scenario_id = ?').get(scenarioId) as any;
  const draft = createDraft(cardholder_instruction, scenarioId);
  const m = await confirmDraft(draft.id);
  const run = await startRun(scenarioId, m.id, 'offline', stepMs);
  // Wait for the async replay to finish; resolve step-ups as they appear if asked to.
  const total = (getDb().prepare('SELECT COUNT(*) AS n FROM purchase_attempts WHERE scenario_id = ?').get(scenarioId) as any).n;
  const handled = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const ds = listDecisions({ run_id: run.id });
    if (onPending) for (const d of ds.filter((x) => x.status === 'pending' && !handled.has(x.authorization_id))) { handled.add(d.authorization_id); await onPending(d.authorization_id, d.source_authorization_id); }
    if (ds.length === total) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const ds = listDecisions({ run_id: run.id }).sort((a, b) => a.replay_order - b.replay_order);
  return { m, run, byId: Object.fromEntries(ds.map((d) => [d.source_authorization_id, d])) };
}

const decisions = (byId: Record<string, any>) => Object.fromEntries(Object.entries(byId).map(([k, d]) => [k, d.engine_decision]));

test('connection check: ordinary grocery purchase is approved with no friction', async () => {
  const { byId } = await replay('SCEN0000');
  assert.deepEqual(decisions(byId), { AU0001: 'approve' });
});

test('household budget: per-order and rolling 7-day limits, basket purpose, split orders', async () => {
  const { byId } = await replay('SCEN0001');
  assert.deepEqual(decisions(byId), {
    AU0002: 'approve', AU0003: 'approve', AU0004: 'decline', AU0005: 'approve', AU0006: 'step_up',
    AU0007: 'decline', AU0008: 'approve', AU0009: 'decline', AU0010: 'decline', AU0011: 'approve',
  });
  assert.ok(byId.AU0004.reason_codes.includes('amount_over_limit'));
  assert.ok(byId.AU0007.reason_codes.includes('item_category_not_allowed'));
  assert.ok(byId.AU0009.reason_codes.includes('amount_over_limit'));
});

test('requested item and order terms', async () => {
  const { byId } = await replay('SCEN0002');
  assert.deepEqual(decisions(byId), {
    AU0012: 'approve', AU0013: 'decline', AU0014: 'decline', AU0015: 'decline', AU0016: 'step_up', AU0017: 'decline',
    AU0018: 'decline', AU0019: 'approve', AU0020: 'decline', AU0021: 'decline', AU0022: 'decline', AU0023: 'approve',
  });
});

test('session integrity escalates and relaxes again', async () => {
  const { byId } = await replay('SCEN0003');
  assert.deepEqual(decisions(byId), {
    AU0024: 'approve', AU0025: 'approve', AU0026: 'step_up', AU0027: 'decline', AU0028: 'decline', AU0029: 'decline',
    AU0030: 'decline', AU0031: 'approve', AU0032: 'approve', AU0033: 'decline', AU0034: 'decline',
  });
  assert.ok(byId.AU0026.reason_codes.includes('new_device'));
});

test('manipulated agent: injection, lookalike, duplicate, add-on, wrong item, re-quote', async () => {
  const { byId } = await replay('SCEN0004');
  assert.deepEqual(decisions(byId), {
    AU0035: 'approve', AU0036: 'decline', AU0037: 'decline', AU0038: 'approve', AU0039: 'decline', AU0040: 'step_up',
    AU0041: 'decline', AU0042: 'approve', AU0043: 'decline', AU0044: 'decline', AU0045: 'approve',
  });
  assert.ok(byId.AU0036.reason_codes.includes('duplicate_order'));
  assert.ok(byId.AU0037.reason_codes.includes('merchant_text_manipulation'));
  assert.ok(byId.AU0039.reason_codes.includes('lookalike_merchant'));
});

test('human approval counts towards the rolling limit', async () => {
  const { byId } = await replay('SCEN0001', async (id) => { await resolveStepUp(id, 'approve'); }, 60);
  assert.equal(byId.AU0006.status, 'approved');
  assert.equal(byId.AU0006.resolved_by, 'customer');
  // 44.50 + 120 + 70 + 65 already approved in the window, so the next order no longer fits.
  assert.equal(byId.AU0008.engine_decision, 'decline');
});

test('revocation declines pending step-ups and a revoked policy cannot start runs', async () => {
  const { m, byId } = await replay('SCEN0002');
  assert.equal(byId.AU0016.status, 'pending');
  await revoke(m.id);
  cascadeRevocation(m.id);
  const after = listDecisions({}).find((d) => d.authorization_id === byId.AU0016.authorization_id)!;
  assert.equal(after.status, 'declined');
  assert.equal(after.resolved_by, 'revocation');
  await assert.rejects(startRun('SCEN0002', m.id, 'offline', 0));
});

test('late approval of a step-up warns when it would breach the rolling limit', async () => {
  const { byId } = await replay('SCEN0001');
  const impact = approvalImpact(getDecision(byId.AU0006.authorization_id)!);
  assert.equal(impact.length, 1);
  assert.equal(impact[0].breaches, true);
  assert.equal(impact[0].total_if_approved_chf, 365);
});

test('compiler never loosens: tightening only adds rules and only moves towards decline', async () => {
  const { tighten } = await import('../services/mandates.ts');
  const { m } = await replay('SCEN0000');
  await assert.rejects(tighten(m.id, { uncertainty_policy: 'approve' }));
  const t = await tighten(m.id, { add_rules: [{ field: 'merchant.merchant_country', operator: 'in', value: ['CH'] }], uncertainty_policy: 'decline' });
  assert.equal(t.hard_rules.length, m.hard_rules.length + 1);
  assert.deepEqual(t.hard_rules.slice(0, m.hard_rules.length), m.hard_rules);
  assert.equal(t.uncertainty_policy, 'decline');
});

test('offline events conform to the official authorization event schema', async () => {
  const { validateEvent } = await import('../remote/worker.ts');
  const { byId } = await replay('SCEN0004');
  for (const d of Object.values(byId) as any[]) {
    assert.ok(validateEvent(d.event), `${d.source_authorization_id}: ${JSON.stringify(validateEvent.errors)}`);
  }
  const example = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../data/scenario_fixtures/example_authorization_request.json'), 'utf8'));
  assert.ok(validateEvent(example));
});
