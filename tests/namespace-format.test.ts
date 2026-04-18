import { describe, expect, it } from "vitest";
import { ErrorCode } from "../src/errors.js";
import {
  NAMESPACE_ERROR_MESSAGE,
  NAMESPACE_REGEX,
  assertValidNamespace,
  normalizeNamespaceForMigration,
  zNamespace,
} from "../src/namespace.js";
import { ToolError } from "../src/tools/registry.js";

describe("NAMESPACE_REGEX", () => {
  it.each([
    ["foo"],
    ["a"],
    ["foo-bar"],
    ["abc-def-ghi"],
    ["test-default"],
    ["iso-ns-a"],
    ["zz"],
  ])("accepts %s", (ns) => {
    expect(NAMESPACE_REGEX.test(ns)).toBe(true);
  });

  it.each([
    [""],
    ["-"],
    ["-foo"],
    ["foo-"],
    ["foo--bar"],
    ["Foo"],
    ["FOO"],
    ["foo_bar"],
    ["foo bar"],
    ["foo1"],
    ["café"],
    ["123"],
    ["foo/bar"],
  ])("rejects %s", (ns) => {
    expect(NAMESPACE_REGEX.test(ns)).toBe(false);
  });
});

describe("assertValidNamespace", () => {
  it("does not throw for a valid namespace", () => {
    expect(() => assertValidNamespace("foo-bar")).not.toThrow();
  });

  it("throws ToolError(INVALID_PARAMS) with the canonical message", () => {
    let caught: unknown;
    try {
      assertValidNamespace("Bad_NS");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const e = caught as ToolError;
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(e.message).toBe(NAMESPACE_ERROR_MESSAGE);
  });
});

describe("zNamespace", () => {
  it("accepts a valid namespace", () => {
    const result = zNamespace.safeParse("foo-bar");
    expect(result.success).toBe(true);
  });

  it("rejects an invalid namespace with the canonical message", () => {
    const result = zNamespace.safeParse("Bad_NS");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(NAMESPACE_ERROR_MESSAGE);
    }
  });
});

describe("normalizeNamespaceForMigration", () => {
  it.each<[string, string]>([
    ["foo", "foo"],
    ["My_NS", "my-ns"],
    ["  spaced  ", "spaced"],
    ["___", "default"],
    ["Foo--Bar", "foo-bar"],
    ["FOO/BAR", "foo-bar"],
    ["-leading-", "leading"],
    ["123", "default"],
    ["", "default"],
    ["a-b", "a-b"],
    ["A", "a"],
    ["café", "caf"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeNamespaceForMigration(input)).toBe(expected);
  });

  it("output of every case satisfies NAMESPACE_REGEX", () => {
    const inputs = [
      "foo",
      "My_NS",
      "  spaced  ",
      "___",
      "Foo--Bar",
      "FOO/BAR",
      "-leading-",
      "123",
      "",
      "a-b",
      "A",
      "café",
    ];
    for (const input of inputs) {
      expect(NAMESPACE_REGEX.test(normalizeNamespaceForMigration(input))).toBe(
        true,
      );
    }
  });

  it("uses a custom fallback when result would be empty", () => {
    expect(normalizeNamespaceForMigration("___", "fallback-ns")).toBe(
      "fallback-ns",
    );
  });
});
