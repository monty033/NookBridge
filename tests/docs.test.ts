import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

const plan = read("docs/implementation-plan-v1.5.md");
const status = read("docs/project-status.md");

const SECTION_1320 = "## 13.20 ";
const SECTION_1321 = "## 13.21 ";
const APPENDIX = "# Appendix A. Research Sources";

const section1320 = plan.indexOf(SECTION_1320);
const section1321 = plan.indexOf(SECTION_1321);
const appendix = plan.indexOf(APPENDIX);
const slice = plan.slice(section1321, appendix);

/** PR, merge commit, change commit, plan step — as merged on upstream/main. */
const rows: ReadonlyArray<readonly [string, string, string, string]> = [
  ["#200", "8751aee", "adcfc56", "D4-2"],
  ["#201", "2386366", "6128fec", "P-1"],
  ["#202", "511cb48", "59a378e", "D4-4"],
  ["#203", "d4e2fa0", "e5b625d", "D4-3"],
  ["#204", "e22087a", "38499d2", "D4-1"],
  ["#205", "1681556", "7be006e", "R7"],
  ["#206", "f5e2ad2", "2f11c4f", "D2-1"],
  ["#207", "b88dff1", "2f67ad4", "D2-2"],
  ["#208", "48182d5", "e7512ea", "D3-2"],
  ["#209", "68155a1", "67dcf78", "R1"],
  ["#210", "4ab3f4b", "d8cfe85", "R2a"],
  ["#211", "509a552", "8e00d59", "R2b"],
  ["#212", "de60b00", "c353dc1", "R2b follow-up"],
  ["#213", "9d6155a", "b523e2e", "R2b follow-up (B3)"],
  ["#214", "2b2b886", "b6c14d6", "R2c"],
  ["#215", "977f0d4", "9e11b0d", "R6"],
  ["#216", "ea67312", "2decc88", "R2d"],
];

describe("roadmap reconciliation §13.21 (R14)", () => {
  it("places §13.21 after §13.20 and before Appendix A", () => {
    expect(section1320, "§13.20 heading is missing").toBeGreaterThan(-1);
    expect(section1321, "§13.21 heading is missing").toBeGreaterThan(section1320);
    expect(appendix, "Appendix A heading is missing").toBeGreaterThan(section1321);
    expect(slice, "§13.21 slice is empty").not.toBe("");
    expect(slice).toContain("Roadmap reconciliation");
  });

  it.each(rows)("records PR %s with its merge commit and plan step", (pr, merge, change, step) => {
    expect(section1321, "§13.21 heading is missing").toBeGreaterThan(-1);
    expect(appendix, "Appendix A heading is missing").toBeGreaterThan(section1321);

    const line = slice.split("\n").find((candidate) => {
      const cells = candidate.split("|").map((cell) => cell.trim());
      return cells[0] === "" && cells[1] === pr;
    });

    expect(line, `missing §13.21 row for ${pr}`).toBeDefined();
    const cells = (line ?? "").split("|").map((cell) => cell.trim());
    expect(cells[2], `wrong merge commit for ${pr}`).toContain(merge);
    expect(cells[3], `wrong change commit for ${pr}`).toContain(change);
    expect(cells[4], `wrong plan step for ${pr}`).toBe(step);
  });

  it("preserves §13.20's historical P1-9 status text unchanged", () => {
    expect(section1320, "§13.20 heading is missing").toBeGreaterThan(-1);
    expect(plan.slice(section1320, section1321)).toContain(
      "PHASE 1 IMPLEMENTED, PENDING REVIEW AND MERGE",
    );
  });

  it("records #202 in project status and no longer lists a generic-code collapse as open", () => {
    expect(status).toContain("#202");
    expect(status).not.toMatch(/generic[- ]code collapse/i);
  });

  it("keeps §13.21 free of credentials and secret-shaped values", () => {
    expect(slice, "§13.21 slice is empty").not.toBe("");

    expect(slice).not.toMatch(/rev_[0-9a-f]{32}/);
    expect(slice).not.toMatch(/NOOKBRIDGE_DATABASE_KEY=/);
    expect(slice).not.toMatch(/password\s*[:=]/i);
  });
});
