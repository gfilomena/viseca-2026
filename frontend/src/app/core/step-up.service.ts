import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorText } from './api.service';
import { LiveService } from './live.service';
import type { DecisionRow } from './models';

/**
 * Every purchase paused for the customer (step_up) needs an explicit answer.
 * This service keeps the pending purchases (for the header badge) and drives the
 * approve/decline modal, which opens only when the customer clicks a pending
 * transaction. Closing it leaves the purchase pending until it is answered or the
 * window expires; an unanswered purchase is never approved.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  private api = inject(ApiService);
  private live = inject(LiveService);

  readonly pending = signal<DecisionRow[]>([]);
  /** Full record (with the cart) of the purchase in the modal. */
  readonly detail = signal<DecisionRow | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** The purchase the customer clicked; the modal is open while it is still pending. */
  private readonly focus = signal<string | null>(null);
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
      this.pending.set(rows.sort((a, b) => a.created_at.localeCompare(b.created_at)));
    } catch { /* connectivity is shown in the header */ }
  }

  /** Open the modal for a pending purchase the customer clicked. */
  open(authorizationId: string) {
    this.error.set(null);
    this.focus.set(authorizationId);
    if (!this.pending().some((p) => p.authorization_id === authorizationId)) void this.refresh();
  }

  close() {
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
      this.close();
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
