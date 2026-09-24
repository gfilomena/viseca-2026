import { config } from './config.ts';
import { getDb, isSeeded, packReport } from './db/db.ts';
import { seed } from './db/seed.ts';
import { buildApp } from './app.ts';
import { expireStalePending } from './services/runs.ts';

getDb();
if (!isSeeded() || !packReport()) console.log('Seeding database from data pack…', seed());

const app = await buildApp();
await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`Wallet control API on http://localhost:${config.port} (offline only — no hosted platform integration; UI origins: ${config.corsOrigins.join(', ')})`);

setInterval(expireStalePending, 2000);
