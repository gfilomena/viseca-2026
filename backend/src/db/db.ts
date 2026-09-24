import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export function isSeeded(): boolean {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM authorization_history').get() as { n: number };
  return row.n > 0;
}

export const json = <T>(s: unknown): T => JSON.parse(String(s)) as T;
