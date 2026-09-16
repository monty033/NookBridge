/**
 * Generic systemd installer contract.
 *
 * These tests exercise the installer without root, Nix builds, systemd, or
 * credentials. The installer must expose a deterministic render mode so the
 * unit contract can be reviewed before installation.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = resolve(repositoryRoot, "scripts/install-systemd.sh");

function runInstaller(...args: string[]): string {
  return execFileSync("bash", [installer, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("generic systemd installer", () => {
  it("provides help without requiring root or external commands", () => {
    const help = runInstaller("--help");

    expect(help).toContain("Usage: install-systemd.sh");
    expect(help).toContain("--settings-file");
    expect(help).toContain("--db-key-file");
    expect(help).toContain("--force");
  });

  it("renders a service unit with fixed credential labels and hardening", () => {
    const output = runInstaller(
      "--print-units",
      "--package-root",
      "/nix/store/nookbridge-test",
      "--settings-file",
      "/etc/nookbridge/settings.json",
      "--db-key-file",
      "/etc/nookbridge/db-key",
    );

    expect(output).toContain("[Unit]");
    expect(output).toContain(
      "ExecStart=/nix/store/nookbridge-test/bin/nookd --config /etc/nookbridge/service.json",
    );
    expect(output).toContain("LoadCredential=nookbridge-db-key:/etc/nookbridge/db-key");
    expect(output).toContain("LoadCredential=nookbridge-settings:/etc/nookbridge/settings.json");
    expect(output).toContain("User=nookbridge");
    expect(output).toContain("Group=nookbridge-clients");
    expect(output).toContain("ProtectSystem=strict");
    expect(output).toContain("NoNewPrivileges=yes");
    expect(output).toContain("Operator wrappers use systemd-run --pty");
  });

  it("keeps the installer source free of credential values", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).not.toMatch(/NOOKBRIDGE_(?:PASSWORD|TOKEN|SECRET)=/);
    expect(source).not.toContain("cat ");
  });
});
