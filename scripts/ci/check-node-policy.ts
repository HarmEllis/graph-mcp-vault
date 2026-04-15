#!/usr/bin/env tsx
/**
 * check-node-policy.ts — validates that every `actions/setup-node` step in
 * .github/workflows/*.{yml,yaml} is pinned to Node 24 semantics.
 *
 * Precedence (matches the action's own behaviour):
 *   1. If `node-version` is present → validate it starts with "24".
 *   2. If `node-version` is absent but `node-version-file` is present → allowed.
 *   3. Neither present → policy violation.
 *
 * Workflows that contain no `actions/setup-node` steps are ignored.
 *
 * Usage: pnpm tsx scripts/ci/check-node-policy.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  jobs?: Record<string, WorkflowJob>;
}

export interface PolicyViolation {
  file: string;
  job: string;
  step: string | number;
  message: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSetupNodeStep(step: WorkflowStep): boolean {
  return (
    typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
  );
}

function validateSetupNodeStep(
  step: WorkflowStep,
  file: string,
  job: string,
  stepIndex: number,
): PolicyViolation | null {
  const withInputs = step.with ?? {};
  const nodeVersion = withInputs["node-version"];
  const nodeVersionFile = withInputs["node-version-file"];
  const stepLabel: string | number = step.name ?? stepIndex;

  // node-version takes precedence when present; validate it is Node 24.
  if (nodeVersion !== undefined) {
    const versionStr = String(nodeVersion);
    if (!versionStr.startsWith("24")) {
      return {
        file,
        job,
        step: stepLabel,
        message: `node-version "${versionStr}" does not satisfy the Node 24 policy`,
      };
    }
    return null;
  }

  // node-version absent but node-version-file present → allowed.
  if (nodeVersionFile !== undefined) {
    return null;
  }

  // Neither input present → policy violation.
  return {
    file,
    job,
    step: stepLabel,
    message:
      "actions/setup-node has no node-version or node-version-file specified",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Checks a single workflow YAML string for Node 24 policy violations.
 * Returns an empty array when the workflow contains no `actions/setup-node` steps.
 */
export function checkNodePolicy(
  workflowYaml: string,
  filename: string,
): PolicyViolation[] {
  const doc = yaml.load(workflowYaml) as WorkflowDocument | null;
  if (doc === null || typeof doc !== "object" || !doc.jobs) return [];

  const violations: PolicyViolation[] = [];

  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const steps = job.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || !isSetupNodeStep(step)) continue;
      const violation = validateSetupNodeStep(step, filename, jobId, i);
      if (violation) violations.push(violation);
    }
  }

  return violations;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workflowsDir = ".github/workflows";
  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => join(workflowsDir, f));

  if (files.length === 0) {
    console.log("No workflow files found — nothing to check.");
    process.exit(0);
  }

  console.log(
    `Checking Node 24 policy in ${files.length} workflow file(s)...\n`,
  );

  let hasViolations = false;
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const violations = checkNodePolicy(content, file);
    for (const v of violations) {
      console.error(
        `::error file=${v.file}::Job '${v.job}', step '${String(v.step)}': ${v.message}`,
      );
      hasViolations = true;
    }
  }

  if (hasViolations) {
    process.exit(1);
  }

  console.log("Node 24 policy check passed.");
}
