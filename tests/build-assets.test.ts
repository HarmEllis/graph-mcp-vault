import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// `tsc` only emits .js — any non-TypeScript file the server reads at runtime has
// to be copied into dist by the build itself, otherwise `pnpm start` fails with
// ENOENT on a fresh checkout even though the build "succeeded".

const REPO_ROOT = join(import.meta.dirname, "..");
const DIST_SRC = join(REPO_ROOT, "dist", "src");

describe("build output", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], { cwd: REPO_ROOT, stdio: "pipe" });
  }, 180_000);

  it("emits the compiled entry point", () => {
    expect(() => readFileSync(join(DIST_SRC, "main.js"))).not.toThrow();
  });

  it("ships server-instructions.md next to the entry point", () => {
    const shipped = readFileSync(
      join(DIST_SRC, "server-instructions.md"),
      "utf8",
    );
    const source = readFileSync(
      join(REPO_ROOT, "src", "server-instructions.md"),
      "utf8",
    );
    expect(shipped).toBe(source);
  });
});
