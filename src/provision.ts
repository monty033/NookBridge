#!/usr/bin/env node
/**
 * Production NookBridge account provisioning entrypoint.
 *
 * This command is intentionally separate from the development `nookctl`
 * auth tree.  It can only operate when launched by the Nix-provided
 * systemd-run wrapper, which supplies CREDENTIALS_DIRECTORY and the
 * production database credential.  Credentials are collected only through
 * the existing echo-disabled TTY prompt and are never printed or returned.
 */

import process from "node:process";

import { runAuthCommand } from "./auth/admin-command.js";
import type { LiveLoginRuntime } from "./auth/admin-command.js";
import { createStdioPrompt, type SecretPrompt } from "./auth/secret-input.js";
import {
  createProductionOperatorRuntime,
  readSafeOperatorEnvironment,
} from "./operator/production-runtime.js";

const USAGE = "Usage: nookbridge-provision [--help]";

type RunProvisionOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  createPrompt?: () => SecretPrompt;
  createRuntime?: () => Promise<LiveLoginRuntime>;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}>;

/**
 * Run one interactive production provisioning attempt.
 *
 * The injectable prompt/runtime/output seams are test-only.  Production
 * callers use the defaults, which bind the prompt to the current TTY and the
 * runtime to the systemd credential directory supplied by the wrapper.
 */
export async function runProvision(options: RunProvisionOptions): Promise<number> {
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));

  if (options.argv.length === 1 && (options.argv[0] === "--help" || options.argv[0] === "-h")) {
    writeOut(`${USAGE}\n`);
    return 0;
  }
  if (options.argv.length !== 0) {
    writeErr(`${USAGE}\n`);
    return 2;
  }

  let environment: Readonly<Record<string, string | undefined>>;
  try {
    environment = readSafeOperatorEnvironment(options.env);
  } catch {
    writeErr("nookbridge-provision: invalid command environment\n");
    return 2;
  }

  const createPrompt = options.createPrompt ?? (() => createStdioPrompt());
  const createRuntime =
    options.createRuntime ?? (() => createProductionOperatorRuntime(environment));

  const result = await runAuthCommand({
    argv: ["live-login"],
    env: environment,
    liveLogin: {
      stateDir: "/var/lib/nookbridge",
      createPrompt,
      createRuntime: async () => createRuntime(),
    },
  });

  if (result.kind === "live-login") {
    writeOut("nookbridge-provision: authenticated\n");
    return 0;
  }
  if (result.kind === "error") {
    // Do not forward even categorical runner text here: this entrypoint's
    // output is deliberately stable and cannot contain upstream details.
    writeErr("nookbridge-provision: failed\n");
    return result.exitCode;
  }
  writeErr("nookbridge-provision: failed\n");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProvision({ argv: process.argv.slice(2), env: process.env }).then((code) => {
    process.exit(code);
  });
}
