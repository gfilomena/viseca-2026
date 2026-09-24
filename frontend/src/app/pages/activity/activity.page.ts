import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, errorText } from '../../core/api.service';
import { LiveService } from '../../core/live.service';
import { StepUpService } from '../../core/step-up.service';
import type { Check, DecisionRow, Run } from '../../core/models';

const DECISION_LABEL: Record<string, string> = { approve: 'Approved', decline: 'Declined', step_up: 'Asked you' };
const STATUS_LABEL: Record<string, string> = { approved: 'Paid', declined: 'Not paid', pending: 'Waiting for you', expired: 'Expired, not paid' };
const CHECK_ICON: Record<Check['status'], string> = { pass: '✓', fail: '✕', uncertain: '?', info: 'i' };

@Component({
  selector: 'app-activity-page',
  imports: [FormsModule, DatePipe, DecimalPipe, CurrencyPipe],
  templateUrl: './activity.page.html',
  styleUrl: './activity.page.scss',
})
export class ActivityPage {
  private api = inject(ApiService);
  private live = inject(LiveService);
  private router = inject(Router);
  protected stepUps = inject(StepUpService);

  /** Bound from ?run= */
  readonly run = input<string | undefined>();

  protected readonly decisionLabel = DECISION_LABEL;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly checkIcon = CHECK_ICON;

  protected runs = signal<Run[]>([]);
  protected runId = signal<string | null>(null);
  protected rows = signal<DecisionRow[]>([]);
  protected pending = signal<DecisionRow[]>([]);
  protected selected = signal<DecisionRow | null>(null);
  protected error = signal<string | null>(null);
  protected now = signal(Date.now());

  protected currentRun = computed(() => this.runs().find((r) => r.id === this.runId()) ?? null);
  protected stats = computed(() => {
    const rows = this.rows();
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    const spend = rows.filter((r) => r.status === 'approved').reduce((s, r) => s + r.billing_amount_chf, 0);
    const lat = rows.length ? rows.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / rows.length : 0;
    const auto = rows.filter((r) => r.engine_decision === 'approve').length;
    return { total: rows.length, approved: by('approved'), declined: by('declined') + by('expired'), pending: by('pending'), spend, lat, auto };
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    effect(() => {
      const fromUrl = this.run();
      if (fromUrl) this.runId.set(fromUrl);
    });
    effect(() => {
      this.live.version();
      this.refresh();
    });
  }

  private async refresh() {
    try {
      const [runs, pending] = await Promise.all([this.api.runs(), this.api.decisions({ status: 'pending' })]);
      this.runs.set(runs);
      this.pending.set(pending);
      if (!this.runId() && runs.length) this.runId.set(runs[0].id);
      const id = this.runId();
      if (id) this.rows.set((await this.api.decisions({ run_id: id })).sort((a, b) => a.replay_order - b.replay_order || a.created_at.localeCompare(b.created_at)));
      const sel = this.selected();
      if (sel) this.selected.set(await this.api.decision(sel.authorization_id));
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  protected selectRun(id: string) {
    this.runId.set(id);
    this.selected.set(null);
    this.router.navigate([], { queryParams: { run: id }, replaceUrl: true });
    this.refresh();
  }

  protected async open(row: DecisionRow) {
    this.selected.set(await this.api.decision(row.authorization_id));
  }

  protected secondsLeft(row: DecisionRow) {
    if (!row.human_deadline_at) return null;
    return Math.max(0, Math.round((Date.parse(row.human_deadline_at) - this.now()) / 1000));
  }

  protected summary(row: DecisionRow) {
    const important = row.checks.filter((c) => c.status === 'fail' || c.status === 'uncertain');
    return important.length ? important.map((c) => c.label).join(' · ') : 'All checks passed';
  }

  protected hasInjection(row: DecisionRow) { return row.checks.some((c) => c.id === 'injection'); }
  protected checksOf(row: DecisionRow, kind: Check['status']) { return row.checks.filter((c) => c.status === kind); }
}
