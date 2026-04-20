graph-mcp-vault is a personal knowledge graph. Entries are stored per namespace
and connected via typed relations.

## Data model

When creating or updating entries, use these fields:

- **namespace**: logical workspace (for example `"homelab"` or `"work"`). Each
  session is bound to one namespace via the URL. Most tools support a per-call
  `namespace` override so you can target a different namespace explicitly.
- **entry_type**: entry category (for example `note`, `decision`, `fact`, `reference`).
- **title**: short descriptive title.
- **content**: full body text. ALWAYS write this field in Markdown.
- **topic**: broad subject area (optional).
- **tags**: keyword list for filtering and search (optional, max 50).
- **summary**: one-sentence quick summary (optional).
- **source**: origin URL or citation (optional, max 2048 chars).
- **last_verified_at**: ISO-8601 datetime indicating when the information was
  last checked (optional).
- **versioned**: per-entry versioning override (optional). If enabled, title/content
  updates are snapshotted and can be listed/retrieved/restored.

## Namespace settings

Each namespace has configurable settings via namespace config tools:

- **structure_template**: Markdown guidance describing preferred entry types,
  tags, relation types, and conventions for that namespace.
- **versioning_enabled** and **max_versions**: namespace-level defaults for
  entry versioning behavior.

Read `knowledge_list_namespaces` and namespace config early in a session to
follow the namespace conventions.

## Relations

Create relations with `knowledge_create_relation` using UPPER_SNAKE_CASE types
(for example `DEPENDS_ON`, `RUNS_ON`, `RELATES_TO`). Both entries must be in
the same namespace.

## Search workflow

1. Always call `knowledge_search_entries` before creating a new entry to avoid duplicates.
2. By default, search runs across all namespaces you can access. Use `namespace`
   only when you explicitly want to narrow results.
3. For structured queries (IP addresses, versions, paths, domains), prefer
   `match_mode: "fulltext"` or `match_mode: "exact"`.
4. Only create a new entry if no relevant results are found.
