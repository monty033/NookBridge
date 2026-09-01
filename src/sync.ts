#!/usr/bin/env node
/**
 * Production NookBridge fetch-only sync entrypoint.
 *
 * This command opens the daemon's encrypted state with the systemd credential
 * backend and runs only the existing read-only proof's `sync({type: "fetch"})`
 * operation.  It has no login, write, or full-sync mode.
 */

import process from "node:process";

import { formatSyncCommandResult, runSyncCommand } from "./core/notesnook-sync-admin.js";
import {
  createProductionOperatorRuntime,
  readSafeOperatorEnvironment,
} from "./operator/production-runtime.js";

const USAGE = "Usage: nookbridge-sync [--help]";

type RunSyncOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}>;

/** Run one production fetch-only sync attempt. */
export async function runProductionSync(options: RunSyncOptions): Promise<number> {
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
    writeErr("nookbridge-sync: invalid command environment\n");
    return 2;
  }

  const result = await runSyncCommand({
    argv: ["read-only"],
    env: environment,
    createProofRuntime: async () => {
      const runtime = await createProductionOperatorRuntime(environment);
      if (runtime.readOnly === undefined) {
        await runtime.cleanup();
        throw new Error("production read-only surface unavailable");
      }
      return {
        source: runtime.readOnly,
        cleanup: runtime.cleanup,
      };
    },
  });

  if (result.kind === "report") {
    writeOut(`${formatSyncCommandResult(result)}\n`);
    return 0;
  }
  if (result.kind === "help") {
    writeOut(result.text);
    return 0;
  }
  // Keep the operator output categorical; the detailed parser/runtime text
  // is intentionally not forwarded from this production boundary.
  writeErr("nookbridge-sync: failed\n");
  return result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionSync({ argv: process.argv.slice(2), env: process.env }).then((code) => {
    process.exit(code);
  });
}
