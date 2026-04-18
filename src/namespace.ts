import { z } from "zod";
import { ErrorCode } from "./errors.js";
import { ToolError } from "./tools/registry.js";

export const NAMESPACE_REGEX = /^[a-z]+(-[a-z]+)*$/;

export const NAMESPACE_ERROR_MESSAGE =
  "namespace must match ^[a-z]+(-[a-z]+)*$";

export const zNamespace = z
  .string()
  .regex(NAMESPACE_REGEX, NAMESPACE_ERROR_MESSAGE);

export function assertValidNamespace(ns: string): void {
  if (!NAMESPACE_REGEX.test(ns)) {
    throw new ToolError(ErrorCode.INVALID_PARAMS, NAMESPACE_ERROR_MESSAGE);
  }
}

export function normalizeNamespaceForMigration(
  input: string,
  fallback = "default",
): string {
  let s = input.toLowerCase();
  s = s.replace(/[^a-z]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s.length === 0 ? fallback : s;
}
