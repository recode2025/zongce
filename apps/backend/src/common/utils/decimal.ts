import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/** 四舍五入到 2 位小数（模板口径：65.8469… → 65.85） */
export function round2(n: number | string | Decimal): Decimal {
  return new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function d(n: number | string | Decimal | null | undefined): Decimal {
  if (n === null || n === undefined || n === '') return new Decimal(0);
  if (n instanceof Decimal) return n;
  return new Decimal(n);
}

/** 数字比较安全取 min */
export function minD(a: Decimal, b: number | string | Decimal): Decimal {
  return Decimal.min(a, new Decimal(b));
}

export function maxD(a: Decimal, b: number | string | Decimal): Decimal {
  return Decimal.max(a, new Decimal(b));
}

export function toNum(x: Decimal): number {
  return Number(x.toDecimalPlaces(4).toString());
}

export { Decimal };
