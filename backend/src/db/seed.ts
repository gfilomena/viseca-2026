import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { getDb } from './db.ts';

// Load order respects foreign keys.
const TABLES = [
  'customers', 'accounts', 'cards', 'merchants', 'items', 'fx_rates',
  'scenario_catalogue', 'scenario_authorities', 'purchase_attempts',
  'purchase_attempt_items', 'authorization_history',
];

/** Loads every CSV of the data pack into SQLite. Empty CSV cells become NULL. */
export function seed(db: DatabaseSync = getDb(), dataDir = config.dataDir): Record<string, number> {
  const counts: Record<string, number> = {};
  db.exec('BEGIN');
  try {
    for (const table of [...TABLES].reverse()) db.exec(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      const rows = parse(fs.readFileSync(path.join(dataDir, `${table}.csv`)), {
        columns: true, skip_empty_lines: true,
      }) as Record<string, string>[];
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      );
      for (const r of rows) stmt.run(...cols.map((c) => (r[c] === '' ? null : r[c])));
      counts[table] = rows.length;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.table(seed());
}
