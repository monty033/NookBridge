import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const builder = join(repositoryRoot, "scripts", "build-linux-artifact.sh");
const fixtureRoots: string[] = [];

function createSourceFixture(): { source: string; nodeRuntime: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-builder-test-"));
  fixtureRoots.push(root);
  const source = join(root, "source");
  const output = join(root, "output");
  const nodeRuntime = join(root, "node-runtime");
  const realNodeRuntime = join(root, "node-runtime-real");
  mkdirSync(join(source, "dist", "mcp"), { recursive: true });
  mkdirSync(join(source, "dist"), { recursive: true });
  mkdirSync(join(source, "node_modules", "native"), { recursive: true });
  writeFileSync(join(source, "dist", "nookd.js"), "console.log('nookd')\n");
  writeFileSync(join(source, "dist", "cli.js"), "console.log('cli')\n");
  writeFileSync(join(source, "dist", "mcp", "cli.js"), "console.log('mcp')\n");
  writeFileSync(join(source, "dist", "provision.js"), "console.log('provision')\n");
  writeFileSync(join(source, "dist", "sync.js"), "console.log('sync')\n");
  writeFileSync(join(source, "dist", "health.js"), "console.log('health')\n");
  writeFileSync(join(source, "dist", "runtime-check.js"), "console.log('runtime-check')\n");
  writeFileSync(join(source, "node_modules", "native", "addon.node"), "native\n");
  symlinkSync("addon.node", join(source, "node_modules", "native", "link.node"));
  writeFileSync(join(source, "package.json"), '{"name":"nookbridge","version":"0.0.0-stage.0"}\n');
  writeFileSync(join(source, "package-lock.json"), '{"name":"nookbridge","lockfileVersion":3}\n');
  writeFileSync(join(source, "LICENSE"), "GPL-3.0-or-later\n");
  writeFileSync(
    realNodeRuntime,
    '#!/bin/sh\ncase "$1" in\n  --version) printf "v22.23.2\\n" ;;\n  -p) printf "127\\n" ;;\n  *) exit 1 ;;\nesac\n',
  );
  execFileSync("chmod", ["0755", realNodeRuntime]);
  symlinkSync(realNodeRuntime, nodeRuntime);
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "config", "user.email", "builder-test@example.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "NookBridge Builder Test"]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "fixture"]);
  return { source, nodeRuntime, output };
}

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { force: true, recursive: true });
  fixtureRoots.length = 0;
});

describe("Linux artifact builder", () => {
  it("assembles and verifies a self-contained x86_64 glibc release", () => {
    const fixture = createSourceFixture();
    const result = spawnSync(
      "bash",
      [
        builder,
        "--source-dir",
        fixture.source,
        "--node-runtime",
        fixture.nodeRuntime,
        "--output-dir",
        fixture.output,
        "--version",
        "1.2.3",
        "--source-date-epoch",
        "1790000000",
        "--min-glibc",
        "2.31",
        "--min-libstdcxx",
        "GLIBCXX_3.4.29",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("nookbridge-artifact build ok\n");
    expect(result.stderr).toBe("");

    const artifact = join(fixture.output, "nookbridge-v1.2.3-linux-x64-gnu.tar.gz");
    const checksum = join(fixture.output, "SHA256SUMS");
    expect(readFileSync(checksum, "utf8")).toContain("nookbridge-v1.2.3-linux-x64-gnu.tar.gz");
    const members = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" });
    const listing = execFileSync("tar", ["-tvzf", artifact], { encoding: "utf8" });
    expect(listing).toMatch(/drwxr-xr-x .* nookbridge-v1\.2\.3\/$/m);
    expect(members).toContain("nookbridge-v1.2.3/bin/nookd");
    expect(members).toContain("nookbridge-v1.2.3/runtime/bin/node");
    expect(members).toContain("nookbridge-v1.2.3/app/node_modules/native/addon.node");
    expect(members).toContain("nookbridge-v1.2.3/app/node_modules/native/link.node");
    expect(
      execFileSync(
        "tar",
        ["-xOzf", artifact, "nookbridge-v1.2.3/app/node_modules/native/link.node"],
        {
          encoding: "utf8",
        },
      ),
    ).toBe("native\n");
    expect(members).not.toContain("/nix/store");
  });

  it("refuses a dirty source tree before producing an artifact", () => {
    const fixture = createSourceFixture();
    writeFileSync(join(fixture.source, "dirty.txt"), "dirty\n");
    const result = spawnSync(
      "bash",
      [
        builder,
        "--source-dir",
        fixture.source,
        "--node-runtime",
        fixture.nodeRuntime,
        "--output-dir",
        fixture.output,
        "--version",
        "1.2.3",
        "--source-date-epoch",
        "1790000000",
        "--min-glibc",
        "2.31",
        "--min-libstdcxx",
        "GLIBCXX_3.4.29",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nookbridge-artifact build failed\n");
  });
});
