import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_PACKAGES = 5000;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const CSV_HEADER = ["package", "version", "license"];

class InventoryError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "InventoryError";
    this.exitCode = exitCode;
  }
}

function inventoryError(message, exitCode = 2) {
  return new InventoryError(message, exitCode);
}

function packageKey(name, version) {
  return `${name}@${version}`;
}

function usableLicense(license) {
  if (typeof license === "string") {
    const value = license.trim();
    return value.length > 0 ? value : undefined;
  }
  if (license !== null && typeof license === "object" && !Array.isArray(license)) {
    const type = license.type;
    if (typeof type === "string" && type.trim().length > 0) return type.trim();
  }
  return undefined;
}

function lstatOrFail(path, message) {
  try {
    return lstatSync(path);
  } catch {
    throw inventoryError(message);
  }
}

function readPackageMetadata(packageJsonPath, displayPath) {
  const stats = lstatOrFail(packageJsonPath, "unable to read package.json");
  if (stats.isSymbolicLink()) {
    throw inventoryError(`unexpected symlink: ${displayPath}`, 1);
  }
  if (!stats.isFile()) {
    throw inventoryError("package.json is not a regular file");
  }
  if (stats.size > MAX_PACKAGE_JSON_BYTES) {
    throw inventoryError("package.json exceeds 1 MiB");
  }

  let text;
  try {
    const descriptor = openSync(packageJsonPath, "r");
    try {
      const buffer = Buffer.alloc(MAX_PACKAGE_JSON_BYTES + 1);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PACKAGE_JSON_BYTES) {
        throw inventoryError("package.json exceeds 1 MiB");
      }
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw inventoryError("unable to read package.json");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw inventoryError("malformed package.json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw inventoryError("malformed package.json");
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw inventoryError("malformed package.json");
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw inventoryError("malformed package.json");
  }

  return {
    name: parsed.name,
    version: parsed.version,
    license: usableLicense(parsed.license),
  };
}

function readDirectory(path, message) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    throw inventoryError(message);
  }
}

function visitPackage(packageDir, displayPath, tree) {
  if (tree.count >= MAX_PACKAGES) {
    throw inventoryError(`package cap exceeded (${MAX_PACKAGES})`);
  }

  const stats = lstatOrFail(packageDir, "unable to read package directory");
  if (stats.isSymbolicLink()) {
    throw inventoryError(`unexpected symlink: ${displayPath}`, 1);
  }
  if (!stats.isDirectory()) return;

  const metadata = readPackageMetadata(
    join(packageDir, "package.json"),
    `${displayPath}/package.json`,
  );
  tree.count += 1;
  tree.packages.add(packageKey(metadata.name, metadata.version));
  if (metadata.license === undefined) {
    tree.unlicensed.add(packageKey(metadata.name, metadata.version));
  }

  const nested = join(packageDir, "node_modules");
  let nestedStats;
  try {
    nestedStats = lstatSync(nested);
  } catch {
    return;
  }
  if (nestedStats.isSymbolicLink()) {
    throw inventoryError(`unexpected symlink: ${displayPath}/node_modules`, 1);
  }
  if (nestedStats.isDirectory()) {
    walkNodeModules(nested, `${displayPath}/node_modules`, tree);
  }
}

function walkNodeModules(nodeModulesDir, displayPrefix, tree) {
  const entries = readDirectory(nodeModulesDir, "unable to read node_modules directory");
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    // ".bin" is a directory of command shims, not a package. Skipping it before
    // lstat is deliberate: those shims are symlinks by design.
    if (entry.name.startsWith(".")) continue;

    const entryPath = join(nodeModulesDir, entry.name);
    const displayPath = displayPrefix ? `${displayPrefix}/${entry.name}` : entry.name;
    const stats = lstatOrFail(entryPath, "unable to read node_modules entry");
    if (stats.isSymbolicLink()) {
      throw inventoryError(`unexpected symlink: ${displayPath}`, 1);
    }
    if (!stats.isDirectory()) continue;

    if (entry.name.startsWith("@")) {
      const scoped = readDirectory(entryPath, "unable to read scoped package directory");
      scoped.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of scoped) {
        const childPath = join(entryPath, child.name);
        const childDisplay = displayPrefix
          ? `${displayPrefix}/${entry.name}/${child.name}`
          : `${entry.name}/${child.name}`;
        visitPackage(childPath, childDisplay, tree);
      }
    } else {
      visitPackage(entryPath, displayPath, tree);
    }
  }
}

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ",") {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  if (quoted) throw inventoryError("malformed inventory CSV");
  fields.push(value);
  return fields;
}

function parseInventoryCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "").map((field) => field.trim());
  if (
    header.length !== CSV_HEADER.length ||
    header.some((field, index) => field !== CSV_HEADER[index])
  ) {
    throw inventoryError("malformed inventory CSV header");
  }

  const rows = new Set();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    const fields = parseCsvLine(line).map((field) => field.trim());
    if (fields.length !== CSV_HEADER.length) {
      throw inventoryError("malformed inventory CSV row");
    }
    const [name, version] = fields;
    if (!name || !version) throw inventoryError("malformed inventory CSV row");
    rows.add(packageKey(name, version));
  }
  return rows;
}

function inspectArtifact({ nodeModulesDir, inventoryCsv }) {
  let csvText;
  try {
    csvText = readFileSync(inventoryCsv, "utf8");
  } catch {
    throw inventoryError("unable to read inventory CSV");
  }
  const inventory = parseInventoryCsv(csvText);

  const rootStats = lstatOrFail(nodeModulesDir, "unable to read node_modules directory");
  if (rootStats.isSymbolicLink()) {
    throw inventoryError("unexpected symlink: node_modules", 1);
  }
  if (!rootStats.isDirectory()) {
    throw inventoryError("node_modules is not a directory");
  }

  const tree = { count: 0, packages: new Set(), unlicensed: new Set() };
  walkNodeModules(nodeModulesDir, "", tree);

  const missing = [...tree.packages].filter((key) => !inventory.has(key)).sort();
  const extra = [...inventory].filter((key) => !tree.packages.has(key)).sort();
  const unlicensed = [...tree.unlicensed].sort();

  return {
    result: {
      ok: missing.length === 0 && extra.length === 0 && unlicensed.length === 0,
      missing,
      extra,
      unlicensed,
    },
    total: tree.count,
  };
}

/**
 * Compare the dependency inventory CSV with the packages that are actually
 * present in an artifact's `node_modules` tree.
 *
 * Every package directory in the tree counts, optional or not: optional
 * packages that ship are part of the artifact, and optional packages that do
 * not ship must not appear in release evidence. Symlinks are refused rather
 * than followed so a packaging mistake cannot pull an out-of-tree package into
 * the comparison.
 */
export function verifyArtifactInventory({ nodeModulesDir, inventoryCsv }) {
  const { result } = inspectArtifact({ nodeModulesDir, inventoryCsv });
  return result;
}

function formatFailure(result) {
  const lines = [
    `artifact inventory mismatch (missing ${result.missing.length}, extra ${result.extra.length}, unlicensed ${result.unlicensed.length})`,
  ];
  for (const [label, entries] of [
    ["missing", result.missing],
    ["extra", result.extra],
    ["unlicensed", result.unlicensed],
  ]) {
    if (entries.length === 0) continue;
    lines.push(`${label}:`);
    for (const entry of entries) lines.push(`  ${entry}`);
  }
  return lines;
}

function parseArguments(argv) {
  let nodeModulesDir;
  let inventoryCsv;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--node-modules" && argument !== "--inventory") {
      throw inventoryError(
        "usage: node scripts/verify-artifact-inventory.mjs --node-modules <dir> --inventory <csv>",
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw inventoryError(
        "usage: node scripts/verify-artifact-inventory.mjs --node-modules <dir> --inventory <csv>",
      );
    }
    index += 1;
    if (argument === "--node-modules") nodeModulesDir = value;
    else inventoryCsv = value;
  }

  if (!nodeModulesDir || !inventoryCsv) {
    throw inventoryError(
      "usage: node scripts/verify-artifact-inventory.mjs --node-modules <dir> --inventory <csv>",
    );
  }
  return { nodeModulesDir, inventoryCsv };
}

function runCli(argv) {
  try {
    const options = parseArguments(argv);
    const { result, total } = inspectArtifact(options);
    if (result.ok) {
      console.log(`artifact inventory ok (${total} packages)`);
      return 0;
    }
    for (const line of formatFailure(result)) console.log(line);
    return 1;
  } catch (error) {
    // Error messages are deliberately categorical: release logs carry package
    // names, never absolute artifact paths or the contents of package metadata.
    const message = error instanceof InventoryError ? error.message : "artifact inventory failed";
    console.error(message);
    return error instanceof InventoryError ? error.exitCode : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
