graph-mcp-vault is a personal knowledge graph. Entries are stored per namespace
and connected via typed relations.

## Data model

- **namespace**: logical workspace (e.g. "homelab", "work"). Each session is bound
  to one namespace via the URL (e.g. `/mcp/homelab`). Individual tool calls can
  override the namespace using the optional `namespace` parameter — use this to
  read or write entries in a different namespace than the session default.
- **entry_type**: category of the entry (e.g. "note", "decision", "fact", "reference").
- **title**: short descriptive name.
- **content**: full body of the entry. ALWAYS write content in Markdown. Use
  headings, lists, and code blocks where appropriate. Markdown improves
  readability, full-text search quality, and rendering in clients.
- **topic**: broad subject area (optional, single string).
- **tags**: keyword list for filtering (optional, max 50).
- **summary**: one-sentence description for quick scanning (optional).
- **source**: origin URL or citation (optional).
- **last_verified_at**: ISO 8601 datetime when the entry was last verified (optional).

## Relations

Connect entries with `knowledge_create_relation` using UPPER_SNAKE_CASE types
(e.g. DEPENDS_ON, RUNS_ON, RELATES_TO). Both entries must be in the same namespace.

## Search workflow

1. Always call `knowledge_search_entries` before creating a new entry to avoid duplicates.
2. If the search returns no results in the current namespace, retry with
   `all_namespaces: true` to check whether the entry exists in another namespace.
3. Only create a new entry if both searches return no relevant results.
