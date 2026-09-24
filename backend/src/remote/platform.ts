import { config, liveEnabled } from '../config.ts';
import { getDb, packReport } from '../db/db.ts';
import { api } from './client.ts';
import { publish } from '../services/bus.ts';
import { setRunStatus, fetchRemoteAuthorizations, type PlatformAuthorization, type PlatformLister } from '../services/runs.ts';
import { PolicyError } from '../services/mandates.ts';

/**
 * What we know about the hosted platform: reachability, the settings it publishes in
 * /v1/bootstrap (human window, decision deadline) and whether its data pack matches ours.
 * The response shapes are not fully documented, so values are looked up by key name and
 * anything not found keeps our documented defaults (120 s human window, 8 s deadline).
 */
export interface PlatformState {
  checked_at: string | null;
  reachable: boolean | null;
  live: boolean;
  bootstrap_ok: boolean | null;
  human_window_seconds: number;
  human_window_source: 'default' | 'bootstrap';
  decision_deadline_seconds: number;
  decision_deadline_source: 'default' | 'bootstrap';
  /** features.reset from /v1/bootstrap: whether POST /v1/team/reset will work right now (off during judging). */
  reset_enabled: boolean | null;
  local_pack_version: string | null;
  remote_pack_version: string | null;
  pack_match: boolean | null;
  error: string | null;
}

export const platform: PlatformState = {
  checked_at: null, reachable: null, live: false, bootstrap_ok: null,
  human_window_seconds: config.humanWindowSeconds, human_window_source: 'default',
  decision_deadline_seconds: 8, decision_deadline_source: 'default', reset_enabled: null,
  local_pack_version: null, remote_pack_version: null, pack_match: null, error: null,
};

type Json = unknown;

/** Depth-first search for the first value whose key matches `key` and that passes `accept`. */
export function findValue(obj: Json, key: RegExp, accept: (v: unknown) => boolean): unknown {
  const seen = new Set<unknown>();
  const walk = (o: Json): unknown => {
    if (!o || typeof o !== 'object' || seen.has(o)) return undefined;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (key.test(k) && accept(v)) return v;
    }
    for (const v of Object.values(o as Record<string, unknown>)) {
      const hit = walk(v);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(obj);
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isStr = (v: unknown) => typeof v === 'string' && v.length > 0;
/** Values over 1000 are taken as milliseconds. */
const seconds = (v: number, key: string) => (/_ms$|millis/i.test(key) || v > 1000 ? Math.round(v / 1000) : v);

export function readBootstrap(data: Json): Partial<Pick<PlatformState, 'human_window_seconds' | 'decision_deadline_seconds' | 'remote_pack_version' | 'reset_enabled'>> {
  const out: Partial<PlatformState> = {};
  // The hosted API calls this "step_up_timeout_seconds" (its /resolve deadline); the challenge
  // guide calls the same thing the "human window" — match either name.
  const human = findValue(data, /human.*(window|timeout|seconds|ms)|(window|timeout).*human|step.?up.*(window|timeout|seconds|ms)/i, isNum) as number | undefined;
  if (human !== undefined) out.human_window_seconds = seconds(human, 'human');
  const deadline = findValue(data, /(decision|automated|deadline).*(deadline|timeout|seconds|ms)/i, isNum) as number | undefined;
  if (deadline !== undefined) out.decision_deadline_seconds = seconds(deadline, 'deadline');
  const pack = findValue(data, /^(pack_version|data_version|data_pack_version)$/i, isStr) as string | undefined;
  if (pack) out.remote_pack_version = pack;
  const reset = findValue(data, /^reset$/i, (v) => typeof v === 'boolean') as boolean | undefined;
  if (reset !== undefined) out.reset_enabled = reset;
  return out;
}

/** Health (public), then bootstrap and reference data when a team key is configured. */
export async function syncPlatform(): Promise<PlatformState> {
  platform.checked_at = new Date().toISOString();
  platform.live = liveEnabled();
  platform.local_pack_version = (packReport() as { pack_version?: string } | null)?.pack_version ?? null;
  platform.error = null;
  try {
    const res = await fetch(`${config.leashBaseUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    platform.reachable = res.ok;
    if (res.ok) {
      const health = await res.json();
      platform.remote_pack_version = (findValue(health, /^(pack_version|data_version)$/i, isStr) as string | undefined) ?? platform.remote_pack_version;
    }
  } catch (e) {
    platform.reachable = false;
    platform.error = `healthz: ${(e as Error).message}`;
  }

  if (liveEnabled()) {
    try {
      const boot = await api('/v1/bootstrap');
      const found = readBootstrap(boot.data);
      platform.bootstrap_ok = true;
      if (found.human_window_seconds) {
        platform.human_window_seconds = found.human_window_seconds;
        platform.human_window_source = 'bootstrap';
        config.humanWindowSeconds = found.human_window_seconds; // used for new step-ups
      }
      if (found.decision_deadline_seconds) {
        platform.decision_deadline_seconds = found.decision_deadline_seconds;
        platform.decision_deadline_source = 'bootstrap';
      }
      if (found.remote_pack_version) platform.remote_pack_version = found.remote_pack_version;
      if (found.reset_enabled !== undefined) platform.reset_enabled = found.reset_enabled;
      const ref = await api('/v1/reference-data').catch(() => null);
      const refPack = ref ? findValue(ref.data, /^(pack_version|data_version)$/i, isStr) as string | undefined : undefined;
      if (refPack) platform.remote_pack_version = refPack;
    } catch (e) {
      platform.bootstrap_ok = false;
      platform.error = `bootstrap: ${(e as Error).message}`;
    }
  }
  platform.pack_match = platform.remote_pack_version && platform.local_pack_version
    ? platform.remote_pack_version === platform.local_pack_version : null;
  if (platform.pack_match === false) {
    console.warn(`[platform] data pack mismatch: local ${platform.local_pack_version}, platform ${platform.remote_pack_version}`);
  }
  publish({ type: 'worker', status: 'platform' });
  return platform;
}

/** Decides whether a hosted run has finished from its progress response. */
export function runProgress(data: Json): 'running' | 'completed' | 'failed' {
  const status = String(findValue(data, /^(status|state)$/i, isStr) ?? '').toLowerCase();
  if (['completed', 'complete', 'finished', 'done', 'ended', 'closed'].includes(status)) return 'completed';
  if (['failed', 'error', 'cancelled', 'canceled', 'aborted'].includes(status)) return 'failed';
  const total = findValue(data, /^(event_count|events_total|total_events|total)$/i, isNum) as number | undefined;
  const done = findValue(data, /^(decided|completed|finalized|finalised|resolved|processed|events_done|done)(_count|_events)?$/i, (v) => typeof v === 'number') as number | undefined;
  const remaining = findValue(data, /^(remaining|pending|queued|outstanding)(_count|_events)?$/i, (v) => typeof v === 'number') as number | undefined;
  if (total !== undefined && done !== undefined && done >= total) return 'completed';
  if (total !== undefined && remaining === 0 && done !== undefined) return 'completed';
  return 'running';
}

let lastProgressCheck = 0;
/** Called by the worker when a poll returns 204: marks finished hosted runs as completed. */
export async function checkLiveRuns(force = false): Promise<void> {
  if (!liveEnabled() || (!force && Date.now() - lastProgressCheck < 15_000)) return;
  lastProgressCheck = Date.now();
  const runs = getDb().prepare("SELECT id, remote_run_id FROM runs WHERE mode = 'live' AND status = 'running' AND remote_run_id IS NOT NULL").all() as { id: string; remote_run_id: string }[];
  for (const r of runs) {
    try {
      const res = await api(`/v1/scenario-runs/${encodeURIComponent(r.remote_run_id)}`);
      const state = runProgress(res.data);
      if (state !== 'running') setRunStatus(r.id, state);
    } catch { /* try again on the next idle poll */ }
  }
}

function requireLive(): void {
  if (!liveEnabled()) throw new PolicyError('Live mode needs TEAM_API_KEY on the backend.', 400);
}

/**
 * GET /v1/reference-data: the platform's own catalogues (scenarios, fixed fx rates, and
 * history-file metadata per the technical guide) plus whatever else it publishes for the
 * team, returned as-is. This is the closest the hosted API has to a "products" endpoint —
 * the item/merchant catalogue itself is only shipped in the offline data pack.
 */
export async function fetchReferenceData(client: typeof api = api): Promise<unknown> {
  requireLive();
  return (await client('/v1/reference-data')).data;
}

/** GET /v1/mandates/{mandate_id}: re-reads a mandate straight from the platform (not our local copy). */
export async function getRemoteMandate(remoteMandateId: string, client: typeof api = api): Promise<unknown> {
  requireLive();
  return (await client(`/v1/mandates/${encodeURIComponent(remoteMandateId)}`)).data;
}

/** GET /v1/authorizations: every pending and final authorization the platform currently holds. */
export async function listPendingTransactions(lister: PlatformLister = fetchRemoteAuthorizations): Promise<PlatformAuthorization[]> {
  requireLive();
  return lister();
}

/** GET /v1/events?since=N: the team's event feed; pass back the returned next_cursor to page forward. */
export async function fetchEvents(since: number | string = 0, client: typeof api = api): Promise<{ events: unknown[]; next_cursor: unknown }> {
  requireLive();
  const res = await client(`/v1/events?since=${encodeURIComponent(String(since))}`);
  const d: any = res.data;
  const events = Array.isArray(d) ? d : Array.isArray(d?.events) ? d.events : Array.isArray(d?.data?.events) ? d.data.events : [];
  const next_cursor = d?.next_cursor ?? d?.data?.next_cursor ?? null;
  return { events, next_cursor };
}

/**
 * Development reset: clears the team's state on the platform, then the local mandates, runs
 * and decisions (reference data is kept). The platform disables its reset during judging and
 * refuses the call — that must never block the local clear, which stays useful on its own.
 */
export async function resetTeam(): Promise<{ platform: 'reset' | 'skipped' | 'failed'; platform_error: string | null; local: Record<string, number> }> {
  let remote: 'reset' | 'skipped' | 'failed' = 'skipped';
  let remoteError: string | null = null;
  if (liveEnabled()) {
    try { await api('/v1/team/reset', { method: 'POST', body: {} }); remote = 'reset'; }
    catch (e) { remote = 'failed'; remoteError = (e as Error).message; }
  }
  const db = getDb();
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const local = { decisions: count('decisions'), runs: count('runs'), mandates: count('mandates') };
  db.exec('BEGIN');
  db.exec('DELETE FROM decisions; DELETE FROM runs; DELETE FROM mandates;');
  db.exec('COMMIT');
  publish({ type: 'mandate', mandate_id: '*' });
  publish({ type: 'run', run_id: '*' });
  return { platform: remote, platform_error: remoteError, local };
}
