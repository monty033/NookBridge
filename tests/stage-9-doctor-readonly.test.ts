/** Stage 9 regression: doctor diagnostics must not mutate encrypted state. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor/doctor.js";
import { ensureStateDir } from "../src/config/state-dir.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Stage 9 doctor read-only boundary", () => {
  it("does not create a doctor_probe table while checking the encrypted database", async () => {
    const root = mkdtempSync(join(tmpdir(), "nookbridge-stage9-doctor-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const dbPath = join(stateDir, "nookbridge.db");
    const key = "stage9-doctor-test-key";
    ensureStateDir(stateDir);

    const initial = new SqliteStorage({ dbPath, key });
    initial.close();

    const report = await runDoctor({ stateDir, dbPath, dbKey: key });
    expect(report.checks.find((check) => check.id === "db-decrypt")).toMatchObject({
      status: "pass",
    });

    const inspected = new SqliteStorage({ dbPath, key });
    const probe = inspected.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      ["table", "doctor_probe"],
    );
    inspected.close();

    expect(probe).toBeUndefined();
  });
});
