import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

describe("docs and service-policy agree that readWriteNoDelete excludes delete (P-1)", () => {
  it("docs/configuration.md says delete is not part of readWriteNoDelete", () => {
    expect(read("docs/configuration.md")).toContain(
      "it is not part of the `readWriteNoDelete` profile",
    );
  });

  it("docs/reference/mcp-tools.md says delete is not included in readWriteNoDelete", () => {
    expect(read("docs/reference/mcp-tools.md")).toContain(
      "It is not included in `readWriteNoDelete`",
    );
  });

  it("service-policy.ts docstring no longer claims readWriteNoDelete admits delete", () => {
    expect(read("src/service/service-policy.ts")).not.toContain("append, update, delete, and sync");
  });
});
