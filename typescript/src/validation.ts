export function bounded(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

export function unit(value: number, name: string): number {
  return bounded(value, 0, 1, name);
}

export function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function integerBetween(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

export function finiteNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return value;
}

export function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
  return value;
}

export function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
  return value;
}
