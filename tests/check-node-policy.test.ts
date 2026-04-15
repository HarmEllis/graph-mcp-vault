import { describe, expect, it } from "vitest";
import { checkNodePolicy } from "../scripts/ci/check-node-policy.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function workflow(steps: string): string {
  return `
jobs:
  ci:
    steps:
${steps}
`;
}

// ── Workflows without setup-node ──────────────────────────────────────────────

describe("workflows without setup-node", () => {
  it("returns no violations for a workflow with no steps", () => {
    expect(checkNodePolicy("jobs:\n  ci:\n    steps: []", "ci.yml")).toHaveLength(
      0,
    );
  });

  it("returns no violations for a workflow that only uses other actions", () => {
    const yaml = workflow(
      "      - name: Checkout\n        uses: actions/checkout@abc123def456abc123def456abc123def456abc123",
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("returns no violations when the workflow has no jobs key", () => {
    expect(checkNodePolicy("name: Empty\n", "empty.yml")).toHaveLength(0);
  });
});

// ── node-version present ──────────────────────────────────────────────────────

describe("node-version present", () => {
  it("returns no violations when node-version is the integer 24", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version: 24",
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("returns no violations when node-version is the string '24'", () => {
    const yaml = workflow(
      '      - uses: actions/setup-node@abc123\n        with:\n          node-version: "24"',
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("returns no violations when node-version is '24.x'", () => {
    const yaml = workflow(
      '      - uses: actions/setup-node@abc123\n        with:\n          node-version: "24.x"',
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("returns no violations when node-version is '24.1.0'", () => {
    const yaml = workflow(
      '      - uses: actions/setup-node@abc123\n        with:\n          node-version: "24.1.0"',
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("returns a violation when node-version is 22", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version: 22",
    );
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("22");
  });

  it("returns a violation when node-version is '20.x'", () => {
    const yaml = workflow(
      '      - uses: actions/setup-node@abc123\n        with:\n          node-version: "20.x"',
    );
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("20.x");
  });
});

// ── node-version precedence over node-version-file ────────────────────────────

describe("node-version precedence", () => {
  it("uses node-version for validation when both inputs are present and node-version is 24", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version: 24\n          node-version-file: .nvmrc",
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("uses node-version for validation when both inputs are present and node-version is wrong", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version: 20\n          node-version-file: .nvmrc",
    );
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("20");
  });
});

// ── node-version-file only ────────────────────────────────────────────────────

describe("node-version-file only", () => {
  it("returns no violations when only node-version-file is specified", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version-file: .nvmrc",
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });

  it("returns no violations when node-version-file points to package.json", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version-file: package.json",
    );
    expect(checkNodePolicy(yaml, "ci.yml")).toHaveLength(0);
  });
});

// ── No version specified ──────────────────────────────────────────────────────

describe("no version specified", () => {
  it("returns a violation when neither node-version nor node-version-file is present", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123",
    );
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("no node-version");
  });

  it("returns a violation when the with block exists but neither version input is set", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          cache: pnpm",
    );
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations).toHaveLength(1);
  });
});

// ── Multiple violations ───────────────────────────────────────────────────────

describe("multiple jobs and steps", () => {
  it("reports violations from multiple jobs independently", () => {
    const yaml = `
jobs:
  job1:
    steps:
      - uses: actions/setup-node@abc123
        with:
          node-version: 20
  job2:
    steps:
      - uses: actions/setup-node@abc123
        with:
          node-version: 18
`;
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations).toHaveLength(2);
  });

  it("reports the correct job name in each violation", () => {
    const yaml = `
jobs:
  bad-job:
    steps:
      - uses: actions/setup-node@abc123
        with:
          node-version: 20
`;
    const violations = checkNodePolicy(yaml, "ci.yml");
    expect(violations[0]?.job).toBe("bad-job");
  });

  it("includes the filename in each violation", () => {
    const yaml = workflow(
      "      - uses: actions/setup-node@abc123\n        with:\n          node-version: 20",
    );
    const violations = checkNodePolicy(yaml, "my-workflow.yml");
    expect(violations[0]?.file).toBe("my-workflow.yml");
  });
});
