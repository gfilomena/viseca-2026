import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, liveEnabled } from './config.ts';
import { getDb, isSeeded } from './db/db.ts';
import { seed } from './db/seed.ts';
import { routes } from './api/routes.ts';
import { startWorker } from './remote/worker.ts';
import { expireStalePending } from './services/runs.ts';

getDb();
if (!isSeeded()) console.log('Seeding database from data pack…', seed());

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
await app.register(routes);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Wallet control API on http://localhost:${config.port} (live API ${liveEnabled() ? 'enabled' : 'disabled — offline replay only'})`);

setInterval(expireStalePending, 2000);
void startWorker();
