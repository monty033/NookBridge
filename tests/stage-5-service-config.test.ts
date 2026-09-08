/**
 * Stage 5 Task 6 — strict service configuration + operator diagnostics.
 *
 * The daemon is configured only through a small root-owned, non-secret
 * configuration surface.  This suite covers that surface and the
 * accompanying `--check-config <absolute-config-path>` operator command.
 *
 * Test categories:
 *
 *   1. Schema rejection — relative paths, broad unsafe roots, unknown
 *      fields, wrong types, missing required slots, credential path
 *      leakage, generic env-override behavior.
 *   2. Strict selection — backend must be the literal
 *      `systemd-credential` id; the development-file id is refused.
 *   3. Read-policy allowlist — the legacy exact ordered four-method tuple
 *      remains accepted, and the deployed outbound-sync tuple additionally
 *      accepts the bounded `notes.sync` method.
 *   4. Root-ownership seam — the loader can be told to verify the
 *      config file is owned by the current uid (root in the deployed
 *      case) and is not group/world writable; the verifier accepts an
 *      explicit stat seam so tests can run as non-root.
 *   5. Categorical errors — no raw paths, credential labels, or
 *      diagnostic messages leak through the public API.
 *   6. `checkServiceConfig` / `formatCheckReport` — pass/fail only,
 *      backend id exposed on pass, no raw paths or field values.
 *   7. `runNookdCli` `--check-config <absolute-config-path>` — exit 0
 *      on pass, nonzero on fail, never exposes paths or values.
 *
 * The suite is RED-first: every test below targets a public contract
 * that the implementation under `src/config/service-config.ts` and
 * the CLI surface under `src/nookd.ts` must satisfy.
 */

import { Buffer } from "node:buffer";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import {
  loadServiceConfig,
  checkServiceConfig,
  formatCheckReport,
  isServiceConfigError,
  SERVICE_CONFIG_ERROR_CATEGORIES,
} from "../src/config/service-config.js";
import { runNookdCli } from "../src/nookd.js";

/**
 * The canonical, smallest valid service config — what a deployment
 * rooted at `/var/lib/nookbridge` would write.  All paths are absolute
 * so the schema accepts them without a resolver step.
 */
const VALID_FIXTURE = {
  stateDir: "/var/lib/nookbridge",
  socketPath: "/run/nookbridge/nookbridge.sock",
  socketGroup: "nookbridge-clients",
  backend: "systemd-credential",
  credentialName: "nookbridge-db-key",
  readPolicy: ["notes.search", "notes.status", "notes.list_notebooks", "notes.get"],
} as const;

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "nookbridge-stage5-svc-cfg-"));
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

/**
 * Write the given fixture as JSON, return the absolute path of the
 * file.  Tests pass the result to `loadServiceConfig`.
 */
function writeJsonConfig(name: string, payload: unknown): string {
  const dir = join(workspaceRoot, `${name}-dir`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  return file;
}

/**
 * Build a config object that differs from the valid fixture ONLY in
 * the listed override.  Keeping this in one helper means tests can
 * target exactly one rejection case each without manually re-typing
 * the rest of the valid surface.
 */
function mutate(
  patch: Partial<{
    stateDir: string;
    socketPath: string;
    socketGroup: string;
    backend: string;
    credentialName: string;
    readPolicy: readonly string[] | string;
  }>,
): MutatedConfig {
  return {
    stateDir: patch.stateDir ?? VALID_FIXTURE.stateDir,
    socketPath: patch.socketPath ?? VALID_FIXTURE.socketPath,
    socketGroup: patch.socketGroup ?? VALID_FIXTURE.socketGroup,
    backend: patch.backend ?? VALID_FIXTURE.backend,
    credentialName: patch.credentialName ?? VALID_FIXTURE.credentialName,
    readPolicy: patch.readPolicy ?? [...VALID_FIXTURE.readPolicy],
  };
}

// A fully-typed view of the mutate() output so tests can pass it to
// JSON.stringify without the `unknown` widening tripping strict TS.
type MutatedConfig = {
  stateDir: string;
  socketPath: string;
  socketGroup: string;
  backend: string;
  credentialName: string;
  readPolicy: readonly string[] | string;
};

/** A safe stat seam — pretend the file is owned by the current uid. */
const ROOT_OWNED_STAT_SEAM = {
  stat: (path: string) => {
    const st = lstatSync(path);
    return { uid: 0, gid: 0, mode: st.mode, dev: st.dev, ino: st.ino };
  },
};

/** A stat seam that pretends the file is owned by a non-root uid. */
const NON_ROOT_STAT_SEAM = {
  stat: (path: string) => {
    const st = lstatSync(path);
    return { uid: 1000, gid: 1000, mode: st.mode, dev: st.dev, ino: st.ino };
  },
};

describe("Stage 5 strict service configuration", () => {
  describe("valid config acceptance", () => {
    it("accepts the canonical service config exactly as written", () => {
      const file = writeJsonConfig("valid", VALID_FIXTURE);
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.config).toEqual({
        stateDir: "/var/lib/nookbridge",
        socketPath: "/run/nookbridge/nookbridge.sock",
        socketGroup: "nookbridge-clients",
        backend: "systemd-credential",
        credentialName: "nookbridge-db-key",
        readPolicy: ["notes.search", "notes.status", "notes.list_notebooks", "notes.get"],
      });
    });

    it("accepts the deployed outbound-sync policy", () => {
      const fixture = {
        ...VALID_FIXTURE,
        readPolicy: [
          "notes.search",
          "notes.status",
          "notes.list_notebooks",
          "notes.get",
          "notes.create",
          "notes.append",
          "notes.update",
          "notes.sync",
        ],
      };
      const file = writeJsonConfig("valid-outbound-sync", fixture);
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.config.readPolicy).toEqual(fixture.readPolicy);
    });

    it("uses the production lstat path without a test seam", () => {
      const file = writeJsonConfig("valid-production-stat", VALID_FIXTURE);
      const result = loadServiceConfig(file);
      if (process.getuid?.() === 0) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error.category).toBe("unsafe_config_owner");
      }
    });

    it("accepts a nested service-owned state directory", () => {
      const fixture = {
        stateDir: "/var/lib/nookbridge/test-instance",
        socketPath: "/run/nookbridge/test-instance.sock",
        socketGroup: "nookbridge-clients",
        backend: "systemd-credential",
        credentialName: "nookbridge-db-key",
        readPolicy: ["notes.search", "notes.status", "notes.list_notebooks", "notes.get"],
      };
      const file = writeJsonConfig("valid-runtime", fixture);
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(true);
    });
  });

  describe("schema rejection (categorical errors only)", () => {
    it.each([
      ["relative stateDir", { stateDir: "var/lib/nookbridge" }, "unsafe_state_dir"],
      ["stateDir under /", { stateDir: "/var/lib/nookbridge/.." }, "unsafe_state_dir"],
      ["stateDir under /tmp", { stateDir: "/tmp/nookbridge" }, "unsafe_state_dir"],
      ["stateDir under /run", { stateDir: "/run/nookbridge" }, "unsafe_state_dir"],
      ["stateDir under /etc", { stateDir: "/etc/nookbridge" }, "unsafe_state_dir"],
      ["stateDir under /home", { stateDir: "/home/hermes/nookbridge" }, "unsafe_state_dir"],
      ["stateDir under /var (broad)", { stateDir: "/var" }, "unsafe_state_dir"],
    ])("rejects %s", (_label, patch, expectedCategory) => {
      const file = writeJsonConfig("bad-state", mutate(patch));
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe(expectedCategory);
      // Categorical errors must not echo any path or credential label.
      expect(JSON.stringify(result)).not.toContain("/var");
      expect(JSON.stringify(result)).not.toContain("nookbridge-db-key");
      expect(JSON.stringify(result)).not.toContain(VALID_FIXTURE.socketGroup);
    });

    it("rejects control-bearing state and socket paths before normalization", () => {
      const stateFile = writeJsonConfig(
        "bad-state-control",
        mutate({ stateDir: "/var/lib/nookbridge/\u0000canary" }),
      );
      const stateResult = loadServiceConfig(stateFile, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(stateResult.ok).toBe(false);
      if (stateResult.ok) throw new Error("unreachable");
      expect(stateResult.error.category).toBe("unsafe_state_dir");

      const socketFile = writeJsonConfig(
        "bad-socket-control",
        mutate({ socketPath: "/run/nookbridge/nookbridge.sock\u001bcanary" }),
      );
      const socketResult = loadServiceConfig(socketFile, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(socketResult.ok).toBe(false);
      if (socketResult.ok) throw new Error("unreachable");
      expect(socketResult.error.category).toBe("invalid_socket_path");
    });

    it("rejects relative socket paths", () => {
      const file = writeJsonConfig("bad-sock-rel", mutate({ socketPath: "nookbridge.sock" }));
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("invalid_socket_path");
    });

    it.each(["\u001f", "\u007f"])(
      "rejects a socket path containing a non-trailing control character (U+%s)",
      (control) => {
        const file = writeJsonConfig(
          "bad-sock-control-inline",
          mutate({ socketPath: `/run/nookbridge/nookbridge.sock${control}canary` }),
        );
        const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error.category).toBe("invalid_socket_path");
        // The canary suffix must never appear in the categorical error.
        expect(JSON.stringify(result)).not.toContain("canary");
      },
    );

    it("rejects a non-canonical socket path that resolves through .. traversal", () => {
      // resolve() strips the .. segment, so /run/nookbridge/a/../b.sock
      // is textually inside the allowlist but is NOT canonical form.
      // The canonicalization check is the only way a hostile operator
      // can be stopped from using a sibling service-owned root to land
      // the socket.
      const file = writeJsonConfig(
        "bad-sock-canonical",
        mutate({ socketPath: "/run/nookbridge/a/../b.sock" }),
      );
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("invalid_socket_path");
    });

    it("rejects unsafe broad socket paths", () => {
      for (const unsafe of ["/", "/tmp/nookbridge.sock", "/run", "/etc/nookbridge.sock"]) {
        const file = writeJsonConfig("bad-sock-broad", mutate({ socketPath: unsafe }));
        const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error.category).toBe("invalid_socket_path");
      }
    });

    it("rejects an empty or non-conformant socket group", () => {
      for (const group of ["", " ", "nookbridge clients", "nookbridge/clients", "..", "  bad"]) {
        const file = writeJsonConfig("bad-sock-group", mutate({ socketGroup: group }));
        const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error.category).toBe("invalid_socket_group");
      }
    });

    it("rejects a non-systemd-credential backend id", () => {
      const file = writeJsonConfig("bad-backend", mutate({ backend: "development-file" }));
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("invalid_backend");
    });

    it("rejects a credential name that does not match the public label", () => {
      const file = writeJsonConfig("bad-cred-name", mutate({ credentialName: "db-key" }));
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("invalid_credential_name");
    });

    it("accepts the legacy four-entry readPolicy and bounded write-capable subsets", () => {
      for (const policy of [
        VALID_FIXTURE.readPolicy,
        ["notes.search", "notes.create"],
        ["notes.append", "notes.update"],
        [
          "notes.search",
          "notes.status",
          "notes.list_notebooks",
          "notes.get",
          "notes.create",
          "notes.append",
          "notes.update",
        ],
      ]) {
        const file = writeJsonConfig("valid-write-policy", mutate({ readPolicy: policy }));
        const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.config.readPolicy).toEqual(policy);
        expect(Object.isFrozen(result.config.readPolicy)).toBe(true);
      }
    });

    it("rejects readPolicy entries outside the closed RpcMethod universe", () => {
      for (const policy of [
        [],
        ["notes.write"],
        ["notes.search", "anything-else"],
        ["NOTES.SEARCH"],
        "notes.search",
      ]) {
        const file = writeJsonConfig("bad-read-policy", mutate({ readPolicy: policy }));
        const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error.category).toBe("invalid_read_policy");
      }
    });

    it("rejects duplicate readPolicy entries instead of widening by normalization", () => {
      const file = writeJsonConfig("duplicate-read-policy", {
        ...VALID_FIXTURE,
        readPolicy: ["notes.search", "notes.search"],
      });
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("invalid_read_policy");
    });

    it("rejects unknown top-level fields", () => {
      const file = writeJsonConfig("unknown-field", {
        ...VALID_FIXTURE,
        devKeyFile: "/tmp/dev.key",
        credentialPath: "/var/lib/nookbridge/key",
        envOverrides: { NOOKBRIDGE_KEY: "..." },
      });
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("unknown_field");
    });

    it("rejects credential paths supplied through config", () => {
      const file = writeJsonConfig("cred-path", {
        ...VALID_FIXTURE,
        credentialPath: "/var/lib/nookbridge/key",
      });
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("forbidden_credential_path");
    });

    it("rejects generic env-override fields even when well-typed", () => {
      const file = writeJsonConfig("env-overrides", {
        ...VALID_FIXTURE,
        envOverrides: { NOOKBRIDGE_DB_KEY: "..." },
      });
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("forbidden_env_override");
    });

    it("rejects duplicate top-level keys", () => {
      const file = mkdirThenWrite(
        "dup-keys",
        `{"stateDir":"${VALID_FIXTURE.stateDir}",` +
          `"socketPath":"${VALID_FIXTURE.socketPath}",` +
          `"socketGroup":"${VALID_FIXTURE.socketGroup}",` +
          `"backend":"${VALID_FIXTURE.backend}",` +
          `"credentialName":"${VALID_FIXTURE.credentialName}",` +
          `"readPolicy":["notes.search","notes.status","notes.list_notebooks","notes.get"],` +
          `"stateDir":"/another/place"}`,
      );
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("duplicate_field");
    });

    it("rejects wrong types for required fields", () => {
      const file = writeJsonConfig("bad-types", {
        stateDir: 42,
        socketPath: ["/run/nookbridge/nookbridge.sock"],
        socketGroup: null,
        backend: { name: "systemd-credential" },
        credentialName: "nookbridge-db-key",
        readPolicy: "notes.search",
      });
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("invalid_type");
    });

    it("rejects a config file owned by a non-root uid", () => {
      const file = writeJsonConfig("non-root", VALID_FIXTURE);
      const result = loadServiceConfig(file, { stat: NON_ROOT_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("unsafe_config_owner");
    });

    it("rejects a config file that is group or world writable", () => {
      const file = writeJsonConfig("group-writable", VALID_FIXTURE);
      chmodSync(file, 0o664);
      const result = loadServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("unsafe_config_mode");
      chmodSync(file, 0o600);
    });

    it("rejects a symlink instead of treating it as the service config", () => {
      const target = writeJsonConfig("symlink-target", VALID_FIXTURE);
      const link = join(workspaceRoot, "symlink-config.json");
      symlinkSync(target, link);
      const result = loadServiceConfig(link, {
        stat: (path: string) => {
          const st = lstatSync(path);
          return { uid: 0, gid: 0, mode: st.mode, dev: st.dev, ino: st.ino };
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.category).toBe("unsafe_config_type");
    });
  });

  describe("diagnostic surface (checkServiceConfig / formatCheckReport)", () => {
    it("reports pass + the canonical backend id on a valid config", () => {
      const file = writeJsonConfig("check-pass", VALID_FIXTURE);
      const report = checkServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(report.status).toBe("pass");
      expect(report.backend).toBe("systemd-credential");
      expect(report.errors).toEqual([]);
      const human = formatCheckReport(report);
      // Categorical only: never the path or any field value.
      expect(human.includes(file)).toBe(false);
      expect(human.includes(VALID_FIXTURE.socketGroup)).toBe(false);
      expect(human).toContain("systemd-credential");
    });

    it("reports fail with categorical categories on a bad config", () => {
      const file = writeJsonConfig("check-fail", mutate({ backend: "development-file" }));
      const report = checkServiceConfig(file, { stat: ROOT_OWNED_STAT_SEAM.stat });
      expect(report.status).toBe("fail");
      expect(report.backend).toBeUndefined();
      expect(report.errors.length).toBeGreaterThan(0);
      const human = formatCheckReport(report);
      expect(human.includes(file)).toBe(false);
      expect(human.includes("development-file")).toBe(false);
    });
  });

  describe("categorical error types", () => {
    it("exposes a frozen category vocabulary", () => {
      expect(SERVICE_CONFIG_ERROR_CATEGORIES).toEqual(
        expect.arrayContaining([
          "unknown_field",
          "duplicate_field",
          "invalid_type",
          "unsafe_state_dir",
          "invalid_socket_path",
          "invalid_socket_group",
          "invalid_backend",
          "invalid_credential_name",
          "invalid_read_policy",
          "forbidden_credential_path",
          "forbidden_env_override",
          "unsafe_config_owner",
          "unsafe_config_mode",
          "unsafe_config_type",
          "config_unreadable",
          "config_malformed_json",
        ]),
      );
    });

    it("isServiceConfigError discriminates the categorical Error class", () => {
      expect(typeof isServiceConfigError).toBe("function");
      // A plain Error is NOT a service-config error.
      expect(isServiceConfigError(new Error("anything"))).toBe(false);
      // A non-Error is not a service-config error.
      expect(isServiceConfigError("anything")).toBe(false);
    });
  });
});

describe("loader path argument guard", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["relative path", "config.json"],
    ["dot-relative path", "./config.json"],
    ["parent-relative path", "../config.json"],
    ["absolute non-canonical path", "/etc/../etc/hostname"],
    ["absolute bare path with control U+0000", "/etc/nookbridge/config.json\u0000canary"],
    ["absolute path with control U+001F", "/etc/nookbridge/config.json\u001fcanary"],
    ["absolute path with control U+007F", "/etc/nookbridge/config.json\u007fcanary"],
  ])("rejects a %s without touching readFileSync", (_label, hostile) => {
    // Cast through unknown so the deliberately-typed invalid path
    // arguments can be exercised without bypassing the test file's
    // own type checking.
    const result = loadServiceConfig(hostile as unknown as string, {
      stat: ROOT_OWNED_STAT_SEAM.stat,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.category).toBe("config_unreadable");
    // Categorical errors must not echo the input path or any segment.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("config.json");
    expect(serialized).not.toContain("canary");
    expect(serialized).not.toContain("\u0000");
  });
});

describe("nookd --check-config operator command", () => {
  it("accepts --check-config <absolute-config-path> and exits 0 on pass", () => {
    const file = writeJsonConfig("cli-pass", VALID_FIXTURE);
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    // Use the same stat seam used by the loader when running as root.
    const code = runNookdCli(["--check-config", file], stdout, stderr, {
      stat: ROOT_OWNED_STAT_SEAM.stat,
    });
    expect(code).toBe(0);
    // stdout reports categorical pass + backend id; never the path or values.
    const out = stdout.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toContain("pass");
    expect(out).toContain("systemd-credential");
    expect(out.includes(file)).toBe(false);
    expect(out.includes(VALID_FIXTURE.socketGroup)).toBe(false);
    // No leakage to stderr on pass.
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("rejects --check-config with a non-absolute path before touching disk", () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = runNookdCli(["--check-config", "config.json"], stdout, stderr, {
      stat: ROOT_OWNED_STAT_SEAM.stat,
    });
    expect(code).not.toBe(0);
    // Fail message must be categorical; never echo the input path verbatim.
    const err = stderr.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(err.includes("config.json")).toBe(false);
  });

  it.each(["--check-config", "--config"])(
    "rejects %s with a control-bearing absolute config path before touching disk",
    (flag) => {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const canaryPath = `${join(workspaceRoot, "config.json")}\u007fcanary`;

      const code = runNookdCli([flag, canaryPath], stdout, stderr, {
        stat: ROOT_OWNED_STAT_SEAM.stat,
      });

      expect(code).toBe(64);
      const err = stderr.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(err).toContain("invalid configuration argument");
      expect(err).not.toContain("canary");
    },
  );

  it("rejects --check-config with a failing config and reports categorical fail", () => {
    const file = writeJsonConfig("cli-fail", mutate({ backend: "development-file" }));
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = runNookdCli(["--check-config", file], stdout, stderr, {
      stat: ROOT_OWNED_STAT_SEAM.stat,
    });
    expect(code).not.toBe(0);
    const err = stderr.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(err).toContain("fail");
    expect(err.includes("development-file")).toBe(false);
    expect(err.includes(file)).toBe(false);
  });

  it("rejects --check-config with a missing flag value", () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = runNookdCli(["--check-config"], stdout, stderr, {
      stat: ROOT_OWNED_STAT_SEAM.stat,
    });
    expect(code).not.toBe(0);
  });

  it("retains the fail-closed default for all other argv (production startup still off)", () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    expect(runNookdCli([], stdout, stderr, { stat: ROOT_OWNED_STAT_SEAM.stat })).toBe(64);
    expect(
      runNookdCli(["--socket-path", "/run/nookbridge/nookbridge.sock"], stdout, stderr, {
        stat: ROOT_OWNED_STAT_SEAM.stat,
      }),
    ).toBe(64);
  });
});

function mkdirThenWrite(name: string, body: string): string {
  const dir = join(workspaceRoot, `${name}-dir`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "config.json");
  // Buffer indirection keeps the lint config happy about raw strings.
  writeFileSync(file, Buffer.from(body, "utf8"), { mode: 0o600 });
  return file;
}
