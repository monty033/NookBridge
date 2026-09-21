/**
 * The read-only sync boundary accepts exactly `{ type: "fetch" }` and nothing
 * else.
 *
 * Both layers that expose the boundary — the read-only adapter and the read-only
 * projection — must enforce the identical rule, so the check lives here rather
 * than being written twice and drifting apart.  Each caller throws its own
 * categorical error; this module only decides the shape.
 *
 * Why exactness matters: an extra field would be forwarded nowhere and silently
 * discarded, letting a caller believe it asked for something the boundary never
 * honoured.  A naive `Object.keys` check is not enough — a symbol key, a
 * non-enumerable property, or a property inherited from a prototype each carry a
 * field the check would never see.  Upstream `full` includes a send phase, so
 * `force`, `send`, and `full` are out of scope on this surface entirely.
 */

/** The only sync type the read-only boundary permits. */
export const READONLY_SYNC_TYPE = "fetch";

/**
 * Is this request exactly `{ type: "fetch" }`?
 *
 * Requires a plain object (prototype `Object.prototype` or `null`) with exactly
 * one own key, `type`, whose value is the published sync type.
 */
export function isExactFetchRequest(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  if (!Object.hasOwn(value, "type")) return false;
  if (Reflect.ownKeys(value).length !== 1) return false;
  return (value as { readonly type?: unknown }).type === READONLY_SYNC_TYPE;
}
