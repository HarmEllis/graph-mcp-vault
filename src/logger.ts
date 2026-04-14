// ── Types ─────────────────────────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

// ── noopLogger ────────────────────────────────────────────────────────────────

const noop = (): void => {};

export const noopLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

// ── createLogger ──────────────────────────────────────────────────────────────

/**
 * Creates a structured JSON-line logger that filters output by `minLevel`.
 *
 * Every emitted line is a JSON object with at least:
 *   { timestamp, level, event, ...extraFields }
 *
 * @param minLevel  Minimum severity to emit. Messages below this level are
 *                  silently dropped.
 * @param writeLine Optional sink function — defaults to stdout. Inject a
 *                  capturing function in tests.
 */
export function createLogger(
  minLevel: LogLevel,
  writeLine: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    writeLine(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...fields,
      }),
    );
  }

  return {
    trace: (e, f) => emit("trace", e, f),
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}
