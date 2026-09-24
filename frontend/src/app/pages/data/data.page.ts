import { Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, KeyValuePipe } from '@angular/common';
import { ApiService, errorText } from '../../core/api.service';
import type { CardProfile, Health, Scenario } from '../../core/models';

@Component({
  selector: 'app-data-page',
  imports: [DatePipe, DecimalPipe, KeyValuePipe],
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

  constructor() {
    this.api.health().then((h) => this.health.set(h)).catch((e) => this.error.set(errorText(e)));
    this.api.scenarios().then((s) => { this.scenarios.set(s); if (s[0]) this.pick(s[0]); });
  }

  protected async reset() {
    if (!confirm('Reset team data? This deletes all wallet policies, runs and decisions. The data pack stays.')) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.api.resetTeam();
      this.notice.set(`Reset done: ${r.local['mandates']} policies, ${r.local['runs']} runs, ${r.local['decisions']} decisions removed.`);
    } catch (e) { this.error.set(errorText(e)); } finally { this.busy.set(false); }
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
