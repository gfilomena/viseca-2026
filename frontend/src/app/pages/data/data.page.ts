import { Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, JsonPipe, KeyValuePipe } from '@angular/common';
import { ApiService, errorText } from '../../core/api.service';
import type { CardProfile, Health, Scenario } from '../../core/models';

@Component({
  selector: 'app-data-page',
  imports: [DatePipe, DecimalPipe, JsonPipe, KeyValuePipe],
  templateUrl: './data.page.html',
  styleUrl: './data.page.scss',
})
export class DataPage {
  private api = inject(ApiService);
  protected health = signal<Health | null>(null);
  protected scenarios = signal<Scenario[]>([]);
  protected scenarioId = signal<string | null>(null);
  protected attempts = signal<Record<string, any>[]>([]);
  protected profile = signal<CardProfile | null>(null);
  protected error = signal<string | null>(null);
  protected notice = signal<string | null>(null);
  protected busy = signal(false);

  // Hosted-API pass-throughs.
  protected liveReferenceData = signal<unknown>(null);
  protected livePending = signal<Record<string, unknown>[] | null>(null);
  protected liveBusy = signal(false);

  constructor() {
    this.api.health().then((h) => this.health.set(h)).catch((e) => this.error.set(errorText(e)));
    this.api.scenarios().then((s) => { this.scenarios.set(s); if (s[0]) this.pick(s[0]); });
  }

  protected async syncPlatform() {
    this.busy.set(true);
    try {
      const platform = await this.api.syncPlatform();
      this.health.update((h) => (h ? { ...h, platform } : h));
    } catch (e) { this.error.set(errorText(e)); } finally { this.busy.set(false); }
  }

  protected async reset() {
    if (!confirm('Reset team data? This deletes all wallet policies, runs and decisions (and resets the team on the hosted platform when possible). The data pack stays.')) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.api.resetTeam();
      const platformNote = r.platform === 'reset' ? 'platform reset too'
        : r.platform === 'failed' ? `platform reset failed (${r.platform_error ?? 'disabled during judging?'}) — local data was still cleared`
          : 'no team key: local only';
      this.notice.set(`Reset done: ${r.local['mandates']} policies, ${r.local['runs']} runs, ${r.local['decisions']} decisions removed; ${platformNote}.`);
    } catch (e) { this.error.set(errorText(e)); } finally { this.busy.set(false); }
  }

  protected async loadReferenceData() {
    this.liveBusy.set(true);
    this.error.set(null);
    try { this.liveReferenceData.set(await this.api.liveReferenceData()); } catch (e) { this.error.set(errorText(e)); } finally { this.liveBusy.set(false); }
  }

  protected async loadPendingTransactions() {
    this.liveBusy.set(true);
    this.error.set(null);
    try { this.livePending.set(await this.api.livePendingTransactions()); } catch (e) { this.error.set(errorText(e)); } finally { this.liveBusy.set(false); }
  }

  /**
   * A few well-known fields for the table, given as dotted paths (e.g. "authorization.merchant.merchant_name").
   * The platform nests most purchase facts under `authorization`; a couple of fields (id, status)
   * sit at the top level instead — try each candidate path in order.
   */
  protected pendingField(row: Record<string, unknown>, ...paths: string[]): unknown {
    for (const path of paths) {
      let v: unknown = row;
      for (const key of path.split('.')) v = (v as Record<string, unknown> | undefined)?.[key];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  protected async pick(s: Scenario) {
    this.scenarioId.set(s.scenario_id);
    try {
      const [attempts, profile] = await Promise.all([this.api.attempts(s.scenario_id), this.api.cardProfile(s.card_id)]);
      this.attempts.set(attempts);
      this.profile.set(profile);
    } catch (e) { this.error.set(errorText(e)); }
  }
}
