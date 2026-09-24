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
const { readBootstrap, runProgress, resetTeam } = await import('./platform.ts');
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
