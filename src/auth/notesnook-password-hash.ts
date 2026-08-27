/**
 * Hash the password form expected by Notesnook's password grant.
 *
 * Keep this narrow helper separate from the core/database seams: the live
 * auth provider needs the same deterministic form as PersistentStorage, but
 * must not expose a generic storage or database passthrough.
 */
import { createHash } from "node:crypto";

const NOTESNOOK_APP_SALT = "oVzKtazBo7d8sb7TBvY9jw";

export function hashNotesnookPassword(email: string, password: string): string {
  return createHash("sha256")
    .update(`${NOTESNOOK_APP_SALT}${email.toLowerCase()}${password}`, "utf8")
    .digest("base64");
}
