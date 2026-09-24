import { config, liveEnabled } from '../config.ts';
import { getDb, packReport } from '../db/db.ts';
import { api } from './client.ts';
import { publish } from '../services/bus.ts';
import { setRunStatus } from '../services/runs.ts';

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
  local_pack_version: string | null;
  remote_pack_version: string | null;
  pack_match: boolean | null;
  error: string | null;
}

export const platform: PlatformState = {
  checked_at: null, reachable: null, live: false, bootstrap_ok: null,
  human_window_seconds: config.humanWindowSeconds, human_window_source: 'default',
  decision_deadline_seconds: 8, decision_deadline_source: 'default',
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

export function readBootstrap(data: Json): Partial<Pick<PlatformState, 'human_window_seconds' | 'decision_deadline_seconds' | 'remote_pack_version'>> {
  const out: Partial<PlatformState> = {};
  const human = findValue(data, /human.*(window|timeout|seconds|ms)|(window|timeout).*human/i, isNum) as number | undefined;
  if (human !== undefined) out.human_window_seconds = seconds(human, 'human');
  const deadline = findValue(data, /(decision|automated|deadline).*(deadline|timeout|seconds|ms)/i, isNum) as number | undefined;
  if (deadline !== undefined) out.decision_deadline_seconds = seconds(deadline, 'deadline');
  const pack = findValue(data, /^(pack_version|data_version|data_pack_version)$/i, isStr) as string | undefined;
  if (pack) out.remote_pack_version = pack;
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

/**
 * Development reset: clears the team's state on the platform (disabled during judging,
 * the platform then refuses and nothing local is touched) and the local mandates, runs
 * and decisions. Reference data is kept.
 */
export async function resetTeam(): Promise<{ platform: 'reset' | 'skipped'; local: Record<string, number> }> {
  let remote: 'reset' | 'skipped' = 'skipped';
  if (liveEnabled()) {
    await api('/v1/team/reset', { method: 'POST', body: {} });
    remote = 'reset';
  }
  const db = getDb();
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const local = { decisions: count('decisions'), runs: count('runs'), mandates: count('mandates') };
  db.exec('BEGIN');
  db.exec('DELETE FROM decisions; DELETE FROM runs; DELETE FROM mandates;');
  db.exec('COMMIT');
  publish({ type: 'mandate', mandate_id: '*' });
  publish({ type: 'run', run_id: '*' });
  return { platform: remote, local };
}
