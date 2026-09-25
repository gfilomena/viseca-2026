import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, errorText } from '../../core/api.service';
import { LiveService } from '../../core/live.service';
import { ShopChatStore } from '../shop/shop.page';
import type { HardRule, Mandate, Scenario, UncertaintyPolicy } from '../../core/models';

// Human-readable labels for the engine's technical field names (see backend/src/policy/compiler.ts FIELDS).
const FIELD_LABELS: Record<string, string> = {
  'authorization.billing_amount_chf': 'Order amount',
  'derived.period_spend_chf': 'Spending in the window',
  'authorization.currency': 'Currency',
  'authorization.fulfillment_method': 'Fulfilment method',
  'authorization.return_window_days': 'Return window',
  'authorization.delivery_within_days': 'Delivery time',
  'authorization.local_hour': 'Time of day (Swiss hour)',
  'merchant.merchant_category': 'Shop category',
  'merchant.merchant_country': 'Shop country',
  'merchant.prior_approved_purchases': 'Prior approved purchases at this shop',
  'items.item_id': 'Specific items',
  'items.item_category': 'Item category',
  'items.attribute.size': 'Size',
  'items.quantity_total': 'Total quantity',
  'basket.unrequested_lines': 'Unrequested add-ons',
};

const OPERATOR_LABELS: Record<string, string> = {
  '<=': '≤', '>=': '≥', '<': '<', '>': '>', '=': '=', '!=': '≠', in: 'is one of', not_in: 'is none of',
};

/** "authorization.billing_amount_chf" -> "Order amount" for any field not in FIELD_LABELS. */
function humanizeField(field: string): string {
  const last = field.split('.').pop() ?? field;
  return last.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

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
  protected customers = signal<{ customer_id: string; persona_name: string; home_region: string }[]>([]);
  protected customerId = signal<string | null>(null);
  protected instruction = signal('');
  /** Rows of the policies table whose details are open. */
  protected expanded = signal<Set<string>>(new Set());
  protected draft = signal<Mandate | null>(null);
  protected busy = signal(false);
  protected error = signal<string | null>(null);

  protected customer = computed(() => this.customers().find((c) => c.customer_id === this.customerId()) ?? null);
  /** Only the selected customer's policies — the table follows the "For" dropdown. */
  protected active = computed(() => this.mandates().filter((m) => m.status === 'active' && m.customer_id === this.customerId())
    .sort((a, b) => (b.confirmed_at ?? '').localeCompare(a.confirmed_at ?? '')));
  protected revoked = computed(() => this.mandates().filter((m) => (m.status === 'revoked' || m.status === 'superseded') && m.customer_id === this.customerId())
    .sort((a, b) => (b.revoked_at ?? '').localeCompare(a.revoked_at ?? '')));
  /** Active policies on the same card as the draft: confirming the draft replaces them. */
  protected replaces = computed(() => {
    const d = this.draft();
    return d?.card_id ? this.mandates().filter((m) => m.status === 'active' && m.card_id === d.card_id && m.id !== d.id) : [];
  });

  // Per-mandate UI state for running and tightening.
  protected runScenario: Record<string, string> = {};
  /** '' = wait for a real answer (default); otherwise a demo/testing convenience — see ApiService.startRun. */
  protected runSimulateAnswer: Record<string, '' | 'approve' | 'decline'> = {};
  protected tightenOpen = signal<string | null>(null);
  protected tLimit: number | null = null;
  protected tBlock = '';
  protected tSwiss = false;
  protected tDecline = false;

  constructor() {
    this.api.scenarios().then((s) => this.scenarios.set(s)).catch(() => {});
    // Default to whoever is selected on the Shop page, so both pages talk about the same person.
    const shopFor = inject(ShopChatStore).customerId();
    this.api.customers().then((c) => {
      this.customers.set(c);
      this.customerId.set(c.some((x) => x.customer_id === shopFor) ? shopFor : c[0]?.customer_id ?? null);
    }).catch(() => {});
    effect(() => {
      const msg = this.live.last();
      if (!msg || msg.type === 'mandate') this.reload();
    });
  }

  private reload() {
    this.api.mandates().then((ms) => {
      for (const m of ms) this.runScenario[m.id] ??= m.scenario_id ?? this.scenarios().find((x) => x.card_id === m.card_id)?.scenario_id ?? 'SCEN0000';
      this.mandates.set(ms);
    }).catch((e) => this.error.set(errorText(e)));
  }

  protected pickCustomer(id: string) {
    this.customerId.set(id);
    this.draft.set(null);
  }

  protected toggle(id: string) {
    this.expanded.update((set) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.busy.set(true);
    this.error.set(null);
    try { return await fn(); } catch (e) { this.error.set(errorText(e)); return undefined; } finally { this.busy.set(false); }
  }

  protected interpret() {
    this.guard(async () => this.draft.set(await this.api.draft(this.instruction(), this.customerId() ?? undefined)));
  }

  protected isNumeric(rule: HardRule) { return typeof rule.value === 'number'; }
  protected valueText(rule: HardRule) { return Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value); }
  protected ruleCode(rule: HardRule) {
    const label = FIELD_LABELS[rule.field] ?? humanizeField(rule.field);
    const scoped = rule.scope === 'period' ? `Spending in any ${rule.period_days} days` : label;
    const op = OPERATOR_LABELS[rule.operator] ?? rule.operator;
    const value = rule.currency ? `${rule.currency} ${this.valueText(rule)}` : this.valueText(rule);
    return `${scoped} ${op} ${value}`;
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
      this.runScenario[m.id] = m.scenario_id ?? this.scenarios().find((x) => x.card_id === m.card_id)?.scenario_id ?? 'SCEN0000';
      this.instruction.set('');
      this.expanded.update((set) => new Set(set).add(m.id));
      this.reload();
    });
  }

  protected startRun(m: Mandate) {
    const scenario = this.runScenario[m.id] ?? m.scenario_id ?? 'SCEN0000';
    const simulate = this.runSimulateAnswer[m.id] || undefined;
    this.guard(async () => {
      const run = await this.api.startRun(scenario, m.id, simulate);
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
