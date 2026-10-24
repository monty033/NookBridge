/* global process */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type InventoryResult = {
  ok: boolean;
  missing: string[];
  extra: string[];
  unlicensed: string[];
};

type VerifyArtifactInventory = (options: {
  nodeModulesDir: string;
  inventoryCsv: string;
}) => InventoryResult;

const script = resolve(process.cwd(), "scripts/verify-artifact-inventory.mjs");
const modulePath = pathToFileURL(script).href;
const { verifyArtifactInventory } = (await import(modulePath)) as {
  verifyArtifactInventory: VerifyArtifactInventory;
};

const fixtureRoots: string[] = [];

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): { root: string; nodeModulesDir: string; inventoryCsv: string } {
  const root = mkdtempSync(join(tmpdir(), "nookbridge-artifact-inventory-"));
  fixtureRoots.push(root);
  const nodeModulesDir = join(root, "node_modules");

  writePackage(nodeModulesDir, "a", "1.0.0", "MIT");
  writePackage(nodeModulesDir, "@scope/b", "2.0.0", { type: "Apache-2.0" });
  writePackage(join(nodeModulesDir, "a", "node_modules"), "c", "3.0.0", "ISC");
  writePackage(nodeModulesDir, "d", "4.0.0", "MIT");

  const binDir = join(nodeModulesDir, ".bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(nodeModulesDir, "a"), join(binDir, "a"));

  return { root, nodeModulesDir, inventoryCsv: join(root, "licenses.csv") };
}

function writePackage(
  nodeModulesDir: string,
  packageName: string,
  version: string,
  license: string | { type: string } | undefined,
): void {
  const packageDir = join(nodeModulesDir, ...packageName.split("/"));
  mkdirSync(packageDir, { recursive: true });
  const metadata: Record<string, unknown> = { name: packageName, version };
  if (license !== undefined) metadata.license = license;
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(metadata));
}

function writeInventory(
  path: string,
  rows: Array<{ name: string; version: string; license: string }>,
  header = "package,version,license",
): void {
  const lines = [header, ...rows.map((row) => `${row.name},${row.version},${row.license}`)];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function completeRows(): Array<{ name: string; version: string; license: string }> {
  return [
    { name: "a", version: "1.0.0", license: "MIT" },
    { name: "@scope/b", version: "2.0.0", license: "Apache-2.0" },
    { name: "c", version: "3.0.0", license: "ISC" },
    { name: "d", version: "4.0.0", license: "MIT" },
  ];
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runFixtureCli(fixture: { nodeModulesDir: string; inventoryCsv: string }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return runCli(["--node-modules", fixture.nodeModulesDir, "--inventory", fixture.inventoryCsv]);
}

// The single owner-approved override the checker ships. The script keys it by
// exact name@version and records the parent package as the source of the
// licence, because the platform subpackage omits the field upstream.
const overridePackage = { name: "sqlite-regex-linux-x64", version: "0.2.4-alpha.1" };
const overrideProvenance =
  "sqlite-regex@0.2.4-alpha.1 declares (MIT OR Apache-2.0); this platform subpackage omits the field upstream";

describe("Stage 9 artifact dependency inventory", () => {
  it("accepts an inventory that matches the shipped tree", async () => {
    const fixture = createFixture();
    writeInventory(fixture.inventoryCsv, completeRows());

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result).toEqual({ ok: true, missing: [], extra: [], unlicensed: [] });

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toBe("artifact inventory ok (4 packages)\n");
    expect(cli.stderr).toBe("");
  });

  it("reports packages that ship but are absent from the inventory", async () => {
    const fixture = createFixture();
    writeInventory(
      fixture.inventoryCsv,
      completeRows().filter((row) => row.name !== "d"),
    );

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["d@4.0.0"]);
    expect(result.extra).toEqual([]);
    expect(result.unlicensed).toEqual([]);

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("missing:");
    expect(cli.stdout).toContain("d@4.0.0");
  });

  it("reports inventory rows that do not ship", async () => {
    const fixture = createFixture();
    writeInventory(fixture.inventoryCsv, [
      ...completeRows(),
      { name: "e", version: "5.0.0", license: "MIT" },
    ]);

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual(["e@5.0.0"]);
    expect(result.unlicensed).toEqual([]);

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("extra:");
    expect(cli.stdout).toContain("e@5.0.0");
  });

  it("reports shipped packages that have no usable license", async () => {
    const fixture = createFixture();
    writePackage(join(fixture.nodeModulesDir, "a", "node_modules"), "c", "3.0.0", undefined);
    writeInventory(fixture.inventoryCsv, completeRows());

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.unlicensed).toEqual(["c@3.0.0"]);

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("unlicensed:");
    expect(cli.stdout).toContain("c@3.0.0");
  });

  it("records an owner-approved override for a package that ships no license", async () => {
    const fixture = createFixture();
    writePackage(fixture.nodeModulesDir, overridePackage.name, overridePackage.version, undefined);
    writeInventory(fixture.inventoryCsv, [
      ...completeRows(),
      { ...overridePackage, license: "MIT OR Apache-2.0" },
    ]);

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result).toEqual({ ok: true, missing: [], extra: [], unlicensed: [] });

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe("");
    // The audit trail names the applied override, its source, and its approval
    // date, and the success line keeps its exact shape.
    expect(cli.stdout).toBe(
      [
        "license overrides applied (1):",
        `  ${overridePackage.name}@${overridePackage.version} -> MIT OR Apache-2.0`,
        `    source: ${overrideProvenance}`,
        "    approved: 2026-10-24",
        "artifact inventory ok (5 packages)",
        "",
      ].join("\n"),
    );
  });

  it("still reports packages with no license and no override as unlicensed", async () => {
    const fixture = createFixture();
    writePackage(fixture.nodeModulesDir, "e", "5.0.0", undefined);
    // Same name as the override, different version: the table is keyed by the
    // exact name@version, so a near miss must not inherit the exception.
    writePackage(fixture.nodeModulesDir, overridePackage.name, "0.2.4-alpha.2", undefined);
    writeInventory(fixture.inventoryCsv, [
      ...completeRows(),
      { name: "e", version: "5.0.0", license: "MIT" },
      { name: overridePackage.name, version: "0.2.4-alpha.2", license: "MIT" },
    ]);

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.unlicensed).toEqual(["e@5.0.0", "sqlite-regex-linux-x64@0.2.4-alpha.2"]);

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("unlicensed:");
    expect(cli.stdout).toContain("  e@5.0.0\n");
    expect(cli.stdout).toContain("  sqlite-regex-linux-x64@0.2.4-alpha.2\n");
    expect(cli.stdout).not.toContain("license overrides applied");
    expect(cli.stdout).not.toContain("artifact inventory ok");
  });

  it("does not mask a package that declares its own license", async () => {
    const fixture = createFixture();
    writePackage(
      fixture.nodeModulesDir,
      overridePackage.name,
      overridePackage.version,
      "GPL-3.0-only",
    );
    writeInventory(fixture.inventoryCsv, [
      ...completeRows(),
      { ...overridePackage, license: "GPL-3.0-only" },
    ]);

    const result = await verifyArtifactInventory({
      nodeModulesDir: fixture.nodeModulesDir,
      inventoryCsv: fixture.inventoryCsv,
    });

    expect(result).toEqual({ ok: true, missing: [], extra: [], unlicensed: [] });

    const cli = runFixtureCli(fixture);
    expect(cli.status).toBe(0);
    // The declared licence wins: no override is applied or reported for a
    // package that states terms of its own.
    expect(cli.stdout).toBe("artifact inventory ok (5 packages)\n");
    expect(cli.stdout).not.toContain("MIT OR Apache-2.0");
    expect(cli.stdout).not.toContain("license overrides applied");
  });

  it("keeps applied overrides auditable when the run fails for another reason", () => {
    const fixture = createFixture();
    writePackage(fixture.nodeModulesDir, overridePackage.name, overridePackage.version, undefined);
    writePackage(fixture.nodeModulesDir, "e", "5.0.0", undefined);
    writeInventory(fixture.inventoryCsv, [
      ...completeRows(),
      { ...overridePackage, license: "MIT OR Apache-2.0" },
      { name: "e", version: "5.0.0", license: "MIT" },
    ]);

    const cli = runFixtureCli(fixture);

    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("unlicensed 1)");
    expect(cli.stdout).toContain("license overrides applied (1):");
    expect(cli.stdout).toContain(
      `  ${overridePackage.name}@${overridePackage.version} -> MIT OR Apache-2.0`,
    );
    expect(cli.stdout).toContain(`    source: ${overrideProvenance}`);
    expect(cli.stdout).toContain("    approved: 2026-10-24");
    // The overridden package is audited above, not hidden in the failure lists:
    // only the genuinely unlicensed package is reported.
    expect(cli.stdout).toContain("unlicensed:\n  e@5.0.0\n");
    expect(cli.stdout).not.toContain(`  ${overridePackage.name}@${overridePackage.version}\n`);
  });

  it("refuses a symlinked package without following it", () => {
    const fixture = createFixture();
    const outside = mkdtempSync(join(tmpdir(), "nookbridge-artifact-inventory-outside-"));
    fixtureRoots.push(outside);
    writeFileSync(join(outside, "package.json"), "{ this is not json");
    symlinkSync(outside, join(fixture.nodeModulesDir, "x"));
    writeInventory(fixture.inventoryCsv, completeRows());

    const cli = runFixtureCli(fixture);

    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("unexpected symlink");
    // Following the link would read malformed JSON and exit 2, so a 1 proves the
    // directory outside the fixture was never inspected.
    expect(cli.status).not.toBe(2);
  });

  it("exits 2 for malformed input, a bad header, and missing arguments", () => {
    const fixture = createFixture();

    writeInventory(fixture.inventoryCsv, completeRows());
    mkdirSync(join(fixture.nodeModulesDir, "broken"), { recursive: true });
    writeFileSync(join(fixture.nodeModulesDir, "broken", "package.json"), "{ not json");
    const malformedJson = runFixtureCli(fixture);
    expect(malformedJson.status).toBe(2);

    writeInventory(fixture.inventoryCsv, completeRows(), "name,version,license");
    const badHeader = runFixtureCli(fixture);
    expect(badHeader.status).toBe(2);

    const missingArgument = runCli(["--node-modules", fixture.nodeModulesDir]);
    expect(missingArgument.status).toBe(2);
  });

  it("never prints absolute fixture or working-directory paths", () => {
    const fixture = createFixture();
    writeInventory(
      fixture.inventoryCsv,
      completeRows().filter((row) => row.name !== "d"),
    );

    const cases = [runFixtureCli(fixture)];

    const symlinkFixture = createFixture();
    const outside = mkdtempSync(join(tmpdir(), "nookbridge-artifact-inventory-outside-"));
    fixtureRoots.push(outside);
    writeFileSync(join(outside, "package.json"), "{ this is not json");
    symlinkSync(outside, join(symlinkFixture.nodeModulesDir, "x"));
    writeInventory(symlinkFixture.inventoryCsv, completeRows());
    cases.push(runFixtureCli(symlinkFixture));

    const malformedFixture = createFixture();
    writeInventory(malformedFixture.inventoryCsv, completeRows());
    mkdirSync(join(malformedFixture.nodeModulesDir, "broken"), { recursive: true });
    writeFileSync(join(malformedFixture.nodeModulesDir, "broken", "package.json"), "{ not json");
    cases.push(runFixtureCli(malformedFixture));

    for (const result of cases) {
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(fixture.root);
      expect(output).not.toContain(symlinkFixture.root);
      expect(output).not.toContain(malformedFixture.root);
      expect(output).not.toContain(process.cwd());
    }
  });
});
