import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { getDb } from './db.ts';
import { verifyPack, type PackReport } from './verify.ts';

// Load order respects foreign keys.
const TABLES = [
  'customers', 'accounts', 'cards', 'merchants', 'items', 'fx_rates',
  'scenario_catalogue', 'scenario_authorities', 'purchase_attempts',
  'purchase_attempt_items', 'authorization_history',
];

export class PackVerificationError extends Error {
  report: PackReport;
  constructor(report: PackReport) {
    super(`Data pack failed verification:\n- ${report.errors.join('\n- ')}`);
    this.report = report;
  }
}

/**
 * Verifies the data pack against its manifest and contracts, then loads every CSV
 * into SQLite. Empty CSV cells become NULL. Refuses to load a structurally broken pack.
 */
export function seed(db: DatabaseSync = getDb(), dataDir = config.dataDir): Record<string, number> {
  const report = verifyPack(dataDir);
  for (const w of report.warnings) console.warn(`[data pack] ${w}`);
  if (!report.ok) throw new PackVerificationError(report);
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
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('pack_verification', JSON.stringify(report));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.table(seed());
  const { value } = getDb().prepare("SELECT value FROM app_meta WHERE key = 'pack_verification'").get() as { value: string };
  console.table((JSON.parse(value) as PackReport).checks.map((c) => ({ check: c.name, ok: c.ok, detail: c.detail })));
}
