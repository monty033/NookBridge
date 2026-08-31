/**
 * `nookd` process entry point.
 *
 * The transport implementation is exported for the service composition layer.
 * Startup configuration and production credential wiring are intentionally
 * deferred to the service-configuration task; this entry point therefore
 * fails closed instead of inventing defaults or touching live state.
 */

import { fileURLToPath } from "node:url";
import process from "node:process";

export {
  createNookdServer,
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
  type StartNookdServerOptions,
} from "./service/nookd-server.js";

export type NookdCliOutput = Readonly<{
  stdout: Readonly<{ write: (chunk: string) => unknown }>;
  stderr: Readonly<{ write: (chunk: string) => unknown }>;
}>;

const HELP =
  "Usage: nookd --help\n\nThe production configuration-driven daemon entry point is not enabled in this build.\n";
const CONFIGURATION_UNAVAILABLE =
  "nookd: configuration-driven startup is unavailable; refusing to use implicit defaults\n";

/**
 * Run the intentionally fail-closed pre-configuration CLI surface.
 *
 * Only `--help` is accepted until the strict service-configuration task wires
 * a root-owned configuration path and approved credential contract.
 */
export function runNookdCli(
  argv: readonly string[] = process.argv.slice(2),
  output: NookdCliOutput = process,
): number {
  if (argv.length === 1 && argv[0] === "--help") {
    output.stdout.write(HELP);
    return 0;
  }
  output.stderr.write(CONFIGURATION_UNAVAILABLE);
  return 64;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runNookdCli();
}
