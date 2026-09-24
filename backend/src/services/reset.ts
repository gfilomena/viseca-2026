import { getDb } from '../db/db.ts';
import { publish } from './bus.ts';

/** Development reset: clears local mandates, runs and decisions (the data pack is kept). */
export function resetLocal(): { local: Record<string, number> } {
  const db = getDb();
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const local = { decisions: count('decisions'), runs: count('runs'), mandates: count('mandates') };
  db.exec('BEGIN');
  db.exec('DELETE FROM decisions; DELETE FROM runs; DELETE FROM mandates;');
  db.exec('COMMIT');
  publish({ type: 'mandate', mandate_id: '*' });
  publish({ type: 'run', run_id: '*' });
  return { local };
}
