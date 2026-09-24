import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LiveService } from './core/live.service';
import { StepUpModal } from './core/step-up-modal';
import { StepUpService } from './core/step-up.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, StepUpModal],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected live = inject(LiveService);
  private stepUps = inject(StepUpService);
  protected pending = computed(() => this.stepUps.pending().length);
}
