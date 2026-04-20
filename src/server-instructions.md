graph-mcp-vault is a personal knowledge graph. Entries are stored per namespace
and connected via typed relations.

## Data model

- **namespace**: logical workspace (e.g. "homelab", "work"). Each session is bound
  to one namespace via the URL. Individual tool calls can override the namespace
  using the optional `namespace` parameter — use this to read or write entries in
  a different namespace than the session default.
- **content**: ALWAYS write in Markdown. Use headings, lists, and code blocks where
  appropriate. This improves readability, search quality, and rendering in clients.
- **tags**: keyword list for filtering (max 50).

## Namespace structure template

Each namespace can have a `structure_template`: a Markdown description of its
intended organisation (entry types, tags, relation types, conventions). It is
returned by `knowledge_list_namespaces` — read it at the start of a session to
understand how the namespace is structured and follow its conventions when
creating or updating entries.

## Relations

Connect entries with `knowledge_create_relation` using UPPER_SNAKE_CASE types
(e.g. DEPENDS_ON, RUNS_ON, RELATES_TO). Both entries must be in the same namespace.

## Search workflow

1. Always call `knowledge_search_entries` before creating a new entry to avoid duplicates.
2. By default, search runs across all namespaces you can access. Use `namespace`
   only when you explicitly want to narrow results to one namespace.
3. Only create a new entry if no relevant results are found in that global search.
