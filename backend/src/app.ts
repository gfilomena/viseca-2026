import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.ts';
import { routes } from './api/routes.ts';

/**
 * The API has no user login (single-customer prototype), so browser access is limited
 * to the customer UI's origin: other sites can neither read responses (CORS) nor
 * trigger actions such as approving a step-up (requests with a foreign Origin are refused).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' } });
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) {
      return reply.code(403).send({ error: `Origin ${origin} is not allowed` });
    }
  });
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(routes);
  return app;
}
