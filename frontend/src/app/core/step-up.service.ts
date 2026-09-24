import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorText } from './api.service';
import { LiveService } from './live.service';
import type { DecisionRow } from './models';

/**
 * Every purchase paused for the customer (step_up) needs an explicit answer.
 * This service keeps the queue of pending purchases, oldest first, and drives the
 * global approve/decline modal. "Later" only hides one purchase from the modal; it
 * stays pending (and in the inbox) until the customer answers or the window expires.
 * An unanswered purchase is never approved.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  private api = inject(ApiService);
  private live = inject(LiveService);

  readonly pending = signal<DecisionRow[]>([]);
  private readonly later = signal<Set<string>>(new Set());
  /** Full record (with the cart) of the purchase in the modal. */
  readonly detail = signal<DecisionRow | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** A purchase the customer explicitly asked to see (e.g. "Decide now" in the chat). */
  private readonly focus = signal<string | null>(null);
  readonly current = computed(() => {
    const open = this.pending().filter((p) => !this.later().has(p.authorization_id));
    return open.find((p) => p.authorization_id === this.focus()) ?? open[0] ?? null;
  });
  readonly queued = computed(() => this.pending().filter((p) => !this.later().has(p.authorization_id)).length);

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
      // Forget "later" for purchases that are no longer pending.
      const ids = new Set(rows.map((r) => r.authorization_id));
      this.later.update((s) => new Set([...s].filter((id) => ids.has(id))));
    } catch { /* connectivity is shown in the header */ }
  }

  /** Bring a pending purchase (back) into the modal, in front of the queue. */
  open(authorizationId: string) {
    this.later.update((s) => { const n = new Set(s); n.delete(authorizationId); return n; });
    this.focus.set(authorizationId);
    if (!this.pending().some((p) => p.authorization_id === authorizationId)) void this.refresh();
  }

  postpone(authorizationId: string) {
    this.later.update((s) => new Set(s).add(authorizationId));
  }

  async resolve(authorizationId: string, decision: 'approve' | 'decline', note?: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.resolve(authorizationId, decision, note);
      this.pending.update((list) => list.filter((p) => p.authorization_id !== authorizationId));
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
