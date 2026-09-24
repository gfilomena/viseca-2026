import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { CardProfile, DecisionRow, HardRule, Health, InterpretedRequest, Mandate, PlatformState, PurchaseOffer, Run, Scenario, ShopOptions, UncertaintyPolicy } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private get = <T>(url: string) => firstValueFrom(this.http.get<T>(`/api${url}`));
  private send = <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    firstValueFrom(this.http.request<T>(method, `/api${url}`, { body }));

  health = () => this.get<Health>('/health');
  syncPlatform = () => this.send<PlatformState>('POST', '/platform/sync');
  resetTeam = () => this.send<{ platform: 'reset' | 'skipped' | 'failed'; platform_error: string | null; local: Record<string, number> }>('POST', '/team/reset');
  scenarios = () => this.get<Scenario[]>('/scenarios');
  customers = () => this.get<{ customer_id: string; persona_name: string; home_region: string }[]>('/customers');
  attempts = (scenarioId: string) => this.get<Record<string, unknown>[]>(`/scenarios/${scenarioId}/attempts`);
  cardProfile = (cardId: string) => this.get<CardProfile>(`/cards/${cardId}/profile`);

  mandates = () => this.get<Mandate[]>('/mandates');
  draft = (instruction: string, customer_id?: string) => this.send<Mandate>('POST', '/mandates', { instruction, customer_id });
  editDraft = (id: string, patch: { hard_rules?: HardRule[]; uncertainty_policy?: UncertaintyPolicy }) => this.send<Mandate>('PUT', `/mandates/${id}/draft`, patch);
  confirm = (id: string) => this.send<Mandate>('POST', `/mandates/${id}/confirm`);
  tighten = (id: string, patch: { add_rules?: HardRule[]; uncertainty_policy?: UncertaintyPolicy }) => this.send<Mandate>('PATCH', `/mandates/${id}`, patch);
  revoke = (id: string) => this.send<Mandate>('DELETE', `/mandates/${id}`);

  runs = () => this.get<Run[]>('/runs');
  startRun = (scenario_id: string, mandate_id: string, mode: 'offline' | 'live') => this.send<Run>('POST', '/runs', { scenario_id, mandate_id, mode });
  decisions = (q: { run_id?: string; status?: string } = {}) =>
    this.get<DecisionRow[]>(`/decisions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`);
  decision = (id: string) => this.get<DecisionRow>(`/decisions/${encodeURIComponent(id)}`);
  shopOptions = (mandateId: string) => this.get<ShopOptions>(`/shop/options?mandate_id=${encodeURIComponent(mandateId)}`);
  interpret = (mandate_id: string, text: string) => this.send<InterpretedRequest>('POST', '/shop/interpret', { mandate_id, text });
  buy = (mandate_id: string, offer: PurchaseOffer) => this.send<DecisionRow>('POST', '/shop/buy', { mandate_id, offer });

  resolve = (id: string, decision: 'approve' | 'decline', note?: string) => this.send<DecisionRow>('POST', `/decisions/${encodeURIComponent(id)}/resolve`, { decision, note });

  // Hosted-API pass-throughs (live mode only: needs TEAM_API_KEY on the backend).
  liveReferenceData = () => this.get<unknown>('/live/reference-data');
  livePendingTransactions = () => this.get<Record<string, unknown>[]>('/live/authorizations');
  liveEvents = (since: number | string = 0) => this.get<{ events: unknown[]; next_cursor: unknown }>(`/live/events?since=${encodeURIComponent(String(since))}`);
  liveMandate = (remoteMandateId: string) => this.get<unknown>(`/live/mandates/${encodeURIComponent(remoteMandateId)}`);
}

export function errorText(e: unknown): string {
  const any = e as { error?: { error?: string }; message?: string };
  return any?.error?.error ?? any?.message ?? 'Something went wrong';
}
