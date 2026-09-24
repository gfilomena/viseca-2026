import { config, liveEnabled } from './config.ts';
import { getDb, isSeeded, packReport } from './db/db.ts';
import { seed } from './db/seed.ts';
import { buildApp } from './app.ts';
import { startWorker } from './remote/worker.ts';
import { expireStalePending, reconcileLive } from './services/runs.ts';

getDb();
if (!isSeeded() || !packReport()) console.log('Seeding database from data pack…', seed());

const app = await buildApp();
await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`Wallet control API on http://localhost:${config.port} (live API ${liveEnabled() ? 'enabled' : 'disabled — offline replay only'}; UI origins: ${config.corsOrigins.join(', ')})`);

setInterval(expireStalePending, 2000);
if (liveEnabled()) setInterval(() => void reconcileLive().catch((e) => console.error('[reconcile]', e)), 5000);
void startWorker();
