import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? path.join(ROOT_DIR, 'resource', 'data'),
  dbPath: process.env.DB_PATH ?? path.join(ROOT_DIR, 'backend', 'var', 'leash.db'),
  engineVersion: 'leash-engine/0.1.0',
  humanWindowSeconds: Number(process.env.HUMAN_WINDOW_SECONDS ?? 120),
  /** Browser origins allowed to call the API (the customer UI). Comma-separated. */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:4200,http://127.0.0.1:4200').split(',').map((s) => s.trim()).filter(Boolean),
};
