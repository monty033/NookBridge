/**
 * Production operator runtime wiring.
 *
 * This module is shared by the dedicated provisioning and fetch-only sync
 * entrypoints.  It intentionally binds both commands to the daemon's fixed
 * state directory and to the systemd LoadCredential backend.  The ordinary
 * development CLI continues to use its explicitly marked file backend.
 */

import { createProductionLiveLoginRuntime } from "../auth/live-login-runtime.js";
import type { LiveLoginRuntime } from "../auth/admin-command.js";
import {
  createSystemdCredentialKeyStore,
  NOOKBRIDGE_DB_KEY_LABEL,
} from "../keystore/systemd-credential-keystore.js";
import type { SecureKeyStore } from "../keystore/keystore.js";

export const PRODUCTION_STATE_DIR = "/var/lib/nookbridge" as const;
export const CREDENTIALS_DIRECTORY_ENV = "CREDENTIALS_DIRECTORY" as const;

const OPERATOR_ENV_NAMES = [
  CREDENTIALS_DIRECTORY_ENV,
  "NOOKBRIDGE_ENABLE_LIVE_AUTH",
  "NOOKBRIDGE_ENABLE_LIVE_SYNC",
] as const;

const FORBIDDEN_ENV_CARRIERS = [
  "NOOKBRIDGE_EMAIL",
  "NOOKBRIDGE_USERNAME",
  "NOOKBRIDGE_PASSWORD",
  "NOOKBRIDGE_PASSWD",
  "NOOKBRIDGE_MFA",
  "NOOKBRIDGE_TOTP",
  "NOOKBRIDGE_SECRET",
  "NOOKBRIDGE_TOKEN",
  "NOOKBRIDGE_ACCESS_TOKEN",
  "NOOKBRIDGE_REFRESH_TOKEN",
  "NOOKCTL_EMAIL",
  "NOOKCTL_USERNAME",
  "NOOKCTL_PASSWORD",
  "NOOKCTL_MFA",
  "NOOKCTL_TOKEN",
] as const;

/**
 * Copy environment names without reading forbidden carrier values.
 * Presence of a forbidden name is retained as an undefined slot so the
 * downstream parser rejects it categorically before any prompt or state open.
 */
export function readSafeOperatorEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  try {
    const out: Record<string, string | undefined> = Object.create(null) as Record<
      string,
      string | undefined
    >;
    for (const name of FORBIDDEN_ENV_CARRIERS) {
      if (name in source) out[name] = undefined;
    }
    for (const name of OPERATOR_ENV_NAMES) {
      if (name in source) out[name] = source[name];
    }
    return Object.freeze(out);
  } catch {
    throw new Error("invalid operator environment");
  }
}

export function createProductionOperatorKeyStore(
  environment: Readonly<Record<string, string | undefined>>,
): SecureKeyStore {
  const credentialsDirectory = environment[CREDENTIALS_DIRECTORY_ENV];
  if (typeof credentialsDirectory !== "string" || credentialsDirectory.length === 0) {
    throw new Error("operator credential runtime unavailable");
  }
  return createSystemdCredentialKeyStore({
    credentialsDirectory,
    credentialName: NOOKBRIDGE_DB_KEY_LABEL,
  });
}

/**
 * Open the same production-encrypted state used by nookd.
 *
 * CREDENTIALS_DIRECTORY is supplied by systemd for the transient operator
 * unit.  Missing or malformed credentials are converted by the existing
 * runtime/key-store layers into categorical initialization failure.
 */
export async function createProductionOperatorRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<LiveLoginRuntime> {
  const keys = createProductionOperatorKeyStore(environment);
  return createProductionLiveLoginRuntime({
    stateDir: PRODUCTION_STATE_DIR,
    keys,
  });
}
