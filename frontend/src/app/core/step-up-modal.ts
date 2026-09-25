import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StepUpService } from './step-up.service';

/**
 * Global modal for purchases paused by wallet control (step_up). It shows why the
 * purchase was paused and what exactly would be bought, and asks the customer to
 * approve or decline within the countdown (`human_deadline_at`, 120s). It opens on
 * its own for any pending purchase — like a payment-approval notification — so a
 * step_up is never missed; closing it (Esc) leaves the purchase pending rather than
 * answering it. Nothing is ever approved by default: an unanswered purchase is
 * declined automatically when the window expires (backend `expireStalePending`).
 */
@Component({
  selector: 'app-step-up-modal',
  imports: [FormsModule, CurrencyPipe, DecimalPipe],
  templateUrl: './step-up-modal.html',
  styleUrl: './step-up-modal.scss',
})
export class StepUpModal {
  protected s = inject(StepUpService);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected note = '';
  protected now = signal(Date.now());

  protected d = computed(() => {
    const c = this.s.current();
    const full = this.s.detail();
    return c && full?.authorization_id === c.authorization_id ? { ...c, ...full } : c;
  });
  protected reasons = computed(() => (this.d()?.checks ?? []).filter((c) => c.status === 'uncertain' || c.status === 'fail'));
  protected flagged = computed(() => (this.d()?.checks ?? []).some((c) => c.id === 'injection'));
  protected secondsLeft = computed(() => {
    const at = this.d()?.human_deadline_at;
    return at ? Math.max(0, Math.round((Date.parse(at) - this.now()) / 1000)) : null;
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    let shownId: string | null = null;
    effect(() => {
      const el = this.dialog().nativeElement;
      const id = this.s.current()?.authorization_id ?? null;
      if (id && !el.open) el.showModal();
      if (!id && el.open) el.close();
      if (id !== shownId) { this.note = ''; shownId = id; }
    });
  }

  protected onCancel(event: Event) {
    // Esc closes through the service so the modal state stays in sync.
    event.preventDefault();
    this.s.close();
  }

  protected close() {
    this.s.close();
  }

  protected async answer(decision: 'approve' | 'decline') {
    const id = this.s.current()?.authorization_id;
    if (!id) return;
    await this.s.resolve(id, decision, this.note.trim() || undefined);
  }
}
