import { Injectable, signal } from '@angular/core';

export type BusMessage =
  | { type: 'decision'; authorization_id: string; run_id: string }
  | { type: 'run'; run_id: string }
  | { type: 'mandate'; mandate_id: string }
  | { type: 'worker'; status: string; detail?: string };

/** Server-sent events from the backend; components react to `last` / `version`. */
@Injectable({ providedIn: 'root' })
export class LiveService {
  readonly last = signal<BusMessage | null>(null);
  readonly version = signal(0);
  readonly connected = signal(false);
  private es?: EventSource;

  constructor() { this.connect(); }

  private connect() {
    this.es = new EventSource('/api/stream');
    this.es.onopen = () => this.connected.set(true);
    this.es.onerror = () => this.connected.set(false);
    this.es.onmessage = (ev) => {
      this.last.set(JSON.parse(ev.data));
      this.version.update((v) => v + 1);
    };
  }
}
