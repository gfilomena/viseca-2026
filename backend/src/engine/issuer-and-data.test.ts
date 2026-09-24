import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.TEAM_API_KEY = '';

const { config } = await import('../config.ts');
const { seed, PackVerificationError } = await import('../db/seed.ts');
const { getDb, packReport } = await import('../db/db.ts');
const { verifyPack } = await import('../db/verify.ts');
const { evaluate } = await import('./engine.ts');
const { getCardProfile } = await import('./profile.ts');
const { parsePreferences } = await import('./preferences.ts');
const { cataloguePrices, fxRates, intentsFor } = await import('../services/catalog.ts');
const { createDraft, confirmDraft } = await import('../services/mandates.ts');
const { startRun } = await import('../services/runs.ts');
const { listDecisions } = await import('../services/decisions.ts');

seed(getDb());

/** Copy of the data pack we are allowed to break. */
function packCopy(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-pack-'));
  fs.cpSync(config.dataDir, target, { recursive: true });
  return target;
}

async function eventsOf(scenarioId: string) {
  const { cardholder_instruction } = getDb().prepare('SELECT cardholder_instruction FROM scenario_catalogue WHERE scenario_id = ?').get(scenarioId) as any;
  const m = await confirmDraft(createDraft(cardholder_instruction, scenarioId).id);
  const run = await startRun(scenarioId, m.id, 'offline', 0);
  const total = (getDb().prepare('SELECT COUNT(*) AS n FROM purchase_attempts WHERE scenario_id = ?').get(scenarioId) as any).n;
  for (let i = 0; i < 400 && listDecisions({ run_id: run.id }).length < total; i++) await new Promise((r) => setTimeout(r, 5));
  return Object.fromEntries(listDecisions({ run_id: run.id }).map((d) => [d.source_authorization_id, d.event]));
}

function decideWith(event: any, patchProfile: (p: any) => void = () => {}) {
  const base = getCardProfile(getDb(), event.authorization.card_id);
  const profile = { ...base, card: base.card && { ...base.card }, account: base.account && { ...base.account }, authorities: [...base.authorities], monthlySpend: new Map(base.monthlySpend) };
  patchProfile(profile);
  return evaluate({ event, profile, prior: [], fx: fxRates(), catalogue: cataloguePrices(), intents: intentsFor(event.mandate.instruction) });
}

// ---- (a) data pack verification -------------------------------------------

test('the shipped data pack passes every contract check and the report is stored', () => {
  const r = verifyPack(config.dataDir);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.checks.length, 9);
  assert.equal((packReport() as any).ok, true);
});

test('a broken foreign key or column contract stops seeding', () => {
  const p = packCopy();
  const cards = path.join(p, 'cards.csv');
  fs.writeFileSync(cards, fs.readFileSync(cards, 'utf8').replace('CA0001,AC0001', 'CA0001,AC9999'));
  const hist = path.join(p, 'authorization_history.csv');
  fs.writeFileSync(hist, fs.readFileSync(hist, 'utf8').replace(',ME0052,PlainLedger,software,7372,', ',ME0052,PlainLedger,software,73X2,'));
  const r = verifyPack(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('cards.csv.account_id')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.includes('merchant_mcc')), r.errors.join('\n'));
  assert.throws(() => seed(getDb(), p), PackVerificationError);
  // The existing database is untouched by the refused seed.
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM cards').get() as any).n, 41);
});

test('a revised but well-formed pack only warns about changed hashes', () => {
  const p = packCopy();
  fs.appendFileSync(path.join(p, 'README.md'), '\nrevised\n');
  const r = verifyPack(p);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('README.md')));
});

test('an amount that does not follow the currency formula is reported', () => {
  const p = packCopy();
  const f = path.join(p, 'purchase_attempts.csv');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('199.00,EUR,189.05', '199.00,EUR,199.00'));
  const r = verifyPack(p);
  assert.ok(r.errors.some((e) => e.includes('AU0025')), r.errors.join('\n'));
});

// ---- (b) card, account and delegation --------------------------------------

test('issuer checks pass for the scenario card and explain the limits', async () => {
  const ev = await eventsOf('SCEN0004');
  const r = decideWith(ev.AU0038);
  assert.equal(r.decision, 'approve');
  const c = r.checks.find((x) => x.id === 'issuer')!;
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /per month/);
});

test('card switched off for payments abroad declines a foreign shop', async () => {
  const ev = await eventsOf('SCEN0004');
  const r = decideWith(ev.AU0038, (p) => { p.card.international_enabled = false; });
  assert.equal(r.decision, 'decline');
  assert.ok(r.reason_codes.includes('card_international_disabled'));
});

test('online payments off, expired card, blocked card', async () => {
  const ev = await eventsOf('SCEN0004');
  assert.ok(decideWith(ev.AU0035, (p) => { p.card.online_enabled = false; }).reason_codes.includes('card_online_disabled'));
  assert.ok(decideWith(ev.AU0035, (p) => { p.card.expires_on = '2026-08-01'; }).reason_codes.includes('card_expired'));
  assert.ok(decideWith(ev.AU0035, (p) => { p.card.status = 'blocked'; }).reason_codes.includes('card_inactive'));
});

test('account per-transaction and monthly limits are enforced', async () => {
  const ev = await eventsOf('SCEN0004');
  const perTx = decideWith(ev.AU0035, (p) => { p.account.per_transaction_limit_chf = 250; });
  assert.equal(perTx.decision, 'decline');
  assert.ok(perTx.reason_codes.includes('issuer_transaction_limit'));
  const monthly = decideWith(ev.AU0035, (p) => { p.monthlySpend.set('2026-08', p.account.monthly_limit_chf - 100); });
  assert.equal(monthly.decision, 'decline');
  assert.ok(monthly.reason_codes.includes('issuer_monthly_limit'));
});

test('a purchase outside the delegation window is declined', async () => {
  const ev = await eventsOf('SCEN0004');
  const r = decideWith(ev.AU0035, (p) => { p.authorities = p.authorities.map((x: any) => ({ ...x, valid_until: '2026-08-10T00:00:00Z' })); });
  assert.equal(r.decision, 'decline');
  assert.ok(r.reason_codes.includes('authority_outside_validity'));
});

// ---- (c) customer preferences ----------------------------------------------

test('preferences are parsed from customers.csv', () => {
  const kinds = (t: string) => parsePreferences(t).map((p) => p.test.type);
  assert.deepEqual(kinds('Practical groceries; avoids gift vouchers.'), ['category']);
  assert.deepEqual(kinds('Known electronics sellers, clear warranty terms, and no marketplace add-ons.'), ['addons', 'warranty']);
  assert.deepEqual(kinds('Local products, and collection from a store rather than delivery.'), ['fulfillment']);
  assert.deepEqual(kinds('Flexible hotel bookings near public transport.'), []);
});

test('a basket against a stated preference asks the customer instead of approving', async () => {
  const ev = await eventsOf('SCEN0000');
  const event = structuredClone(ev.AU0001);
  event.mandate.hard_rules = event.mandate.hard_rules.filter((r: any) => r.field === 'authorization.billing_amount_chf');
  event.authorization.items[0] = { ...event.authorization.items[0], item_id: 'IT0005', item_name: 'Digital gift voucher', item_category: 'gift_card', item_details: 'Store credit voucher' };
  const r = decideWith(event);
  assert.equal(r.decision, 'step_up');
  assert.ok(r.reason_codes.includes('customer_preference_conflict'));
  assert.match(r.checks.find((c) => c.id === 'preferences')!.detail, /gift vouchers/);
  // The ordinary grocery purchase of the same customer is still approved with no friction.
  assert.equal(decideWith(ev.AU0001).decision, 'approve');
});

test('preferences never decline on their own', async () => {
  const ev = await eventsOf('SCEN0000');
  const event = structuredClone(ev.AU0001);
  event.mandate.uncertainty_policy = 'approve';
  event.mandate.hard_rules = [];
  event.authorization.items[0].item_category = 'gift_card';
  const r = decideWith(event);
  assert.equal(r.decision, 'approve');
  assert.ok(r.checks.some((c) => c.id === 'preferences' && c.status === 'uncertain'));
});
