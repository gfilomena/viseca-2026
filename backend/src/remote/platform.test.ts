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
const { readBootstrap, runProgress, resetTeam, fetchReferenceData, getRemoteMandate, listPendingTransactions, fetchEvents } = await import('./platform.ts');
const { config } = await import('../config.ts');
const { createDraft, confirmDraft, listMandates } = await import('../services/mandates.ts');
const { startRun } = await import('../services/runs.ts');

seed(getDb());

test('bootstrap settings are read whatever the nesting and units', () => {
  assert.deepEqual(readBootstrap({ data: { timeouts: { decision_deadline_seconds: 8, human_window_seconds: 90 }, versions: { pack_version: 'saw26' } } }),
    { human_window_seconds: 90, decision_deadline_seconds: 8, remote_pack_version: 'saw26' });
  assert.deepEqual(readBootstrap({ settings: { human_timeout_ms: 120000, decision_timeout_ms: 8000 } }),
    { human_window_seconds: 120, decision_deadline_seconds: 8 });
  // Unknown shapes leave the documented defaults in place.
  assert.deepEqual(readBootstrap({ something: 'else' }), {});
});

test('bootstrap settings are read from the real hosted API shape', () => {
  // Exact shape of GET /v1/bootstrap observed from the live platform (team35, saw26 pack):
  // limits.step_up_timeout_seconds (the "human window" the challenge guide describes) has no
  // "human" in its name — this used to be missed and silently fall back to the default.
  const real = {
    type: 'bootstrap', api_version: '0.1.0', pack_version: 'saw26', team_id: 'team35',
    limits: { decision_timeout_seconds: 8, step_up_timeout_seconds: 120, long_poll_max_seconds: 25 },
    features: { reset: false },
  };
  assert.deepEqual(readBootstrap(real), { decision_deadline_seconds: 8, human_window_seconds: 120, remote_pack_version: 'saw26', reset_enabled: false });
});

test('a hosted run is finished only when the platform says so', () => {
  assert.equal(runProgress({ data: { status: 'completed' } }), 'completed');
  assert.equal(runProgress({ status: 'running', counters: { total: 11, decided: 4 } }), 'running');
  assert.equal(runProgress({ counters: { event_count: 11, finalized: 11 } }), 'completed');
  assert.equal(runProgress({ run: { state: 'cancelled' } }), 'failed');
  assert.equal(runProgress({}), 'running');
});

test('team reset clears local mandates, runs and decisions but keeps the data pack', async () => {
  const { i } = getDb().prepare("SELECT cardholder_instruction AS i FROM scenario_catalogue WHERE scenario_id = 'SCEN0000'").get() as { i: string };
  const m = await confirmDraft(createDraft(i, 'SCEN0000').id);
  await startRun('SCEN0000', m.id, 'offline', 0);
  await new Promise((r) => setTimeout(r, 50));
  const res = await resetTeam();
  assert.equal(res.platform, 'skipped'); // no team key: nothing to reset remotely
  assert.ok(res.local.mandates >= 1 && res.local.decisions >= 1);
  assert.equal(listMandates().length, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM authorization_history').get() as { n: number }).n, 4701);
});

/** A fake `api()` client that answers with a fixed body for whichever path prefix matches. */
function fakeClient(byPath: Record<string, unknown>) {
  return async (path: string) => {
    const key = Object.keys(byPath).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected path ${path}`);
    return { status: 200, data: byPath[key] };
  };
}

async function withTeamKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = config.teamApiKey;
  config.teamApiKey = 'test-key';
  try { return await fn(); } finally { config.teamApiKey = prev; }
}

test('the hosted-API pass-throughs refuse when no team key is configured', async () => {
  const prev = config.teamApiKey;
  config.teamApiKey = '';
  try {
    await assert.rejects(() => fetchReferenceData(), /TEAM_API_KEY/);
    await assert.rejects(() => getRemoteMandate('TM1'), /TEAM_API_KEY/);
    await assert.rejects(() => listPendingTransactions(), /TEAM_API_KEY/);
    await assert.rejects(() => fetchEvents(), /TEAM_API_KEY/);
  } finally {
    config.teamApiKey = prev;
  }
});

test('reference data ("products") is returned exactly as the platform sent it', async () => {
  const data = await withTeamKey(() => fetchReferenceData(fakeClient({
    '/v1/reference-data': { scenarios: [{ scenario_id: 'SCEN0000' }], fx_rates: [{ from_currency: 'EUR', rate: 0.95 }] },
  }) as any));
  assert.deepEqual(data, { scenarios: [{ scenario_id: 'SCEN0000' }], fx_rates: [{ from_currency: 'EUR', rate: 0.95 }] });
});

test('a mandate is re-read straight from the platform, not from our local copy', async () => {
  const data = await withTeamKey(() => getRemoteMandate('TM-abc', fakeClient({
    '/v1/mandates/TM-abc': { mandate_id: 'TM-abc', status: 'active' },
  }) as any));
  assert.deepEqual(data, { mandate_id: 'TM-abc', status: 'active' });
});

test('pending transactions are listed via the shared authorization lister', async () => {
  const list = await withTeamKey(() => listPendingTransactions(async () => [
    { authorization_id: 'AU1', status: 'pending' }, { authorization_id: 'AU2', status: 'approved' },
  ]));
  assert.deepEqual(list, [{ authorization_id: 'AU1', status: 'pending' }, { authorization_id: 'AU2', status: 'approved' }]);
});

test('the event feed is unwrapped whatever the response shape, and next_cursor is passed through', async () => {
  const a = await withTeamKey(() => fetchEvents(0, fakeClient({ '/v1/events': { events: [{ event_id: 'e1' }], next_cursor: 'c1' } }) as any));
  assert.deepEqual(a, { events: [{ event_id: 'e1' }], next_cursor: 'c1' });
  const b = await withTeamKey(() => fetchEvents('c1', fakeClient({ '/v1/events': [{ event_id: 'e2' }] }) as any));
  assert.deepEqual(b, { events: [{ event_id: 'e2' }], next_cursor: null });
});
