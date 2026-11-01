/** Preserve supported string keys exactly; never silently change a passphrase. */
export function validateSqlcipherKey(key: string): string {
  if (/["\\]/.test(key)) {
    throw new Error("SQLCipher key contains unsupported characters");
  }
  return key;
}
