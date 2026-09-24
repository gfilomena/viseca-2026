import { Component, DestroyRef, ElementRef, Injectable, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, errorText } from '../../core/api.service';
import { LiveService } from '../../core/live.service';
import { StepUpService } from '../../core/step-up.service';
import type { Check, DecisionRow, InterpretedRequest, Mandate, PurchaseOffer } from '../../core/models';

type ChatMessage =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'bot'; text: string; tone?: 'error' }
  | { id: number; kind: 'review'; data: InterpretedRequest; offer: PurchaseOffer; state: 'open' | 'sent' | 'cancelled' }
  | { id: number; kind: 'decision'; authorizationId: string };

/** Chat state lives in a root service so it survives navigating between pages. */
@Injectable({ providedIn: 'root' })
export class ShopChatStore {
  readonly messages = signal<ChatMessage[]>([]);
  readonly mandateId = signal<string | null>(null);
  private seq = 0;
  push(m: DistributiveOmit<ChatMessage, 'id'>) { this.messages.update((list) => [...list, { ...m, id: ++this.seq } as ChatMessage]); }
  update(id: number, patch: Partial<ChatMessage>) { this.messages.update((list) => list.map((m) => (m.id === id ? ({ ...m, ...patch } as ChatMessage) : m))); }
  clear() { this.messages.set([]); }
}
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

const DECISION_LABEL: Record<string, string> = { approve: 'Approved', decline: 'Declined', step_up: 'Asked you' };
const STATUS_LABEL: Record<string, string> = { approved: 'Paid', declined: 'Not paid', pending: 'Waiting for you', expired: 'Expired, not paid' };
const CHECK_ICON: Record<Check['status'], string> = { pass: '✓', fail: '✕', uncertain: '?', info: 'i' };

const SUGGESTIONS = [
  'Buy the 27-inch monitor at PixelHarbor for CHF 289',
  'Buy the 27-inch monitor at PixelHarbour for CHF 299',
  'Order a fresh produce selection at Alpine Basket for CHF 13',
  'Buy road-running shoes size 43 at TrailSpark for CHF 165',
  'Buy an everyday jacket at Loom and Pine for CHF 145',
  'Buy a digital gift voucher for CHF 195',
];

type Filter = 'all' | 'approve' | 'decline' | 'step_up';

@Component({
  selector: 'app-shop-page',
  imports: [FormsModule, RouterLink, CurrencyPipe, DatePipe, DecimalPipe],
  templateUrl: './shop.page.html',
  styleUrl: './shop.page.scss',
})
export class ShopPage {
  private api = inject(ApiService);
  private live = inject(LiveService);
  protected chat = inject(ShopChatStore);
  protected stepUps = inject(StepUpService);
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly suggestions = SUGGESTIONS;
  protected readonly decisionLabel = DECISION_LABEL;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly checkIcon = CHECK_ICON;

  protected mandates = signal<Mandate[]>([]);
  protected decisions = signal<Record<string, DecisionRow>>({});
  protected all = signal<DecisionRow[]>([]);
  protected filter = signal<Filter>('all');
  protected input = signal('');
  protected busy = signal(false);
  protected now = signal(Date.now());

  protected active = computed(() => this.mandates().filter((m) => m.status === 'active' && m.card_id));
  protected mandate = computed(() => this.active().find((m) => m.id === this.chat.mandateId()) ?? null);
  protected rows = computed(() => {
    const f = this.filter();
    return this.all().filter((r) => f === 'all' || r.engine_decision === f);
  });
  protected counts = computed(() => {
    const rows = this.all();
    return { all: rows.length, approve: rows.filter((r) => r.engine_decision === 'approve').length, decline: rows.filter((r) => r.engine_decision === 'decline').length, step_up: rows.filter((r) => r.engine_decision === 'step_up').length };
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    effect(() => {
      this.live.version();
      this.refresh();
    });
    // Keep the newest message in view.
    effect(() => {
      this.chat.messages();
      queueMicrotask(() => { const el = this.scroller()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; });
    });
  }

  private async refresh() {
    try {
      const [mandates, all] = await Promise.all([this.api.mandates(), this.api.decisions()]);
      this.mandates.set(mandates);
      this.all.set(all);
      const actives = mandates.filter((m) => m.status === 'active' && m.card_id);
      if (!actives.some((m) => m.id === this.chat.mandateId())) this.chat.mandateId.set(actives[0]?.id ?? null);
      // Refresh decisions shown in the chat (e.g. resolved elsewhere or expired).
      const map: Record<string, DecisionRow> = {};
      for (const r of all) map[r.authorization_id] = r;
      const shown = this.chat.messages().filter((m) => m.kind === 'decision').map((m) => (m as { authorizationId: string }).authorizationId);
      const prev = this.decisions();
      const next = { ...prev };
      for (const id of shown) {
        if (!map[id]) continue;
        next[id] = { ...next[id], ...map[id], checks: next[id]?.checks ?? map[id].checks };
        // Tell the story in the chat when a paused purchase gets its answer (modal, inbox or timeout).
        if (prev[id]?.status === 'pending' && map[id].status !== 'pending') this.chat.push({ kind: 'bot', text: this.outcomeText(map[id]) });
      }
      this.decisions.set(next);
    } catch { /* the header shows connectivity */ }
  }

  protected selectMandate(id: string) {
    this.chat.mandateId.set(id);
    const m = this.active().find((x) => x.id === id);
    if (m) this.chat.push({ kind: 'bot', text: `Now shopping under the policy “${m.instruction}”. Every purchase is checked against it.` });
  }

  protected useSuggestion(s: string) { this.input.set(s); }

  protected async send(box?: HTMLInputElement) {
    // Read the DOM value too: with fast typing the signal may lag one change detection behind.
    const text = (box?.value ?? this.input()).trim();
    const m = this.mandate();
    if (!text || !m || this.busy()) return;
    this.input.set('');
    if (box) box.value = '';
    this.chat.push({ kind: 'user', text });
    this.busy.set(true);
    try {
      const data = await this.api.interpret(m.id, text);
      this.chat.push({ kind: 'bot', text: data.item && data.merchant ? 'Here is the purchase I would make. If it is right, let me try to buy it.' : 'I could not work out the product or the shop. Please describe it again, e.g. “Buy the 27-inch monitor at PixelHarbor for CHF 289”.' });
      this.chat.push({ kind: 'review', data, offer: structuredClone(data.offer), state: 'open' });
    } catch (e) {
      this.chat.push({ kind: 'bot', text: errorText(e), tone: 'error' });
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(msg: ChatMessage) {
    this.chat.update(msg.id, { state: 'cancelled' } as Partial<ChatMessage>);
    this.chat.push({ kind: 'bot', text: 'OK, nothing was bought.' });
  }

  protected async tryToBuy(msg: Extract<ChatMessage, { kind: 'review' }>) {
    const m = this.mandate();
    if (!m || this.busy()) return;
    this.busy.set(true);
    try {
      const d = await this.api.buy(m.id, { ...msg.offer, quantity: Number(msg.offer.quantity), unit_price_chf: Number(msg.offer.unit_price_chf), delivery_fee_chf: Number(msg.offer.delivery_fee_chf) });
      this.chat.update(msg.id, { state: 'sent' } as Partial<ChatMessage>);
      this.decisions.update((all) => ({ ...all, [d.authorization_id]: d }));
      this.chat.push({ kind: 'decision', authorizationId: d.authorization_id });
      this.refresh();
    } catch (e) {
      this.chat.push({ kind: 'bot', text: errorText(e), tone: 'error' });
    } finally {
      this.busy.set(false);
    }
  }

  protected decideNow(id: string) { this.stepUps.open(id); }

  private outcomeText(d: DecisionRow) {
    if (d.status === 'approved') return `You approved it: ${d.merchant_name} is paid ${d.billing_amount_chf.toFixed(2)} CHF.`;
    if (d.status === 'expired') return 'No answer in time, so nothing was paid.';
    return d.resolved_by === 'revocation' ? 'Declined: you revoked the wallet policy.' : 'You declined it: nothing was paid.';
  }

  protected newChat() { this.chat.clear(); }

  // ---- helpers for the template ------------------------------------------
  protected total(o: PurchaseOffer) { return (Number(o.unit_price_chf) || 0) * (Number(o.quantity) || 0) + (Number(o.delivery_fee_chf) || 0); }
  protected secondsLeft(d: DecisionRow) {
    return d.human_deadline_at ? Math.max(0, Math.round((Date.parse(d.human_deadline_at) - this.now()) / 1000)) : null;
  }
  protected important(d: DecisionRow) { return d.checks.filter((c) => c.status === 'fail' || c.status === 'uncertain'); }
  protected summary(d: DecisionRow) {
    const i = this.important(d);
    return i.length ? i.map((c) => c.label).join(' · ') : 'All checks passed';
  }
  protected source(d: DecisionRow) {
    return d.run_mode === 'sandbox' ? 'Chat' : d.run_mode === 'live' ? `Simulator · ${d.scenario_id}` : `Replay · ${d.scenario_id}`;
  }
  protected asReview(m: ChatMessage) { return m as Extract<ChatMessage, { kind: 'review' }>; }
  protected asDecision(m: ChatMessage) { return this.decisions()[(m as Extract<ChatMessage, { kind: 'decision' }>).authorizationId] ?? null; }
}
