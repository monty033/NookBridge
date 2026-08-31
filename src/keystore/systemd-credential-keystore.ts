/**
 * NookBridge Stage 5 — production-safe systemd `LoadCredential=` key store.
 *
 * This is the production key-source identified by the Stage 5
 * service-boundary decision record.  It is the ONLY backend the daemon
 * is allowed to select; the `development-file` backend is explicitly
 * forbidden for daemon use.
 *
 * Why this exists as a separate backend:
 *
 *   - `LoadCredential=` is the systemd mechanism that presents a
 *     service-private file (typically the plaintext output of a
 *     sops-nix-decrypted source) to the daemon at runtime by copying
 *     it into the daemon's `$CREDENTIALS_DIRECTORY` under a
 *     non-secret label.  The label chosen by the deployment is
 *     `nookbridge-db-key`.
 *   - The daemon must read the credential exactly once at construction
 *     and never re-open the file.  Stage 5 has no key rotation; the
 *     cached value is the entire lifetime of the process.
 *   - The backend MUST NOT log, write, chmod, mkdir, copy, generate,
 *     reset, or otherwise mutate the filesystem.  A daemon that
 *     touches its own credential directory is a security bug.
 *   - The backend MUST refuse to start when the credential is missing,
 *     empty, whitespace-only, oversized, unreadable, or non-regular.
 *     Every refusal is reported as `undefined` from `getDatabaseKey()`;
 *     the storage layer treats undefined as "do not start".
 *   - The backend MUST refuse any caller-controlled full credential
 *     path.  The factory composes `credentialsDirectory + credentialName`
 *     internally; the name is validated as a plain credential filename
 *     with no separators or traversal.
 *
 * Public credential label:
 *
 *   `nookbridge-db-key`
 *
 * The bounded max credential size is exposed as
 * {@link SYSTEMD_CREDENTIAL_MAX_BYTES}; oversized sources are rejected
 * before they can allocate unbounded buffers.
 *
 * Why the source is NOT under `/nix/store`:
 *
 *   The credential value originates from a sops-nix-decrypted YAML /
 *   JSON / env file that is materialized on the host by sops-nix.
 *   systemd then exposes the decrypted material to the daemon via
 *   `LoadCredential=`, which copies it into the service-private
 *   `$CREDENTIALS_DIRECTORY`. The daemon reads its key from that
 *   per-service directory; the store path behind the credential is
 *   irrelevant to this backend and is not surfaced through any API.
 *   We deliberately do NOT
 *   embed any `/nix/store` path here because doing so would (a)
 *   leak deployment topology and (b) couple the daemon to a NixOS
 *   build artifact rather than the systemd contract.
 */

import { Buffer } from "node:buffer";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { SecureKeyStore } from "./keystore.js";

/**
 * Public bounded max credential size in bytes.
 *
 * Why 1024 (1 KiB):
 *
 *   - The largest plausible Notesnook DB key in any reasonable
 *     deployment is a 64-byte (512-bit) base64 string (~88 ASCII
 *     chars); even a 256-byte key would be unusual.
 *   - 1024 bytes is large enough to absorb future encoding changes
 *     (hex, base64url, future formats) without permitting accidental
 *     embedded blobs, secrets-as-payload mistakes, or attacker
 *     amplification via the daemon's allocator.
 *   - The constant is exported so a future operator-visible doctor
 *     check or sanity log can report the policy without re-deriving
 *     it.
 */
export const SYSTEMD_CREDENTIAL_MAX_BYTES = 1024 as const;

/**
 * The public credential label the deployment will inject under
 * `$CREDENTIALS_DIRECTORY`.  The daemon will compose
 * `${CREDENTIALS_DIRECTORY}/${NOOKBRIDGE_DB_KEY_LABEL}` internally.
 */
export const NOOKBRIDGE_DB_KEY_LABEL = "nookbridge-db-key" as const;

export type CreateSystemdCredentialKeyStoreOptions = {
  /**
   * Absolute path of the directory systemd exposes via
   * `$CREDENTIALS_DIRECTORY`.  The factory composes the credential
   * path as `join(credentialsDirectory, credentialName ?? DEFAULT)`.
   * No path is accepted as an input to the credential name itself.
   */
  credentialsDirectory: string;
  /**
   * Optional credential filename (label).  Defaults to
   * {@link NOOKBRIDGE_DB_KEY_LABEL}.  MUST be a plain credential
   * filename: no path separators, no `..` traversal, no leading
   * whitespace, no empty/whitespace-only value.  The factory does
   * NOT accept a caller-controlled full credential path under any
   * name; passing one is treated as invalid and resolves to
   * `undefined`.
   */
  credentialName?: string;
};

/**
 * Construct a production-safe systemd-credential SecureKeyStore.
 *
 * Reads the credential at most once at construction.  Every refusal
 * is converted to a categorical `undefined` from `getDatabaseKey()`;
 * the factory itself never throws.
 *
 * The factory never logs the credential directory, the credential
 * name, the key bytes, the raw filesystem error message, or the
 * underlying Node error code.
 *
 * Options validation is performed inside a single categorical
 * try/catch so a hostile getter, a revoked proxy, or a non-object
 * input never propagates a raw `TypeError` to the daemon's startup
 * path.
 */
export function createSystemdCredentialKeyStore(
  options: CreateSystemdCredentialKeyStoreOptions,
): SecureKeyStore {
  // Every step that touches untrusted option properties lives inside
  // this try/catch.  Any failure — `options` is `null` / not an
  // object, a property throws on access, a non-string value is
  // surfaced — collapses to the same categorical refusal: a
  // production-safe store whose `getDatabaseKey()` returns
  // `undefined`.
  let cached: string | undefined;
  try {
    const credentialsDirectory = (options as { credentialsDirectory?: unknown })
      .credentialsDirectory;
    if (
      typeof credentialsDirectory !== "string" ||
      credentialsDirectory.length === 0 ||
      hasControlCharacter(credentialsDirectory) ||
      !isAbsolute(credentialsDirectory) ||
      credentialsDirectory.split("/").some((segment) => segment === "..")
    ) {
      // Missing or malformed credentialsDirectory: refuse without
      // touching the filesystem at all.  The property above is the
      // only read from the caller-supplied directory option.
      cached = undefined;
    } else {
      const rawName = (options as { credentialName?: unknown }).credentialName;
      // An explicitly-supplied credentialName MUST be a string.
      // Falling back to the default for a non-string would mask a
      // caller-side wiring bug (e.g. a stray `undefined` from a
      // misconfigured loader) and silently change the credential
      // path the factory reads from.  Refuse categorically instead.
      if (rawName !== undefined && typeof rawName !== "string") {
        cached = undefined;
      } else {
        const credentialName = rawName === undefined ? NOOKBRIDGE_DB_KEY_LABEL : rawName;
        cached = readOnce(credentialsDirectory, credentialName);
      }
    }
  } catch {
    // Hostile getter, revoked proxy, or any other unexpected
    // synchronous failure while reading untrusted options.  The
    // contract is categorical: never throw, never leak the cause.
    cached = undefined;
  }

  return {
    backend: "systemd-credential",
    productionSafe: true,
    getDatabaseKey: () => cached,
  };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Read the credential exactly once with a safe, bounded, no-follow
 * design.
 *
 * Implementation contract (mirrors the file header docblock):
 *
 *   - open the credential path with `O_RDONLY | O_NOFOLLOW` so the
 *     kernel refuses a symlink at the credential slot;
 *   - `fstatSync` the OPEN fd (no `lstatSync`/`statSync`) so the
 *     stat describes the same inode the read will consume;
 *   - reject non-regular files, missing files, and sources larger
 *     than `SYSTEMD_CREDENTIAL_MAX_BYTES`;
 *   - allocate and `readSync` no more than `SYSTEMD_CREDENTIAL_MAX_BYTES`
 *     bytes; a single `read` whose returned length exceeds the
 *     bound means the source grew past it between `open` and
 *     `read` — refused categorically;
 *   - close the fd in `finally`;
 *   - never throw.
 *
 * Returns `undefined` for every legitimate refusal.  Never mutates
 * the filesystem.
 */
function readOnce(credentialsDirectory: string, credentialName: string): string | undefined {
  if (!isPlainCredentialFilename(credentialName)) {
    return undefined;
  }
  const credentialPath = join(credentialsDirectory, credentialName);

  // Use Node's official Linux fs constants so the opened descriptor is
  // non-blocking even when the credential slot is a FIFO or device.  The
  // no-follow flag still prevents symlink substitution at the slot.
  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  // Open read-only with no-follow.  Any failure here — missing
  // file, permission denied, ELOOP on a symlink, ENXIO/ENODEV on
  // a device, EACCES, EPERM, EMFILE — collapses to a categorical
  // `undefined`.  We deliberately do not log the error code.
  let fd: number;
  try {
    fd = openSync(credentialPath, openFlags);
  } catch {
    return undefined;
  }

  try {
    // fstat the OPEN fd.  This is the truth-source for size and
    // file type.  Any failure here is a categorical refusal; an
    // attacker who can make `fstat` fail on a fd we just opened
    // has already won a much larger fight and the daemon would
    // refuse to start regardless.
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } catch {
      return undefined;
    }

    // Reject anything that is not a regular file.  This includes
    // directories, FIFOs, sockets, block/char devices, and any
    // inode that reports `isFile() === false`.
    if (!stat.isFile()) {
      return undefined;
    }

    // Enforce the bounded size before allocating the read buffer.
    if (stat.size > SYSTEMD_CREDENTIAL_MAX_BYTES) {
      return undefined;
    }

    // Allocate exactly `SYSTEMD_CREDENTIAL_MAX_BYTES` bytes for the
    // read.  We deliberately do not allocate `size + 1` because the
    // size we just read may already be stale — a TOCTOU race could
    // have grown the file between `open` and `fstat`.  The bounded
    // buffer is the contract: the daemon allocates at most this many
    // bytes for the credential value, period.
    const buf = Buffer.allocUnsafe(SYSTEMD_CREDENTIAL_MAX_BYTES);
    let bytesRead = 0;
    try {
      // Single bounded read at offset 0.  `bytesRead` larger than
      // the bound means the kernel returned more bytes than the
      // buffer can hold (impossible for a single `readSync` into a
      // fixed-size buffer unless the fd was rewound and re-read);
      // we still treat it as a categorical refusal because the
      // bound is the only safety guarantee the daemon has.
      bytesRead = readSync(fd, buf, 0, SYSTEMD_CREDENTIAL_MAX_BYTES, 0);
    } catch {
      return undefined;
    }

    if (bytesRead <= 0) {
      // Zero-byte or negative read: empty source.  systemd
      // `LoadCredential=` never produces an empty credential file;
      // a deployment that accidentally injects one is a
      // configuration error and must not start the daemon.
      return undefined;
    }

    // Slice the read window out of the bounded buffer.  If the
    // kernel returned more than the bound (defensive: should be
    // impossible for a single `readSync` into a `MAX`-sized
    // buffer), refuse categorically.
    if (bytesRead > SYSTEMD_CREDENTIAL_MAX_BYTES) {
      return undefined;
    }
    // The opened-fd size is the expected complete read length.  Any
    // mismatch means the source changed or the read was short, so do
    // not accept a partial or newly-grown credential.
    if (bytesRead !== stat.size) {
      return undefined;
    }
    // A full buffer does not itself prove EOF: the source could have
    // grown after fstat. Probe exactly one additional byte without
    // increasing the credential allocation bound. Any byte at offset
    // MAX means the source exceeds the allowed size and is refused.
    if (bytesRead === SYSTEMD_CREDENTIAL_MAX_BYTES) {
      const probe = Buffer.allocUnsafe(1);
      let probeRead = 0;
      try {
        probeRead = readSync(fd, probe, 0, 1, SYSTEMD_CREDENTIAL_MAX_BYTES);
      } catch {
        return undefined;
      }
      if (probeRead !== 0) {
        return undefined;
      }
    }

    const raw = buf.subarray(0, bytesRead).toString("utf8");

    // Empty or whitespace-only → refused.
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    return trimmed;
  } finally {
    // Close the fd in `finally` so every refusal path (stat
    // failure, oversized, non-regular, short read) still releases
    // the kernel handle.  A close failure is swallowed because the
    // contract is never-throw; we have already returned the
    // categorical refusal at that point.
    try {
      closeSync(fd);
    } catch {
      // ignore — fd is best-effort closed; the OS will reclaim it
      // when the process exits.
    }
  }
}

/**
 * Validate `name` as a plain credential filename.
 *
 * Rules:
 *
 *   - Must be a non-empty string.
 *   - Must not contain path separators (`/` or `\`).
 *   - Must not be a parent-directory traversal segment (`..`).
 *   - Must not contain null bytes or any other whitespace.
 *   - Must not be an absolute path.
 *
 * The validator is intentionally stricter than `path.basename`:
 * a plain filename is exactly what systemd `LoadCredential=` uses
 * under `$CREDENTIALS_DIRECTORY`, and the deployment binds the label
 * to the file by the basename, not by a composed path.
 */
function isPlainCredentialFilename(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0) return false;
  // Reject control characters (U+0000-U+001F and U+007F) categorically.
  // Whitespace-based probes (e.g. /\s/) miss U+001F (US, Information
  // Separator One) and U+007F (DEL); those characters survive the
  // existing whitespace check and reach `join`, leaving a poisoned
  // slot label the file system accepts.  The shared predicate below
  // is the only authoritative control-character check; it must run
  // before either the separator test or the absolute-path test.
  if (hasControlCharacter(name)) return false;
  // NUL is already covered by the predicate above but is called out
  // explicitly because it is the one control character that does not
  // round-trip cleanly through every terminal/encoding surface.
  if (name.includes("\0")) return false;
  // Whitespace of any kind is rejected.
  if (/\s/.test(name)) return false;
  // Path separators are rejected (POSIX slash and Windows backslash
  // for completeness — the daemon runs on Linux but a caller must
  // not be able to influence cross-platform path composition).
  if (name.includes("/") || name.includes("\\")) return false;
  // Traversal is rejected even when `name` is otherwise well-formed.
  if (name === "." || name === "..") return false;
  // Absolute paths are rejected.
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  return true;
}
