import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './core/api.service';
import { LiveService } from './core/live.service';
import type { Health } from './core/models';
import { StepUpModal } from './core/step-up-modal';
import { StepUpService } from './core/step-up.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, StepUpModal],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private api = inject(ApiService);
  protected live = inject(LiveService);
  protected health = signal<Health | null>(null);
  private stepUps = inject(StepUpService);
  protected pending = computed(() => this.stepUps.pending().length);

  constructor() {
    this.api.health().then((h) => this.health.set(h)).catch(() => this.health.set(null));
  }
}
