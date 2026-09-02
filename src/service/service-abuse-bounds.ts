/** Stage 7 Slice 2 — closed service-side abuse bounds. */

const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectDefineProperty = Object.defineProperty;
const reflectOwnKeys = Reflect.ownKeys;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const numberIsInteger = Number.isInteger;

export interface ServiceAbuseBounds {
  readonly requestTimeoutMs: number;
  readonly connectionIdleTimeoutMs: number;
  readonly perConnectionBudgetMs: number;
  readonly perProcessRequestsPerSecond: number;
  readonly perProcessBurstSize: number;
}

export const SERVICE_ABUSE_BOUNDS_LIMITS = objectFreeze(
  objectCreate(null, {
    maxRequestTimeoutMs: { value: 60_000, enumerable: true },
    maxConnectionIdleTimeoutMs: { value: 300_000, enumerable: true },
    maxPerConnectionBudgetMs: { value: 600_000, enumerable: true },
    maxPerProcessRequestsPerSecond: { value: 100, enumerable: true },
    maxPerProcessBurstSize: { value: 100, enumerable: true },
  }),
) as unknown as Readonly<{
  readonly maxRequestTimeoutMs: number;
  readonly maxConnectionIdleTimeoutMs: number;
  readonly maxPerConnectionBudgetMs: number;
  readonly maxPerProcessRequestsPerSecond: number;
  readonly maxPerProcessBurstSize: number;
}>;

const BOUND_FIELDS = objectFreeze([
  "requestTimeoutMs",
  "connectionIdleTimeoutMs",
  "perConnectionBudgetMs",
  "perProcessRequestsPerSecond",
  "perProcessBurstSize",
] as const);

type BoundField = (typeof BOUND_FIELDS)[number];

export const DEFAULT_SERVICE_ABUSE_BOUNDS = makeBounds({
  requestTimeoutMs: 10_000,
  connectionIdleTimeoutMs: 30_000,
  perConnectionBudgetMs: 120_000,
  perProcessRequestsPerSecond: 20,
  perProcessBurstSize: 10,
});

export function normalizeServiceAbuseBounds(
  value: unknown = DEFAULT_SERVICE_ABUSE_BOUNDS,
): ServiceAbuseBounds {
  if (typeof value !== "object" || value === null || arrayIsArray(value)) {
    throw new Error("invalid service abuse bounds");
  }
  let keys: readonly (string | symbol)[];
  try {
    keys = reflectOwnKeys(value);
  } catch {
    throw new Error("invalid service abuse bounds");
  }
  if (keys.length !== BOUND_FIELDS.length) throw new Error("invalid service abuse bounds");
  for (const key of keys) {
    if (typeof key !== "string" || !BOUND_FIELDS.includes(key as BoundField)) {
      throw new Error("invalid service abuse bounds");
    }
  }
  const captured = objectCreate(null) as Record<BoundField, number>;
  for (const field of BOUND_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = objectGetOwnPropertyDescriptor(value, field);
    } catch {
      throw new Error("invalid service abuse bounds");
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("invalid service abuse bounds");
    }
    const number = descriptor.value;
    if (!numberIsInteger(number) || !numberIsFinite(number) || number < 1) {
      throw new Error("invalid service abuse bounds");
    }
    if (number > maximumFor(field)) throw new Error("invalid service abuse bounds");
    captured[field] = number;
  }
  return objectFreeze(captured) as unknown as ServiceAbuseBounds;
}

function maximumFor(field: BoundField): number {
  switch (field) {
    case "requestTimeoutMs":
      return SERVICE_ABUSE_BOUNDS_LIMITS.maxRequestTimeoutMs;
    case "connectionIdleTimeoutMs":
      return SERVICE_ABUSE_BOUNDS_LIMITS.maxConnectionIdleTimeoutMs;
    case "perConnectionBudgetMs":
      return SERVICE_ABUSE_BOUNDS_LIMITS.maxPerConnectionBudgetMs;
    case "perProcessRequestsPerSecond":
      return SERVICE_ABUSE_BOUNDS_LIMITS.maxPerProcessRequestsPerSecond;
    case "perProcessBurstSize":
      return SERVICE_ABUSE_BOUNDS_LIMITS.maxPerProcessBurstSize;
  }
}

function makeBounds(values: Record<BoundField, number>): ServiceAbuseBounds {
  const target = objectCreate(null) as Record<BoundField, number>;
  for (const field of BOUND_FIELDS) {
    objectDefineProperty(target, field, {
      value: values[field],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return objectFreeze(target) as ServiceAbuseBounds;
}
