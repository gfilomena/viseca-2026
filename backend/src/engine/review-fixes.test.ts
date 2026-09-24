import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.TEAM_API_KEY = '';

const { seed } = await import('../db/seed.ts');
const { getDb } = await import('../db/db.ts');
const { createDraft, confirmDraft } = await import('../services/mandates.ts');
const { startRun, ensureLiveRun, registerLiveRun, getRun, reconcileLive, mapPlatformStatus } = await import('../services/runs.ts');
const { listDecisions, recordDecision, markRemote, priorDecisions, getDecision } = await import('../services/decisions.ts');
const { buildApp } = await import('../app.ts');

seed(getDb());

/** Offline events of a scenario, used as realistic live payloads. */
async function events(scenarioId: string) {
  const { cardholder_instruction } = getDb().prepare('SELECT cardholder_instruction FROM scenario_catalogue WHERE scenario_id = ?').get(scenarioId) as any;
  const m = await confirmDraft(createDraft(cardholder_instruction, scenarioId).id);
  const run = await startRun(scenarioId, m.id, 'offline', 0);
  const total = (getDb().prepare('SELECT COUNT(*) AS n FROM purchase_attempts WHERE scenario_id = ?').get(scenarioId) as any).n;
  for (let i = 0; i < 400 && listDecisions({ run_id: run.id }).length < total; i++) await new Promise((r) => setTimeout(r, 5));
  const byId = Object.fromEntries(listDecisions({ run_id: run.id }).map((d) => [d.source_authorization_id, d.event]));
  return { m, byId };
}

let n = 0;
/** A fresh hosted run fed with copies of offline events under new live IDs. */
function liveRun(sample: any) {
  const remote = `RR-${++n}`;
  const run = ensureLiveRun(remote, sample);
  const feed = (e: any) => {
    const ev = structuredClone(e);
    ev.authorization.authorization_id = `LIVE-${remote}-${ev.authorization.source_authorization_id}`;
    return recordDecision(ev, run.id).record;
  };
  return { remote, run, feed };
}

test('worker seeing the first event before startRun returns: one run record, adopted by startRun', async () => {
  const { m, byId } = await events('SCEN0000');
  const { remote, run, feed } = liveRun(byId.AU0001);
  feed(byId.AU0001);
  const adopted = registerLiveRun(remote, { ...run, id: 'RUN-fromStart', mandate_id: m.id, remote_run_id: null });
  assert.equal(adopted.id, run.id);
  assert.equal(adopted.mandate_id, m.id);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM runs WHERE remote_run_id = ?').get(remote) as any).n, 1);
  assert.equal(listDecisions({ run_id: adopted.id }).length, 1);
  assert.equal(getRun(remote).id, run.id);
});

test('a live answer the platform never received is not counted as spend', async () => {
  const { byId } = await events('SCEN0001');
  const { feed } = liveRun(byId.AU0002);
  const first = feed(byId.AU0002);
  assert.equal(first.status, 'approved');
  assert.equal(priorDecisions(first.run_id, '2026-12-31T00:00:00Z', 'x').length, 1);
  markRemote(first.authorization_id, false, 'timeout');
  assert.equal(priorDecisions(first.run_id, '2026-12-31T00:00:00Z', 'x').length, 0);
  markRemote(first.authorization_id, true);
  assert.equal(priorDecisions(first.run_id, '2026-12-31T00:00:00Z', 'x').length, 1);
});

test('live step-ups are closed from the platform status, or expire when it is silent', async () => {
  const { byId } = await events('SCEN0002');
  const { feed } = liveRun(byId.AU0016);
  const pending = feed(byId.AU0016);
  assert.equal(pending.status, 'pending');
  const past = (ms: number) => new Date(Date.now() - ms).toISOString();
  getDb().prepare('UPDATE decisions SET human_deadline_at = ? WHERE authorization_id = ?').run(past(1000), pending.authorization_id);

  // Still open on the platform and inside the grace period: unchanged.
  assert.equal(await reconcileLive({ lister: async () => [{ authorization_id: pending.authorization_id, status: 'pending' }] }), 0);
  // Platform closed it.
  await reconcileLive({ lister: async () => [{ authorization_id: pending.authorization_id, status: 'declined' }] });
  assert.equal(getDecision(pending.authorization_id)!.status, 'declined');
  assert.equal(getDecision(pending.authorization_id)!.resolved_by, 'platform');

  const { feed: feed2 } = liveRun(byId.AU0016);
  const silent = feed2(byId.AU0016);
  getDb().prepare('UPDATE decisions SET human_deadline_at = ? WHERE authorization_id = ?').run(past(60_000), silent.authorization_id);
  await reconcileLive({ lister: async () => { throw new Error('network down'); } });
  assert.equal(getDecision(silent.authorization_id)!.status, 'expired');
});

test('a failed submission is corrected from the platform status', async () => {
  const { byId } = await events('SCEN0000');
  const { feed } = liveRun(byId.AU0001);
  const d = feed(byId.AU0001);
  markRemote(d.authorization_id, false, 'timeout');
  await reconcileLive({ lister: async () => [{ authorization_id: d.authorization_id, status: 'expired' }] });
  const after = getDecision(d.authorization_id)!;
  assert.equal(after.status, 'expired');
  assert.equal(after.remote_error, null);
});

test('platform status mapping never turns an unknown status into approval', () => {
  assert.equal(mapPlatformStatus('approved'), 'approved');
  assert.equal(mapPlatformStatus('cancelled'), 'declined');
  assert.equal(mapPlatformStatus('timeout'), 'expired');
  assert.equal(mapPlatformStatus('pending'), null);
  assert.equal(mapPlatformStatus('weird'), null);
  assert.equal(mapPlatformStatus(undefined), null);
});

test('only the customer UI origin may call the API', async () => {
  const app = await buildApp();
  const evil = await app.inject({ method: 'GET', url: '/api/decisions?status=pending', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const csrf = await app.inject({ method: 'POST', url: '/api/decisions/x/resolve', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, payload: '{"decision":"approve"}' });
  assert.equal(csrf.statusCode, 403);
  const ui = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:4200' } });
  assert.equal(ui.statusCode, 200);
  assert.equal(ui.headers['access-control-allow-origin'], 'http://localhost:4200');
  const cli = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(cli.statusCode, 200);
  await app.close();
});
