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
const { createDraft, confirmDraft, getMandate, tighten } = await import('./mandates.ts');
const { startRun, cascadeRevocation } = await import('./runs.ts');
const { tryToBuy, interpretForMandate } = await import('./sandbox.ts');
const { getDecision } = await import('./decisions.ts');

seed(getDb());
const instruction = (id: string) => (getDb().prepare('SELECT cardholder_instruction AS i FROM scenario_catalogue WHERE scenario_id = ?').get(id) as { i: string }).i;

test('confirming a new policy for the same card replaces the previous one', async () => {
  // SCEN0002: road-running shoes on CA0011. A purchase with unstated returns waits for the customer.
  const first = await confirmDraft(createDraft(instruction('SCEN0002'), 'SCEN0002').id);
  const r = interpretForMandate(first.id, 'Buy road-running shoes size 43 at TrailSpark for CHF 150');
  const pending = tryToBuy(first.id, { ...r.offer, order_returnable: 'unknown', item_details: 'Road-running shoe, size 43' });
  assert.equal(pending.status, 'pending');

  const second = await confirmDraft(createDraft('Buy running shoes for CHF 120 or less. Ask me when uncertain.', 'SCEN0002').id);
  assert.deepEqual(second.replaced_ids, [first.id]);
  for (const id of second.replaced_ids!) cascadeRevocation(id);

  const old = getMandate(first.id);
  assert.equal(old.status, 'superseded');
  assert.ok(old.audit.some((a) => a.action === 'superseded'));
  assert.equal(getDecision(pending.authorization_id)!.status, 'declined');
  assert.match(getDecision(pending.authorization_id)!.resolution_note!, /replaced/);
  await assert.rejects(startRun('SCEN0002', first.id, 'offline', 0), /replaced/);
  await assert.rejects(tighten(first.id, { uncertainty_policy: 'decline' }));
  assert.equal(getMandate(second.id).status, 'active');
});

test('policies on different cards are independent', async () => {
  const a = await confirmDraft(createDraft(instruction('SCEN0003'), 'SCEN0003').id); // CA0023
  const b = await confirmDraft(createDraft(instruction('SCEN0004'), 'SCEN0004').id); // CA0039
  assert.deepEqual(b.replaced_ids, []);
  assert.equal(getMandate(a.id).status, 'active');
});
