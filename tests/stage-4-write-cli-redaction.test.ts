import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

describe("Stage 4 write CLI output boundary", () => {
  it("keeps state paths and write inputs out of the shipped command output", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage4-cli-"));
    const title = "NookBridge Stage 4 output-boundary canary";
    const distCli = join(process.cwd(), "dist/cli.js");

    try {
      execFileSync("npm", ["run", "build"], { stdio: "ignore" });
      expect(existsSync(distCli)).toBe(true);

      const result = spawnSync(process.execPath, [distCli, "write", "create", "--title", title], {
        encoding: "utf8",
        env: {
          ...process.env,
          NOOKBRIDGE_ENABLE_LIVE_SYNC: "1",
          NOOKBRIDGE_STATE_DIR: stateDir,
        },
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      expect(result.status).toBe(0);
      expect(output).toContain("local-committed");
      expect(output).not.toContain(stateDir);
      expect(output).not.toContain("dbPath");
      expect(output).not.toContain(title);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      if (existsSync(distCli)) rmSync(distCli);
    }
  });
});
