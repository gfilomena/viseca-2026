/** Decimal half-even rounding to 2 places, as required by the data dictionary. */
export function roundHalfEven(value: number, places = 2): number {
  const m = 10 ** places;
  const x = value * m;
  const r = Math.round(x);
  const isHalf = Math.abs(Math.abs(x - Math.trunc(x)) - 0.5) < 1e-9;
  const rounded = isHalf ? (Math.trunc(x) % 2 === 0 ? Math.trunc(x) : Math.trunc(x) + Math.sign(x)) : r;
  return rounded / m;
}

export const chf = (n: number) => `CHF ${n.toFixed(2)}`;
