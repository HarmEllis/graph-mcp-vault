// ── Graph traversal and query limit constants ─────────────────────────────────
//
// All defaults and hard caps live here. No environment-variable surface —
// these are compile-time constants only.
//
// Values above the caps are rejected with INVALID_PARAMS; they are not clamped.

/** Default maximum traversal hops for expand_context. */
export const DEFAULT_MAX_HOPS = 3;
/** Hard cap on traversal hops for expand_context. Values above this are rejected. */
export const MAX_HOPS_CAP = 4;

/** Default total-nodes limit for expand_context. */
export const DEFAULT_EXPAND_CONTEXT_LIMIT = 50;
/** Hard cap on total nodes for expand_context. Values above this are rejected. */
export const MAX_EXPAND_CONTEXT_LIMIT = 200;

/** Default maximum path depth for find_paths and impact_analysis. */
export const DEFAULT_MAX_DEPTH = 4;
/** Hard cap on path depth for find_paths and impact_analysis. Values above this are rejected. */
export const MAX_DEPTH_CAP = 6;

/** Default maximum number of paths returned by find_paths. */
export const DEFAULT_MAX_PATHS = 5;
/** Hard cap on paths returned by find_paths. Values above this are rejected. */
export const MAX_PATHS_CAP = 10;

/** Default total-entries limit for impact_analysis. */
export const DEFAULT_IMPACT_LIMIT = 50;
/** Hard cap on total entries for impact_analysis. Values above this are rejected. */
export const MAX_IMPACT_LIMIT = 200;

/** Default limit for list_relations. */
export const DEFAULT_LIST_RELATIONS_LIMIT = 100;
/** Hard cap for list_relations limit. Values above this are rejected. */
export const MAX_LIST_RELATIONS_LIMIT = 500;

/** Default limit for list_access (list_sharing). */
export const DEFAULT_LIST_ACCESS_LIMIT = 100;
/** Hard cap for list_access limit. Values above this are rejected. */
export const MAX_LIST_ACCESS_LIMIT = 500;
