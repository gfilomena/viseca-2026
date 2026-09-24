import { Component, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './core/api.service';
import { LiveService } from './core/live.service';
import type { Health } from './core/models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private api = inject(ApiService);
  protected live = inject(LiveService);
  protected health = signal<Health | null>(null);
  protected pending = signal(0);

  constructor() {
    this.api.health().then((h) => this.health.set(h)).catch(() => this.health.set(null));
    effect(() => {
      this.live.version();
      this.api.decisions({ status: 'pending' }).then((d) => this.pending.set(d.length)).catch(() => {});
    });
  }
}
