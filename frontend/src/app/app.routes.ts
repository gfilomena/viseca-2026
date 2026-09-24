import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'policy' },
  { path: 'policy', loadComponent: () => import('./pages/policy/policy.page').then((m) => m.PolicyPage), title: 'Wallet policy' },
  { path: 'activity', loadComponent: () => import('./pages/activity/activity.page').then((m) => m.ActivityPage), title: 'Purchases' },
  { path: 'data', loadComponent: () => import('./pages/data/data.page').then((m) => m.DataPage), title: 'Customer data' },
  { path: '**', redirectTo: 'policy' },
];
