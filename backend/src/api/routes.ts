import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb, packReport } from '../db/db.ts';
import { config, liveEnabled } from '../config.ts';
import { bus, type BusMessage } from '../services/bus.ts';
import { createDraft, editDraft, confirmDraft, tighten, revoke, getMandate, listMandates, PolicyError } from '../services/mandates.ts';
import { listRuns, getRun, startRun, resolveStepUp, cascadeRevocation } from '../services/runs.ts';
import { approvalImpact, getDecision, listDecisions } from '../services/decisions.ts';
import { getCardProfile } from '../engine/profile.ts';
import { parsePreferences } from '../engine/preferences.ts';
import { RemoteError, api } from '../remote/client.ts';
import { workerState } from '../remote/worker.ts';
import { describeRule } from '../policy/compiler.ts';
import { interpretForMandate, sandboxOptions, tryToBuy } from '../services/sandbox.ts';

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof PolicyError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof RemoteError) return reply.code(502).send({ error: e.message, remote: e.body });
  console.error(e);
  return reply.code(500).send({ error: (e as Error).message });
}

export async function routes(app: FastifyInstance) {
  const db = getDb();

  app.get('/api/health', async () => ({
    ok: true, engine: config.engineVersion, pack: packReport(), live: liveEnabled(), worker: workerState,
    data: Object.fromEntries(['customers', 'cards', 'merchants', 'items', 'authorization_history', 'purchase_attempts']
      .map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n])),
  }));

  // --- Reference data -------------------------------------------------------
  app.get('/api/scenarios', async () => db.prepare(`
    SELECT s.*, a.customer_id, a.card_id, c.persona_name
      FROM scenario_catalogue s
      LEFT JOIN (SELECT DISTINCT scenario_id, authority_id FROM purchase_attempts) p ON p.scenario_id = s.scenario_id
      LEFT JOIN scenario_authorities a ON a.authority_id = p.authority_id
      LEFT JOIN customers c ON c.customer_id = a.customer_id
     ORDER BY s.scenario_id`).all());

  app.get<{ Params: { id: string } }>('/api/scenarios/:id/attempts', async (req) => db.prepare(`
    SELECT p.*, m.merchant_name, m.merchant_category, m.merchant_country FROM purchase_attempts p
      JOIN merchants m ON m.merchant_id = p.merchant_id WHERE p.scenario_id = ? ORDER BY replay_order`).all(req.params.id));

  app.get<{ Params: { id: string } }>('/api/cards/:id/profile', async (req, reply) => {
    const card = db.prepare(`SELECT c.*, a.customer_id, a.account_type, a.per_transaction_limit_chf, a.monthly_limit_chf, cu.persona_name, cu.shopping_preferences, cu.budget_style
      FROM cards c JOIN accounts a ON a.account_id = c.account_id JOIN customers cu ON cu.customer_id = a.customer_id WHERE c.card_id = ?`).get(req.params.id);
    if (!card) return reply.code(404).send({ error: 'Unknown card' });
    const p = getCardProfile(db, req.params.id);
    const merchants = [...p.merchantCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)
      .map(([id, n]) => ({ merchant_id: id, merchant_name: p.merchantNames.get(id), approved_purchases: n }));
    return {
      card, merchants, devices: Object.fromEntries(p.deviceCounts), countries: [...p.countries], amount_p95_chf: p.amountP95, purchases: p.purchaseCount,
      authorities: p.authorities, monthly_spend: Object.fromEntries(p.monthlySpend), preferences: parsePreferences(p.customer?.shopping_preferences).map((x) => ({ phrase: x.phrase, kind: x.kind, type: x.test.type })),
    };
  });

  // --- Wallet policy (mandates) ---------------------------------------------
  app.get('/api/mandates', async () => listMandates().map((m) => ({ ...m, rule_labels: m.hard_rules.map(describeRule) })));
  app.get<{ Params: { id: string } }>('/api/mandates/:id', async (req, reply) => {
    try { const m = getMandate(req.params.id); return { ...m, rule_labels: m.hard_rules.map(describeRule) }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { instruction: string; scenario_id?: string } }>('/api/mandates', async (req, reply) => {
    try { return reply.code(201).send(createDraft(req.body.instruction, req.body.scenario_id ?? null)); } catch (e) { return fail(reply, e); }
  });
  app.put<{ Params: { id: string }; Body: any }>('/api/mandates/:id/draft', async (req, reply) => {
    try { return editDraft(req.params.id, req.body as any); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string } }>('/api/mandates/:id/confirm', async (req, reply) => {
    try { return await confirmDraft(req.params.id); } catch (e) { return fail(reply, e); }
  });
  app.patch<{ Params: { id: string }; Body: any }>('/api/mandates/:id', async (req, reply) => {
    try { return await tighten(req.params.id, req.body as any); } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/api/mandates/:id', async (req, reply) => {
    try { const m = await revoke(req.params.id); cascadeRevocation(m.id); return m; } catch (e) { return fail(reply, e); }
  });

  // --- Runs and decisions ---------------------------------------------------
  app.get('/api/runs', async () => listRuns());
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    try {
      const run = getRun(req.params.id);
      let remote: unknown = null;
      if (run.mode === 'live' && run.remote_run_id && liveEnabled()) remote = (await api(`/v1/scenario-runs/${run.remote_run_id}`).catch(() => ({ data: null }))).data;
      return { ...run, remote };
    } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { scenario_id: string; mandate_id: string; mode?: 'offline' | 'live'; step_ms?: number } }>('/api/runs', async (req, reply) => {
    try { return reply.code(201).send(await startRun(req.body.scenario_id, req.body.mandate_id, req.body.mode ?? 'offline', req.body.step_ms)); } catch (e) { return fail(reply, e); }
  });
  app.get<{ Querystring: { run_id?: string; status?: string } }>('/api/decisions', async (req) => {
    const runs = new Map(listRuns().map((r) => [r.id, r]));
    return listDecisions(req.query).map((full) => { const { event, ...d } = full; return { ...d, run_mode: runs.get(d.run_id)?.mode, scenario_id: runs.get(d.run_id)?.scenario_id, impact: d.status === 'pending' ? approvalImpact(full) : [], merchant_category: event.authorization.merchant.merchant_category, currency: event.authorization.currency, amount: event.authorization.amount, items: event.authorization.items.map((i) => i.item_name) }; });
  });
  app.get<{ Params: { id: string } }>('/api/decisions/:id', async (req, reply) => {
    const d = getDecision(req.params.id);
    return d ? { ...d, impact: d.status === 'pending' ? approvalImpact(d) : [] } : reply.code(404).send({ error: 'Unknown authorization' });
  });
  app.post<{ Params: { id: string }; Body: { decision: 'approve' | 'decline'; note?: string } }>('/api/decisions/:id/resolve', async (req, reply) => {
    if (!['approve', 'decline'].includes(req.body?.decision)) return reply.code(400).send({ error: 'decision must be approve or decline' });
    try { return await resolveStepUp(req.params.id, req.body.decision, req.body.note); } catch (e) { return fail(reply, e); }
  });

  // --- Sandbox shopping chat (simulated agent → wallet control) --------------
  app.get<{ Querystring: { mandate_id: string } }>('/api/shop/options', async (req, reply) => {
    try { return sandboxOptions(req.query.mandate_id); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { mandate_id: string; text: string } }>('/api/shop/interpret', async (req, reply) => {
    try { return interpretForMandate(req.body?.mandate_id, req.body?.text); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { mandate_id: string; offer: any } }>('/api/shop/buy', async (req, reply) => {
    if (!req.body?.offer) return reply.code(400).send({ error: 'offer is required' });
    try { return reply.code(201).send(tryToBuy(req.body.mandate_id, req.body.offer)); } catch (e) { return fail(reply, e); }
  });

  // --- Server-sent events for the UI ----------------------------------------
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      ...(req.headers.origin && config.corsOrigins.includes(req.headers.origin) ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' } : {}) });
    reply.raw.write(': connected\n\n'); // flush headers so proxies open the stream immediately
    const send = (m: BusMessage) => reply.raw.write(`data: ${JSON.stringify(m)}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    bus.on('message', send);
    req.raw.on('close', () => { clearInterval(ping); bus.off('message', send); });
  });
}
