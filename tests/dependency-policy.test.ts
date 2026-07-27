import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A runtime dependency that nothing under src/ imports still ships to production,
// still pulls its own transitive tree into the lockfile, and still shows up in the
// Trivy security gate — while contributing nothing. Dev-only tooling belongs in
// devDependencies, so `dependencies` should contain exactly what the server loads.

const REPO_ROOT = join(import.meta.dirname, "..");

/** Bare specifiers imported anywhere under src/, e.g. `hono`, `dotenv/config`. */
function importedSpecifiers(): Set<string> {
  const specifiers = new Set<string>();
  const sources = globSync("src/**/*.ts", { cwd: REPO_ROOT });

  for (const relative of sources) {
    const source = readFileSync(join(REPO_ROOT, relative), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier && !specifier.startsWith(".")) {
        specifiers.add(specifier);
      }
    }
  }

  return specifiers;
}

/** A dependency is used if it is imported bare or through a subpath export. */
function isImported(dependency: string, specifiers: Set<string>): boolean {
  for (const specifier of specifiers) {
    if (specifier === dependency || specifier.startsWith(`${dependency}/`)) {
      return true;
    }
  }
  return false;
}

describe("package.json dependencies", () => {
  it("declares only runtime dependencies that src/ actually imports", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    const specifiers = importedSpecifiers();
    const declared = Object.keys(manifest.dependencies ?? {});
    const unused = declared.filter((name) => !isImported(name, specifiers));

    expect(unused).toEqual([]);
  });

  it("finds the import specifiers it scans for", () => {
    // Guards the check above against silently passing on an empty scan.
    expect(importedSpecifiers().has("hono")).toBe(true);
  });
});
