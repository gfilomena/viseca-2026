import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { roundHalfEven } from '../domain/money.ts';

/**
 * Verifies the data pack against its own manifest and contracts before it is
 * loaded: metadata.json (data_pack.schema.json), file hashes and row counts,
 * CSV headers, keys and foreign keys (x-csv-contracts), the historical column
 * contract (authorization_history.schema.json) and the currency formula.
 *
 * Structural problems are errors (seeding stops); a changed file hash is only a
 * warning, since the organisers may ship a revised pack.
 */

export interface PackReport {
  ok: boolean;
  verified_at: string;
  pack_version: string | null;
  errors: string[];
  warnings: string[];
  checks: { name: string; ok: boolean; detail: string }[];
}

type Row = Record<string, string>;
type ColumnContract = { type: 'string' | 'number' | 'integer' | 'boolean'; nullable: boolean; enum?: string[]; pattern?: string; format?: string };

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const MAX_EXAMPLES = 5;

export function verifyPack(dataDir: string): PackReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: PackReport['checks'] = [];
  const check = (name: string, problems: string[], okDetail: string, level: 'error' | 'warning' = 'error') => {
    checks.push({ name, ok: problems.length === 0, detail: problems.length ? `${problems.length} problem(s): ${problems.slice(0, MAX_EXAMPLES).join('; ')}` : okDetail });
    (level === 'error' ? errors : warnings).push(...problems.slice(0, MAX_EXAMPLES).map((p) => `${name}: ${p}`));
  };

  const meta = readJson(path.join(dataDir, 'metadata.json'));
  const packSchema = readJson(path.join(dataDir, 'schemas', 'data_pack.schema.json'));
  const historySchema = readJson(path.join(dataDir, 'schemas', 'authorization_history.schema.json'));

  // 1. Manifest shape.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validMeta = ajv.validate(packSchema, meta);
  check('manifest schema', validMeta ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`), 'metadata.json matches data_pack.schema.json');

  // 2. Hashes and row counts.
  const csvCache = new Map<string, Row[]>();
  const readCsv = (file: string): Row[] => {
    if (!csvCache.has(file)) csvCache.set(file, parse(fs.readFileSync(path.join(dataDir, file)), { columns: true, skip_empty_lines: true }) as Row[]);
    return csvCache.get(file)!;
  };
  const hashProblems: string[] = [];
  const rowProblems: string[] = [];
  for (const f of meta.files as { path: string; format: string; rows?: number; sha256: string }[]) {
    const p = path.join(dataDir, f.path);
    if (!fs.existsSync(p)) { rowProblems.push(`${f.path} is missing`); continue; }
    const sha = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (sha !== f.sha256) hashProblems.push(`${f.path} hash differs from manifest`);
    if (f.format === 'csv' && f.rows !== undefined && readCsv(f.path).length !== f.rows) rowProblems.push(`${f.path} has ${readCsv(f.path).length} rows, manifest says ${f.rows}`);
  }
  check('file hashes', hashProblems, `${meta.files.length} files match their SHA-256`, 'warning');
  check('row counts', rowProblems, 'every CSV has the row count stated in metadata.json');

  // 3. CSV headers, keys, foreign keys.
  const contracts = packSchema['x-csv-contracts'] as Record<string, { key: string | string[]; foreign_keys: string[]; header: string[] }>;
  const headerProblems: string[] = [];
  const keyProblems: string[] = [];
  const fkProblems: string[] = [];
  const keyIndex = new Map<string, Set<string>>(); // "table.column" -> values
  const values = (file: string, col: string) => {
    const k = `${file}.${col}`;
    if (!keyIndex.has(k)) keyIndex.set(k, new Set(readCsv(file).map((r) => r[col])));
    return keyIndex.get(k)!;
  };
  for (const [file, c] of Object.entries(contracts)) {
    const rows = readCsv(file);
    const header = Object.keys(rows[0] ?? {});
    if (JSON.stringify(header) !== JSON.stringify(c.header)) headerProblems.push(`${file} header differs from contract`);
    const keyCols = Array.isArray(c.key) ? c.key : [c.key];
    const seen = new Set<string>();
    for (const r of rows) {
      const k = keyCols.map((col) => r[col]).join('|');
      if (!k.replaceAll('|', '')) keyProblems.push(`${file} has an empty key`);
      else if (seen.has(k)) keyProblems.push(`${file} duplicate key ${k}`);
      seen.add(k);
    }
    for (const fk of c.foreign_keys) {
      const m = fk.match(/^(\w+) -> (\w+)\.(\w+)$/);
      if (!m) continue;
      const target = values(`${m[2]}.csv`, m[3]);
      const missing = rows.filter((r) => r[m[1]] && !target.has(r[m[1]]));
      if (missing.length) fkProblems.push(`${file}.${m[1]}: ${missing.length} value(s) not in ${m[2]} (e.g. ${missing[0][m[1]]})`);
    }
  }
  check('CSV headers', headerProblems, `${Object.keys(contracts).length} CSVs have the contracted columns in order`);
  check('primary keys', keyProblems, 'all keys present and unique');
  check('foreign keys', fkProblems, 'every reference resolves');

  // 4. Historical column contract, ordering and joins.
  const history = readCsv('authorization_history.csv');
  const cols = historySchema.properties.columns.const as string[];
  const colContract = historySchema['x-csv-column-contract'] as Record<string, ColumnContract>;
  const histProblems: string[] = [];
  if (JSON.stringify(Object.keys(history[0] ?? {})) !== JSON.stringify(cols)) histProblems.push('column list differs from authorization_history.schema.json');
  for (const [i, r] of history.entries()) {
    for (const [col, spec] of Object.entries(colContract)) {
      const v = r[col];
      if (v === '' || v === undefined) { if (!spec.nullable) histProblems.push(`row ${i + 2} ${col} is empty`); continue; }
      if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) histProblems.push(`row ${i + 2} ${col}="${v}" is not a number`);
      if (spec.type === 'integer' && !/^-?\d+$/.test(v)) histProblems.push(`row ${i + 2} ${col}="${v}" is not an integer`);
      if (spec.type === 'boolean' && v !== 'true' && v !== 'false') histProblems.push(`row ${i + 2} ${col}="${v}" is not true/false`);
      if (spec.enum && !spec.enum.includes(v)) histProblems.push(`row ${i + 2} ${col}="${v}" not in ${spec.enum.join('/')}`);
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) histProblems.push(`row ${i + 2} ${col}="${v}" does not match ${spec.pattern}`);
      if (spec.format === 'date-time' && Number.isNaN(Date.parse(v))) histProblems.push(`row ${i + 2} ${col}="${v}" is not a timestamp`);
    }
    if (i > 0) {
      const prev = history[i - 1];
      if (prev.timestamp > r.timestamp || (prev.timestamp === r.timestamp && prev.authorization_id > r.authorization_id)) histProblems.push(`row ${i + 2} breaks (timestamp, authorization_id) ordering`);
    }
  }
  const cardIds = values('cards.csv', 'card_id');
  const merchantIds = values('merchants.csv', 'merchant_id');
  const histIds = new Set(history.map((r) => r.authorization_id));
  for (const r of history) {
    if (!cardIds.has(r.card_id)) histProblems.push(`${r.authorization_id} unknown card ${r.card_id}`);
    if (!merchantIds.has(r.merchant_id)) histProblems.push(`${r.authorization_id} unknown merchant ${r.merchant_id}`);
    if (r.related_transaction_id && !histIds.has(r.related_transaction_id)) histProblems.push(`${r.authorization_id} refund points to unknown ${r.related_transaction_id}`);
  }
  check('history contract', histProblems, `${history.length} rows match types, enums, nullability, ordering and joins`);

  // 5. Currency formula: billing_amount_chf = amount × fx_rate (half-even, 2 dp).
  const fx = Object.fromEntries(readCsv('fx_rates.csv').map((r) => [r.from_currency, Number(r.rate)]));
  const fxProblems: string[] = [];
  for (const [file, rows] of [['authorization_history.csv', history], ['purchase_attempts.csv', readCsv('purchase_attempts.csv')]] as const) {
    for (const r of rows) {
      const expected = roundHalfEven(Number(r.amount) * (fx[r.currency] ?? NaN));
      if (!(Math.abs(expected - Number(r.billing_amount_chf)) <= 0.01)) fxProblems.push(`${file} ${r.authorization_id}: ${r.amount} ${r.currency} → ${r.billing_amount_chf}, expected ${expected}`);
    }
  }
  check('currency formula', fxProblems, 'billing_amount_chf = amount × fixed rate on every history row and attempt');

  // 6. Cart totals: lines + delivery = amount.
  const lines = readCsv('purchase_attempt_items.csv');
  const cartProblems: string[] = [];
  for (const a of readCsv('purchase_attempts.csv')) {
    const sum = lines.filter((l) => l.authorization_id === a.authorization_id).reduce((s, l) => s + Number(l.unit_price) * Number(l.quantity), 0);
    if (Math.abs(roundHalfEven(sum) - Number(a.items_subtotal)) > 0.01) cartProblems.push(`${a.authorization_id}: lines ${sum.toFixed(2)} ≠ subtotal ${a.items_subtotal}`);
    if (Math.abs(Number(a.items_subtotal) + Number(a.delivery_fee) - Number(a.amount)) > 0.01) cartProblems.push(`${a.authorization_id}: subtotal + delivery ≠ amount`);
  }
  check('cart totals', cartProblems, 'every attempt: cart lines = subtotal, subtotal + delivery = amount');

  return { ok: errors.length === 0, verified_at: new Date().toISOString(), pack_version: meta.pack_version ?? null, errors, warnings, checks };
}
