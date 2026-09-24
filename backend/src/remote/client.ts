import { config, liveEnabled } from '../config.ts';

export class RemoteError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`Leash API ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/** Minimal client for the hosted Agent-on-a-Leash API. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; data: T | null }> {
  if (!liveEnabled()) throw new RemoteError(0, { error: 'TEAM_API_KEY not configured' });
  const res = await fetch(`${config.leashBaseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${config.teamApiKey}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  if (res.status === 204) return { status: 204, data: null };
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new RemoteError(res.status, data);
  return { status: res.status, data };
}

/** Responses may wrap payloads in `data`; accept both shapes. */
export const unwrap = <T = any>(x: any): T => (x && typeof x === 'object' && 'data' in x && x.data && !('type' in x) ? x.data : x);

/**
 * /v1/authorizations/{id}/decision and /resolve both take `evidence` as a list of *objects*,
 * not plain strings (confirmed live: a bare string array 422s with "Input should be a valid
 * dictionary" on every entry). Our own evidence is plain sentences everywhere else in the app
 * (UI, tests); this is the one place that reshapes it for the wire.
 */
export const toRemoteEvidence = (items: string[]) => items.map((note) => ({ note }));
