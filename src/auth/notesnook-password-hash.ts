/**
 * Hash the password form expected by Notesnook's password grant.
 *
 * Keep this narrow helper separate from the core/database seams: the live
 * auth provider needs the same deterministic form as PersistentStorage, but
 * must not expose a generic storage or database passthrough.
 */
import { createRequire } from "node:module";

const NOTESNOOK_APP_SALT = "oVzKtazBo7d8sb7TBvY9jw";
const require = createRequire(import.meta.url);
const { NNCrypto } = require("@notesnook/crypto") as {
  NNCrypto: new () => {
    hash(password: string, salt: string): Promise<string>;
  };
};
const crypto = new NNCrypto();

/**
 * Delegate to the pinned Notesnook crypto implementation.  Its Node CJS
 * export is selected deliberately: the published ESM sodium bridge is not
 * compatible with Node 22's CJS named-export interop.
 */
export async function hashNotesnookPassword(email: string, password: string): Promise<string> {
  return crypto.hash(password, `${NOTESNOOK_APP_SALT}${email.toLowerCase()}`);
}
