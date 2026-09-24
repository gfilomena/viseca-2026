import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const { seed } = await import('../db/seed.ts');
const { getDb } = await import('../db/db.ts');
const { buildApp } = await import('../app.ts');

seed(getDb());

test('only the customer UI origin may call the API', async () => {
  const app = await buildApp();
  const evil = await app.inject({ method: 'GET', url: '/api/decisions?status=pending', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const csrf = await app.inject({ method: 'POST', url: '/api/decisions/x/resolve', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, payload: '{"decision":"approve"}' });
  assert.equal(csrf.statusCode, 403);
  const ui = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:4200' } });
  assert.equal(ui.statusCode, 200);
  assert.equal(ui.headers['access-control-allow-origin'], 'http://localhost:4200');
  const cli = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(cli.statusCode, 200);
  await app.close();
});
