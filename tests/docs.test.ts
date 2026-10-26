import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

const plan = read("docs/implementation-plan-v1.5.md");
const status = read("docs/project-status.md");
const mcpTools = read("docs/reference/mcp-tools.md");
const security = read("docs/security-and-privacy.md");
const cli = read("docs/reference/cli.md");

const OPERATOR_SURFACE = "## Operator surface";
const operatorSurfaceStart = security.indexOf(OPERATOR_SURFACE);
const finalThreatParagraph = security.indexOf("For detailed threat model", operatorSurfaceStart);
const operatorSurface =
  operatorSurfaceStart === -1 || finalThreatParagraph === -1
    ? ""
    : security.slice(operatorSurfaceStart, finalThreatParagraph);

const INPUT_RULES = "## Input rules";
const inputRulesStart = cli.indexOf(INPUT_RULES);
const productionWrappers = cli.indexOf("## Production wrappers", inputRulesStart);
const inputRules =
  inputRulesStart === -1 || productionWrappers === -1
    ? ""
    : cli.slice(inputRulesStart, productionWrappers);

const notesCliRow = cli.split("\n").find((candidate) => candidate.startsWith("| `notes`"));

/** The historical operator-notes upload-gap paragraph, before the 2026-10-22 update. */
const historicalUploadGap = (() => {
  const start = status.indexOf("**What this does not prove.**");
  const end = status.indexOf("**Update 2026-10-22.**");
  return start === -1 || end === -1 ? "" : status.slice(start, end);
})();

const SECTION_36 = "## 3.6 ";
const SECTION_37 = "## 3.7 ";
const SECTION_1320 = "## 13.20 ";
const SECTION_1321 = "## 13.21 ";
const SECTION_1322 = "## 13.22 ";
const APPENDIX = "# Appendix A. Research Sources";

const section1320 = plan.indexOf(SECTION_1320);
const section1321 = plan.indexOf(SECTION_1321);
const appendix = plan.indexOf(APPENDIX);

/**
 * §13.21's slice ends at the next `## 13.` heading, so a later section cannot
 * leak into it. Before §13.22 existed this resolves to the Appendix heading.
 */
const nextSection13 = plan.indexOf("\n## 13.", section1321 + SECTION_1321.length);
const sliceEnd1321 = nextSection13 === -1 ? appendix : nextSection13;
const slice = plan.slice(section1321, sliceEnd1321);

const section36 = plan.indexOf(SECTION_36);
const section37 = plan.indexOf(SECTION_37);
const syncPolicy = plan.slice(section36, section37);

const section1322 = plan.indexOf(SECTION_1322);
const section1323 = plan.indexOf("## 13.23 ");
const slice1323 = section1323 === -1 ? "" : plan.slice(section1323, appendix);

const slice1322 =
  section1322 === -1 ? "" : plan.slice(section1322, section1323 === -1 ? appendix : section1323);

/** §13.22's implementation order, from its heading to the end of the slice. */
const implementationOrder1322 = (() => {
  const marker = "### Implementation order";
  const start = slice1322.indexOf(marker);
  return start === -1 ? "" : slice1322.slice(start);
})();

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

describe("DR-S7a §13.22 (S7a-0)", () => {
  it("places exactly one §13.22 heading after §13.21 and before Appendix A", () => {
    expect(section1321, "§13.21 heading is missing").toBeGreaterThan(-1);
    expect(appendix, "Appendix A heading is missing").toBeGreaterThan(section1321);
    expect(plan.split(SECTION_1322), "expected exactly one §13.22 heading").toHaveLength(2);
    expect(section1322).toBeGreaterThan(section1321);
    expect(appendix).toBeGreaterThan(section1322);
  });

  it("records the DR identifier, exact sentence, approval and date", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");

    expect(slice1322).toContain("DR-S7a");
    expect(slice1322).toContain("No upload without explicit sync intent.");
    expect(slice1322).toContain("approved by Patrick (decision 1)");
    expect(slice1322).toContain("2026-10-21");
  });

  it("names the executor, the explicit sync request, the fetch boundary and the refusal", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");

    for (const term of [
      "createLiveRemoteSyncExecutor",
      "notes.sync",
      '{ type: "fetch" }',
      "unapproved_pending",
      "dirty set",
      "operator-origin",
      "S7a-1",
    ]) {
      expect(slice1322, `§13.22 is missing ${term}`).toContain(term);
    }
  });

  it("records the resolved decision 5 approval mechanism", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");

    expect(slice1322).toContain("decision 5");
    expect(slice1322).toContain("### Decision 5 — operator upload approval");
    expect(slice1322).toContain("notes.approve-upload");

    expect(slice1322).not.toContain("uploadIntent");
    expect(slice1322).not.toMatch(/notes\.approve(?!-upload)/);
  });

  it("puts S7a-5 before S7a-4 in the implementation order and says S7a-4 merges after", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");
    expect(implementationOrder1322, "§13.22 implementation order is missing").not.toBe("");

    const s7a5 = implementationOrder1322.indexOf("S7a-5");
    const s7a4 = implementationOrder1322.indexOf("S7a-4");

    expect(s7a5, "implementation order does not name S7a-5").toBeGreaterThan(-1);
    expect(s7a4, "implementation order does not name S7a-4").toBeGreaterThan(s7a5);
    expect(implementationOrder1322).toMatch(/merges \*\*after\*\* S7a-5/);
  });

  it("notes the DR-S7a supersession in §3.6", () => {
    expect(section36, "§3.6 heading is missing").toBeGreaterThan(-1);
    expect(section37, "§3.7 heading is missing").toBeGreaterThan(section36);

    expect(syncPolicy).toContain("DR-S7a");
    expect(syncPolicy).toContain("§13.22");
  });

  it("keeps DR-S7a out of the §13.21 slice", () => {
    expect(slice, "§13.21 slice is empty").not.toBe("");

    expect(slice).not.toContain("DR-S7a");
  });

  it("keeps §13.22 free of credentials and secret-shaped values", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");

    expect(slice1322).not.toMatch(/rev_[0-9a-f]{32}/);
    expect(slice1322).not.toMatch(/NOOKBRIDGE_DATABASE_KEY=/);
    expect(slice1322).not.toMatch(/password\s*[:=]/i);
  });

  it("keeps the historical upload-gap paragraph scoped to its own section", () => {
    expect(historicalUploadGap, "historical upload-gap paragraph is missing").not.toBe("");
    expect(historicalUploadGap).toContain("`pendingSync: true`");
    expect(historicalUploadGap).toContain("open defect, not a closed boundary");
  });
});

describe("S7a-7 — upload gap closed in docs", () => {
  it("removes the open-defect statements from project status", () => {
    expect(status).not.toContain(
      "The dedicated lock proof and the `pendingSync` upload gap remain open",
    );
    expect(status).not.toContain("The other two defects remain open and untouched");
  });

  it("records the closure, the approval boundary and the source-evidence limit", () => {
    for (const term of ["unapproved_pending", "#238", "decision 5", "#227", "source evidence"]) {
      expect(status, `project status is missing ${term}`).toContain(term);
    }
  });

  it("states the residual limit of the marked-write closure", () => {
    expect(status.replace(/\s+/g, " ")).toContain(
      "does not fully close the `pendingSync` upload gap",
    );
    expect(status).toContain("DR-S7a item 4");
    expect(status).toContain("attachments.pending");
  });

  it("keeps the historical acknowledgement", () => {
    expect(status).toContain("That was wrong.");
  });

  it("documents the sync refusal and the create error distinction", () => {
    const syncRow = mcpTools
      .split("\n")
      .find((candidate) => candidate.startsWith("| `notesnook_sync`"));

    expect(syncRow, "missing notesnook_sync row").toBeDefined();
    expect(syncRow, "sync row must mention the refusal").toContain("unapproved_pending");
    expect(syncRow, "sync row must cover a malformed batch").toContain("malformed");
    expect(syncRow, "sync row must tell the caller not to retry").toContain("Do not retry");

    expect(mcpTools).toContain("Unapproved pending changes");

    const sentences = mcpTools.split(/(?<=[.!?])\s+/);
    expect(
      sentences.some(
        (sentence) =>
          sentence.includes("sync_failed") && sentence.includes("nothing was committed"),
      ),
      "expected a sentence distinguishing sync_failed from a committed write",
    ).toBe(true);

    expect(mcpTools).toContain("local_sync_marker_failed");
  });

  it("documents the refusal in the §6.1 sync row", () => {
    const syncRow = plan
      .split("\n")
      .find((candidate) => candidate.startsWith("| `notesnook_sync`"));

    expect(syncRow, "missing §6.1 notesnook_sync row").toBeDefined();
    expect(syncRow, "§6.1 sync row must mention the refusal").toContain("unapproved_pending");
    expect(syncRow, "§6.1 sync row must cover a malformed batch").toContain("malformed");
    expect(syncRow, "§6.1 sync row must tell the caller not to retry").toContain("Do not retry");
    expect(syncRow, "§6.1 sync row must cite the decision record").toContain("§13.22");
  });

  it("extends the §3.6 supersession note with the refusal", () => {
    expect(syncPolicy, "§3.6 slice is empty").not.toBe("");
    expect(syncPolicy).toContain("unapproved_pending");
  });

  it("records the implementation in §13.22", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");

    for (const term of [
      "Implementation record",
      "#234",
      "#235",
      "#236",
      "#237",
      "#238",
      "item 5 applies",
      "unknown",
      "source only",
      "separate numbering",
      "Step S7a-4",
    ]) {
      expect(slice1322, `§13.22 is missing ${term}`).toContain(term);
    }
  });

  it("keeps DR-S7a item 4 and the approval line verbatim", () => {
    expect(slice1322, "§13.22 slice is empty").not.toBe("");

    expect(slice1322).toContain(
      "Before `full`, the executor reads the upstream dirty set read-only. It refuses with the categorical reason `unapproved_pending` if any dirty item lacks recorded intent, or if the dirty set can't be read.",
    );
    expect(slice1322).toContain("(not built; see the implementation record below)");
    expect(slice1322).toContain("approved by Patrick (decision 1)");

    expect(slice1322).not.toContain("uploadIntent");
    expect(slice1322).not.toMatch(/notes\.approve(?!-upload)/);
  });
});

describe("DOC-1 - operator surface propositions", () => {
  const propositions: ReadonlyArray<readonly [string, string]> = [
    [
      "S1",
      "Operator reads of a specific note - `nookctl notes get` and the edit preimage that `nookctl notes edit` fetches - are refused with `permission_denied` unless the note's handle was issued to the same caller, the note's notebook path resolves, and the notebook policy allows `read`.",
    ],
    [
      "S2",
      "A note that is not in any notebook (a root-level note) is always refused for these operator reads, and so is a note whose notebook cannot be resolved.",
    ],
    [
      "S3",
      "The operator socket serves only callers whose peer credentials resolve; a connection whose credentials cannot be read is closed before any request is handled.",
    ],
    [
      "S4",
      "Inside the daemon, the discovery runtime's `browse`, `search`, `view` and `create` entry points each refuse a call that carries no well-formed caller identity with `permission_denied`; there is no shared or anonymous identity.",
    ],
    [
      "S5",
      "Note handles, browse and search cursors, and recorded operations belong to the caller that created them and do not resolve for any other caller.",
    ],
    [
      "S6",
      "The locked-note proof reports, for one exact note path, only `pathBytes` and one result each for `read`, `update` and `delete`. Each result is one of exactly five codes: `vault_locked`, `ok`, `not_found`, `permission_denied`, `service_unavailable`. The report never includes note text, titles, identifiers, revisions, paths, or error messages.",
    ],
    [
      "S7",
      "The proof never modifies an unlocked note: for an unlocked target it reports `read: ok` and `permission_denied` for `update` and `delete` without attempting either.",
    ],
    [
      "S8",
      "For a locked target it attempts update and delete only with a deliberately mismatched revision.",
    ],
    [
      "S9",
      "The proof is authorized before its path is resolved: the caller needs read, edit and delete permission for that path, and a path the caller may not access returns `permission_denied` whether or not the note exists.",
    ],
    [
      "S10",
      "`nookctl notes get` returns the strict Markdown projection when the note decodes under the strict rules; otherwise it returns a read-only approximation in which unrecognised formatting is dropped, images appear as `[image]`, attachments appear as `[attachment: <name>]` or `[attachment]`, and no source URLs or attachment data are included. The approximation is not an edit preimage: `nookctl notes edit` still uses the strict decoding and reports such a note as unavailable for editing.",
    ],
  ];

  it("places exactly one operator surface section before the final threat-model paragraph", () => {
    expect(
      security.split(OPERATOR_SURFACE),
      "expected exactly one operator surface heading",
    ).toHaveLength(2);
    expect(operatorSurfaceStart, "operator surface heading is missing").toBeGreaterThan(-1);
    expect(
      finalThreatParagraph,
      "final threat-model paragraph is missing after the operator surface",
    ).toBeGreaterThan(operatorSurfaceStart);
    expect(operatorSurface, "operator surface slice is empty").not.toBe("");
  });

  it.each(propositions)("pins operator surface proposition %s verbatim", (label, sentence) => {
    expect(operatorSurface, "operator surface slice is empty").not.toBe("");
    expect(operatorSurface, `operator surface is missing ${label}`).toContain(sentence);
  });

  it("appends the exact-path exception to the CLI input rules", () => {
    expect(inputRules, "CLI input rules slice is empty").not.toBe("");
    expect(inputRules).toContain(
      "Two notes commands take an exact note path as an ordinary argument: `nookctl notes locked-note-proof --path <path>` and `nookctl notes path-diagnostic --path <path>`. The path is visible in the process arguments, so use them only with canary or diagnostic paths. `locked-note-proof` also requires `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`.",
    );
  });

  it("appends the approximation caveat to the notes row's safety column", () => {
    expect(notesCliRow, "missing `notes` CLI row").toBeDefined();
    expect(notesCliRow).toContain(
      "`get` may return a read-only approximation that is not an edit preimage; see [security and privacy](../security-and-privacy.md#operator-surface).",
    );
  });
});

describe("R16 exact response byte accounting §13.23", () => {
  it("records the R16 decision in §13.23, before Appendix A", () => {
    expect(section1323, "§13.23 heading is missing").toBeGreaterThan(section1322);
    expect(slice1323).toContain("Decision record R16");
    expect(slice1323).toContain("decision 10 acknowledged by Patrick, 2026-10-24");
    expect(slice1323).toContain("replaces the flat 6x");
    expect(slice1323).toContain("unchanged at 65,536");
    expect(slice1323).toContain("charges the request id");
    expect(slice1323).toContain("per-item structure");
    expect(slice1323).toContain("about 64,466");
  });

  it("states the exact content bound verbatim and cross-references it", () => {
    expect(security).toContain(
      "The content bound is the response budget (`maxResponseBytes`, 65,536 bytes) less a fixed 1,024-byte envelope allowance, the echoed request id, and the note's charged metadata (id, title, revision and notebook id), measured as exact JSON-encoded UTF-8 size; text dense in control characters costs up to six bytes per character.",
    );
    expect(mcpTools).toContain("../security-and-privacy.md#privacy-boundary-for-agents");
  });
});
