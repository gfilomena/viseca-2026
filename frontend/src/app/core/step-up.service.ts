import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorText } from './api.service';
import { LiveService } from './live.service';
import type { DecisionRow } from './models';

/**
 * Every purchase paused for the customer (step_up) needs an explicit answer within
 * the 120s window (server-enforced: config.humanWindowSeconds). This service keeps
 * the pending purchases (for the header badge) and drives the approve/decline modal.
 * The modal opens on its own for any pending purchase the customer hasn't already
 * dismissed — like a payment-approval push notification — so a step_up is never
 * missed just because the customer didn't go looking for it. Closing it without
 * answering leaves the purchase pending (dismissed ones don't reopen themselves,
 * but stay visible in the pending lists) until it is answered or the window expires;
 * an unanswered purchase is never approved — the backend expires it automatically.
 *
 * When the tab isn't in the foreground, a newly-surfaced step-up also fires a browser
 * Notification (permission permitting) — the same "your bank needs you" alert a native
 * wallet app would show. Clicking it focuses the tab, where the modal is already open.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  private api = inject(ApiService);
  private live = inject(LiveService);
  private notifyPermissionAsked = false;

  readonly pending = signal<DecisionRow[]>([]);
  /** Full record (with the cart) of the purchase in the modal. */
  readonly detail = signal<DecisionRow | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** The purchase shown in the modal; open for any pending item until closed. */
  private readonly focus = signal<string | null>(null);
  /** Purchases the customer closed without answering: won't auto-reopen, but stay pending. */
  private readonly dismissed = new Set<string>();
  readonly current = computed(() => this.pending().find((p) => p.authorization_id === this.focus()) ?? null);

  constructor() {
    effect(() => {
      this.live.version();
      this.refresh();
    });
    // Load the cart and shop text for whatever the modal shows.
    effect(() => {
      const id = this.current()?.authorization_id;
      if (untracked(() => this.detail()?.authorization_id) === id) return;
      untracked(() => this.error.set(null));
      if (!id) { this.detail.set(null); return; }
      this.api.decision(id).then((d) => { if (this.current()?.authorization_id === id) this.detail.set(d); }).catch(() => {});
    });
  }

  async refresh() {
    try {
      const rows = await this.api.decisions({ status: 'pending' });
      const sorted = rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
      this.pending.set(sorted);
      // Surface the modal on its own for the oldest pending purchase not already dismissed,
      // unless one is already open — never interrupt an answer in progress.
      if (!this.focus()) {
        const next = sorted.find((p) => !this.dismissed.has(p.authorization_id));
        if (next) { this.focus.set(next.authorization_id); this.notify(next); }
      }
    } catch { /* connectivity is shown in the header */ }
  }

  /** Fire a browser Notification for a step-up while the tab is backgrounded; the modal already covers the foreground case. */
  private notify(row: DecisionRow) {
    if (typeof Notification === 'undefined' || document.visibilityState === 'visible') return;
    const fire = () => {
      const n = new Notification('Approval needed', {
        body: `Pay CHF ${row.billing_amount_chf.toFixed(2)} to ${row.merchant_name}?`,
        icon: '/favicon.ico',
        tag: row.authorization_id, // replaces any stale notification for the same purchase instead of stacking
      });
      n.onclick = () => { window.focus(); n.close(); };
    };
    if (Notification.permission === 'granted') fire();
    else if (Notification.permission === 'default' && !this.notifyPermissionAsked) {
      this.notifyPermissionAsked = true;
      Notification.requestPermission().then((p) => { if (p === 'granted') fire(); });
    }
  }

  /** Open the modal for a pending purchase (auto-surfaced, or the customer clicked one). */
  open(authorizationId: string) {
    this.error.set(null);
    this.dismissed.delete(authorizationId);
    this.focus.set(authorizationId);
    if (!this.pending().some((p) => p.authorization_id === authorizationId)) void this.refresh();
  }

  /** Closing without answering marks it dismissed so it won't reopen itself; it stays pending. */
  close() {
    const id = this.focus();
    if (id) this.dismissed.add(id);
    this.focus.set(null);
  }

  isPending(authorizationId: string) {
    return this.pending().some((p) => p.authorization_id === authorizationId);
  }

  async resolve(authorizationId: string, decision: 'approve' | 'decline', note?: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.resolve(authorizationId, decision, note);
      this.pending.update((list) => list.filter((p) => p.authorization_id !== authorizationId));
      this.dismissed.delete(authorizationId);
      this.focus.set(null);
      await this.refresh();
      return true;
    } catch (e) {
      this.error.set(errorText(e));
      await this.refresh();
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
