import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { config, liveEnabled } from '../config.ts';
import type { AuthorizationEvent } from '../domain/types.ts';
import { api, RemoteError } from './client.ts';
import { publish } from '../services/bus.ts';
import { engineResultOf, markRemote, recordDecision } from '../services/decisions.ts';
import { ensureLiveRun } from '../services/runs.ts';

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
export const validateEvent = ajv.compile(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'schemas', 'authorization_event.schema.json'), 'utf8')));

export const workerState = { running: false, lastPollAt: null as string | null, lastError: null as string | null, handled: 0 };

/** Handles one delivered envelope: decide (idempotently) and submit before the deadline. */
export async function handleEnvelope(envelope: any): Promise<void> {
  const event = envelope?.data as AuthorizationEvent;
  const valid = validateEvent(event);
  if (!valid) console.warn('[worker] event failed schema validation', ajv.errorsText(validateEvent.errors));
  const run = ensureLiveRun(envelope.run_id, event);
  const { record, duplicateDelivery } = recordDecision(event, run.id);
  if (duplicateDelivery && record.remote_submitted) return; // already answered
  const r = engineResultOf(record);
  try {
    await api(`/v1/authorizations/${encodeURIComponent(record.authorization_id)}/decision`, {
      method: 'POST',
      timeoutMs: Math.max(1000, Date.parse(event.deadline_at) - Date.now()),
      body: {
        authorization_id: record.authorization_id,
        decision: r.decision,
        reason_codes: r.reason_codes,
        customer_message: r.customer_message,
        evidence: r.evidence.slice(0, 10),
        engine_version: config.engineVersion,
      },
    });
    markRemote(record.authorization_id, true);
  } catch (e) {
    // 409 on a re-delivery means the platform already holds our answer.
    const already = e instanceof RemoteError && e.status === 409;
    markRemote(record.authorization_id, already, already ? undefined : String((e as Error).message));
  }
  workerState.handled++;
}

export async function startWorker(): Promise<void> {
  if (!liveEnabled() || workerState.running) return;
  workerState.running = true;
  publish({ type: 'worker', status: 'running' });
  console.log('[worker] long-polling', config.leashBaseUrl);
  while (workerState.running) {
    try {
      workerState.lastPollAt = new Date().toISOString();
      const res = await api('/v1/decision-requests/next?wait=25', { timeoutMs: 35_000 });
      if (res.status === 200 && res.data) void handleEnvelope(res.data).catch((e) => console.error('[worker]', e));
      workerState.lastError = null;
    } catch (e) {
      workerState.lastError = String((e as Error).message);
      publish({ type: 'worker', status: 'error', detail: workerState.lastError });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export function stopWorker() { workerState.running = false; }
