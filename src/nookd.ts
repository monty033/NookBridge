/**
 * `nookd` process entry point.
 *
 * The transport implementation is exported for the service composition layer.
 * Startup configuration and production credential wiring are intentionally
 * deferred to the deployment task; this entry point therefore fails closed
 * instead of inventing defaults or touching live state.
 */

import process from "node:process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkServiceConfig,
  formatCheckReport,
  type LoadServiceConfigOptions,
} from "./config/service-config.js";

export {
  createNookdServer,
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
  type StartNookdServerOptions,
} from "./service/nookd-server.js";

export {
  SERVICE_CONFIG_BACKEND,
  SERVICE_CONFIG_CREDENTIAL_NAME,
  SERVICE_CONFIG_ERROR_CATEGORIES,
  SERVICE_CONFIG_READ_POLICY,
  ServiceConfigError,
  checkServiceConfig,
  formatCheckReport,
  isServiceConfigError,
  loadServiceConfig,
  type LoadServiceConfigOptions,
  type LoadServiceConfigResult,
  type ServiceConfig,
  type ServiceConfigCheckReport,
  type ServiceConfigErrorCategory,
  type ServiceConfigStat,
} from "./config/service-config.js";

export type NookdOutputStream = Readonly<{ write: (chunk: string) => unknown }>;
export type NookdCliOutput = Readonly<{
  stdout: NookdOutputStream;
  stderr: NookdOutputStream;
}>;

const HELP =
  "Usage: nookd --help\n       nookd --check-config <absolute-config-path>\n\nThe production daemon remains disabled until deployment wiring is installed.\n";
const CONFIGURATION_UNAVAILABLE =
  "nookd: configuration-driven startup is unavailable; refusing to use implicit defaults\n";
const INVALID_CONFIG_ARGUMENT =
  "nookd: invalid configuration argument; refusing to inspect an unvalidated path\n";

/**
 * Run the fail-closed pre-deployment CLI surface.
 *
 * The two-stream form is retained for the focused server tests; the combined
 * `{ stdout, stderr }` form is convenient for callers and remains supported.
 */
export function runNookdCli(
  argv: readonly string[] = process.argv.slice(2),
  output: NookdCliOutput | NookdOutputStream = process,
  stderrOrOptions?: NookdOutputStream | LoadServiceConfigOptions,
  options: LoadServiceConfigOptions = {},
): number {
  const stdout = "stdout" in output ? output.stdout : output;
  let stderr = "stderr" in output ? output.stderr : process.stderr;
  let checkOptions = options;

  if (stderrOrOptions !== undefined) {
    if ("write" in stderrOrOptions) {
      stderr = stderrOrOptions;
    } else {
      checkOptions = stderrOrOptions;
    }
  }

  if (argv.length === 1 && argv[0] === "--help") {
    stdout.write(HELP);
    return 0;
  }

  if (argv.length === 2 && argv[0] === "--check-config") {
    const configPath = argv[1];
    if (typeof configPath !== "string" || !isAbsolute(configPath)) {
      stderr.write(INVALID_CONFIG_ARGUMENT);
      return 64;
    }
    const report = checkServiceConfig(configPath, checkOptions);
    const text = `${formatCheckReport(report)}\n`;
    if (report.status === "pass") {
      stdout.write(text);
      return 0;
    }
    stderr.write(text);
    return 78;
  }

  stderr.write(CONFIGURATION_UNAVAILABLE);
  return 64;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runNookdCli();
}
