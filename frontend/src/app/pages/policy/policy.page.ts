import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, errorText } from '../../core/api.service';
import { LiveService } from '../../core/live.service';
import type { HardRule, Mandate, Scenario, UncertaintyPolicy } from '../../core/models';

const UNCERTAINTY: { value: UncertaintyPolicy; label: string; help: string }[] = [
  { value: 'ask', label: 'Ask me', help: 'Pause the purchase and ask you to approve or decline it.' },
  { value: 'decline', label: 'Decline', help: 'Stop the purchase automatically whenever something is unclear.' },
  { value: 'approve', label: 'Approve', help: 'Let it through and tell you afterwards. Least safe.' },
];

@Component({
  selector: 'app-policy-page',
  imports: [FormsModule, DatePipe],
  templateUrl: './policy.page.html',
  styleUrl: './policy.page.scss',
})
export class PolicyPage {
  private api = inject(ApiService);
  private live = inject(LiveService);
  private router = inject(Router);

  protected readonly uncertaintyOptions = UNCERTAINTY;
  protected scenarios = signal<Scenario[]>([]);
  protected mandates = signal<Mandate[]>([]);
  protected liveApi = signal(false);
  protected scenarioId = signal<string>('SCEN0000');
  protected instruction = signal('');
  protected draft = signal<Mandate | null>(null);
  protected busy = signal(false);
  protected error = signal<string | null>(null);

  protected selectedScenario = computed(() => this.scenarios().find((s) => s.scenario_id === this.scenarioId()));
  protected active = computed(() => this.mandates().filter((m) => m.status === 'active'));
  protected revoked = computed(() => this.mandates().filter((m) => m.status === 'revoked' || m.status === 'superseded'));
  /** Active policies on the same card as the draft: confirming the draft replaces them. */
  protected replaces = computed(() => {
    const d = this.draft();
    return d?.card_id ? this.mandates().filter((m) => m.status === 'active' && m.card_id === d.card_id && m.id !== d.id) : [];
  });

  // Per-mandate UI state for running and tightening.
  protected runScenario: Record<string, string> = {};
  protected runMode: Record<string, 'offline' | 'live'> = {};
  protected tightenOpen = signal<string | null>(null);
  protected tLimit: number | null = null;
  protected tBlock = '';
  protected tSwiss = false;
  protected tDecline = false;

  constructor() {
    this.api.scenarios().then((s) => {
      this.scenarios.set(s);
      this.pickScenario(s[0]?.scenario_id ?? 'SCEN0000');
    });
    this.api.health().then((h) => this.liveApi.set(h.live)).catch(() => {});
    effect(() => {
      const msg = this.live.last();
      if (!msg || msg.type === 'mandate') this.reload();
    });
  }

  private reload() {
    this.api.mandates().then((ms) => {
      for (const m of ms) this.runScenario[m.id] ??= m.scenario_id ?? 'SCEN0000';
      this.mandates.set(ms);
    }).catch((e) => this.error.set(errorText(e)));
  }

  protected pickScenario(id: string) {
    this.scenarioId.set(id);
    const s = this.scenarios().find((x) => x.scenario_id === id);
    if (s) this.instruction.set(s.cardholder_instruction);
    this.draft.set(null);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.busy.set(true);
    this.error.set(null);
    try { return await fn(); } catch (e) { this.error.set(errorText(e)); return undefined; } finally { this.busy.set(false); }
  }

  protected interpret() {
    this.guard(async () => this.draft.set(await this.api.draft(this.instruction(), this.scenarioId())));
  }

  protected isNumeric(rule: HardRule) { return typeof rule.value === 'number'; }
  protected valueText(rule: HardRule) { return Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value); }
  protected ruleCode(rule: HardRule) {
    const extra = [rule.scope === 'period' ? `${rule.period_days}d window` : '', rule.currency ?? ''].filter(Boolean).join(' · ');
    return `${rule.field} ${rule.operator} ${this.valueText(rule)}${extra ? ` (${extra})` : ''}`;
  }

  protected updateRuleValue(index: number, raw: string) {
    const d = this.draft();
    if (!d) return;
    const rules = d.hard_rules.map((r, i) => {
      if (i !== index) return r;
      const value = typeof r.value === 'number' ? Number(raw) : Array.isArray(r.value) ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw.trim();
      return { ...r, value };
    });
    this.guard(async () => this.draft.set(await this.api.editDraft(d.id, { hard_rules: rules })));
  }

  protected removeRule(index: number) {
    const d = this.draft();
    if (!d) return;
    this.guard(async () => this.draft.set(await this.api.editDraft(d.id, { hard_rules: d.hard_rules.filter((_, i) => i !== index) })));
  }

  protected setUncertainty(policy: UncertaintyPolicy) {
    const d = this.draft();
    if (!d) return;
    this.guard(async () => this.draft.set(await this.api.editDraft(d.id, { uncertainty_policy: policy })));
  }

  protected confirm() {
    const d = this.draft();
    if (!d) return;
    const replacing = this.replaces();
    if (replacing.length && !confirm(`Confirming replaces the active policy for card ${d.card_id}. The old one is withdrawn and purchases waiting under it are declined. Continue?`)) return;
    this.guard(async () => {
      const m = await this.api.confirm(d.id);
      this.draft.set(null);
      this.runScenario[m.id] = m.scenario_id ?? this.scenarioId();
      this.reload();
    });
  }

  protected startRun(m: Mandate) {
    const scenario = this.runScenario[m.id] ?? m.scenario_id ?? this.scenarioId();
    const mode = this.runMode[m.id] ?? (this.liveApi() && m.remote_mandate_id ? 'live' : 'offline');
    this.guard(async () => {
      const run = await this.api.startRun(scenario, m.id, mode);
      await this.router.navigate(['/activity'], { queryParams: { run: run.id } });
    });
  }

  protected openTighten(m: Mandate) {
    this.tightenOpen.set(this.tightenOpen() === m.id ? null : m.id);
    const current = m.hard_rules.filter((r) => r.field === 'authorization.billing_amount_chf' && r.scope !== 'period').map((r) => Number(r.value));
    this.tLimit = current.length ? Math.min(...current) : null;
    this.tBlock = '';
    this.tSwiss = false;
    this.tDecline = false;
  }

  protected applyTighten(m: Mandate) {
    const add: HardRule[] = [];
    const current = m.hard_rules.filter((r) => r.field === 'authorization.billing_amount_chf' && r.scope !== 'period').map((r) => Number(r.value));
    const currentMin = current.length ? Math.min(...current) : Infinity;
    if (this.tLimit != null && this.tLimit > 0 && this.tLimit < currentMin) {
      add.push({ field: 'authorization.billing_amount_chf', operator: '<=', value: this.tLimit, currency: 'CHF', scope: 'purchase' });
    }
    const blocked = this.tBlock.split(',').map((s) => s.trim()).filter(Boolean);
    if (blocked.length) add.push({ field: 'items.item_category', operator: 'not_in', value: blocked });
    if (this.tSwiss) add.push({ field: 'merchant.merchant_country', operator: 'in', value: ['CH'] });
    const patch = { add_rules: add, uncertainty_policy: this.tDecline ? ('decline' as const) : undefined };
    this.guard(async () => {
      await this.api.tighten(m.id, patch);
      this.tightenOpen.set(null);
      this.reload();
    });
  }

  protected revoke(m: Mandate) {
    if (!confirm('Revoke this wallet policy? The agent loses permission to spend, and purchases waiting for you are declined.')) return;
    this.guard(async () => { await this.api.revoke(m.id); this.reload(); });
  }

  protected fromModel(source: string) { return source.startsWith('model:'); }

  protected uncertaintyLabel(p: UncertaintyPolicy) { return UNCERTAINTY.find((u) => u.value === p)?.label ?? p; }
}
