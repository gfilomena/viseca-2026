import { getDb } from '../db/db.ts';
import { compileInstruction, type CatalogueItem, type PolicyIntents } from '../policy/compiler.ts';
import type { CatalogueEntry } from '../engine/engine.ts';

let items: CatalogueItem[] | undefined;
let prices: Map<string, CatalogueEntry> | undefined;
let fx: Record<string, number> | undefined;
const intentCache = new Map<string, PolicyIntents>();

export function catalogueItems(): CatalogueItem[] {
  items ??= getDb().prepare('SELECT item_id, item_name, item_category FROM items ORDER BY item_id').all() as unknown as CatalogueItem[];
  return items;
}

export function cataloguePrices(): Map<string, CatalogueEntry> {
  prices ??= new Map((getDb().prepare('SELECT item_id, item_name, unit_price_min_chf AS min, unit_price_max_chf AS max FROM items').all() as unknown as (CatalogueEntry & { item_id: string })[])
    .map((r) => [r.item_id, { item_name: r.item_name, min: r.min, max: r.max }]));
  return prices;
}

export function fxRates(): Record<string, number> {
  fx ??= Object.fromEntries((getDb().prepare('SELECT from_currency, rate FROM fx_rates').all() as { from_currency: string; rate: number }[]).map((r) => [r.from_currency, r.rate]));
  return fx;
}

/** Soft intents are re-derived from the instruction carried in the event (guidance is not part of live events). */
export function intentsFor(instruction: string): PolicyIntents {
  let hit = intentCache.get(instruction);
  if (!hit) { hit = compileInstruction(instruction, catalogueItems()).intents; intentCache.set(instruction, hit); }
  return hit;
}
