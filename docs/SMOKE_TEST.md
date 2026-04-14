# graph-mcp-vault — LLM Smoke-Test Checklist

Run this checklist after every deployment to verify the server is operating correctly end-to-end with a real LLM client.

**Target client**: Claude Code, Open WebUI, or any MCP-compatible chat client.
**Time required**: ~10 minutes.

---

## Preconditions

Before starting, confirm all of the following:

| # | Check | Command / how to verify |
|---|-------|-------------------------|
| P1 | Neo4j is running | `docker compose ps` → `neo4j` shows `healthy` |
| P2 | graph-mcp-vault is running | `docker compose ps` → `graph-mcp-vault` shows `Up` |
| P3 | OAuth metadata endpoint is reachable | `curl -s https://graph-mcp-vault.your-domain.com/.well-known/oauth-authorization-server \| jq .issuer` → prints issuer URL |
| P4 | MCP endpoint is reachable | `curl -s -o /dev/null -w "%{http_code}" -X GET https://graph-mcp-vault.your-domain.com/mcp` → `405` (GET not allowed is correct) |
| P5 | You have a valid bearer token | Token obtained via provider login or `client_credentials` grant |
| P6 | MCP server is configured in your client | See `docs/OPEN_WEBUI_SETUP_EXAMPLE.md` |

**Fail fast**: if any precondition fails, stop and fix before continuing.

---

## Step 1 — Tool Discovery

**Goal**: confirm the server advertises the expected tool set.

**Prompt to LLM**:
```
List all available tools from the graph-mcp-vault MCP server.
```

**Expected result**: the LLM lists all ten knowledge tools:
- `knowledge_create_entry`
- `knowledge_get_entry`
- `knowledge_list_entries`
- `knowledge_search_entries`
- `knowledge_update_entry`
- `knowledge_delete_entry`
- `knowledge_share_entry`
- `knowledge_revoke_access`
- `knowledge_list_access`
- `knowledge_list_namespaces`

**Pass criteria**: all ten tool names appear in the response.
**Fail criteria**: fewer tools listed, error message, or no response.

---

## Step 2 — Create / Save

**Goal**: confirm knowledge entry creation works and returns an ID.

**Prompt to LLM**:
```
Save a new knowledge entry with entry_type "note", title "Smoke Test Note", and content "This is a smoke test created at <current date/time>".
```

**Expected result**: the LLM calls `knowledge_create_entry` and reports back an ID (UUID format) and `created_at` timestamp.

**Pass criteria**: response contains a UUID `id` and an ISO-8601 `created_at` string.
**Fail criteria**: error returned, no ID, or tool call not attempted.

> Record the returned ID — you need it for Steps 3, 4, and 5.

---

## Step 3 — Retrieve (Same Session)

**Goal**: confirm the entry can be retrieved immediately within the same session.

**Prompt to LLM** (replace `<id>` with the ID from Step 2):
```
Retrieve the knowledge entry with id "<id>".
```

**Expected result**: the LLM calls `knowledge_get_entry` and shows the entry with:
- `title` = `"Smoke Test Note"`
- `role` = `"owner"`

**Pass criteria**: title and role match exactly.
**Fail criteria**: "not found" error, wrong title, or wrong role.

---

## Step 3b — Retrieve (New Session)

**Goal**: confirm data persists across sessions.

**Action**: start a new chat session in your client (do not reuse the session from Steps 2–3).

**Prompt to LLM**:
```
Retrieve the knowledge entry with id "<id>".
```

**Expected result**: same result as Step 3.

**Pass criteria**: entry returned with correct title and `role: owner`.
**Fail criteria**: "not found" or session error.

---

## Step 4 — Full-Text Search

**Goal**: confirm `knowledge_search_entries` returns the created entry.

**Prompt to LLM**:
```
Search the knowledge memory bank for entries matching "smoke test".
```

**Expected result**: the LLM calls `knowledge_search_entries` and the result includes the note from Step 2.

**Pass criteria**: `"Smoke Test Note"` appears in the results.
**Fail criteria**: empty results, error, or the note is absent.

---

## Step 5 — Update and Re-Read

**Goal**: confirm update persists and is visible on re-read.

**Prompt to LLM**:
```
Update the knowledge entry "<id>" — change the title to "Smoke Test Note v2".
```

**Expected result**: the LLM calls `knowledge_update_entry` and confirms success.

**Follow-up prompt**:
```
Retrieve the knowledge entry "<id>" again.
```

**Expected result**: `title` is now `"Smoke Test Note v2"` and `updated_at` differs from `created_at`.

**Pass criteria**: new title and differing timestamps.
**Fail criteria**: old title returned or error.

---

## Step 6 — Namespace Isolation

**Goal**: confirm entries created in one namespace are not visible in another.

**Setup**: configure two separate MCP tool entries pointing to different namespace URLs:
- `https://graph-mcp-vault.your-domain.com/mcp/ns-a`
- `https://graph-mcp-vault.your-domain.com/mcp/ns-b`

**Step 6a** — in a session connected to `ns-a`:
```
Save a knowledge entry with entry_type "note", title "Namespace A Secret", content "only in A".
```
Record the returned ID.

**Step 6b** — in a session connected to `ns-b`:
```
List all knowledge entries.
```

**Expected result**: the `"Namespace A Secret"` entry does **not** appear.

**Pass criteria**: response shows an empty list (or entries belonging to `ns-b` only), with no mention of `"Namespace A Secret"`.
**Fail criteria**: `"Namespace A Secret"` appears in `ns-b` results.

---

## Step 7 — Negative / Error Paths

### 7a — Permission denied

**Setup**: use two separate authenticated users (user A creates, user B tries to access).

**Step**: as user A, create an entry and record its ID.
**Step**: as user B, prompt:
```
Retrieve the knowledge entry with id "<id from user A>".
```

**Expected result**: `PERMISSION_DENIED` error.
**Pass criteria**: error message contains "Permission denied" or error code `-32002`.
**Fail criteria**: entry data returned to user B.

### 7b — Entry not found

**Prompt to LLM**:
```
Retrieve the knowledge entry with id "00000000-0000-0000-0000-000000000000".
```

**Expected result**: `RESOURCE_NOT_FOUND` error.
**Pass criteria**: error message contains "Resource not found" or error code `-32003`.
**Fail criteria**: no error, or wrong error code.

### 7c — Invalid parameters

**Prompt to LLM**:
```
Search the knowledge memory bank but do not provide a query.
```

**Expected result**: `INVALID_PARAMS` error.
**Pass criteria**: error message contains "Invalid params".
**Fail criteria**: server crashes, 500, or silently returns empty results.

---

## Step 8 — Logging Verification

**Goal**: confirm structured logs are emitted correctly.

**Command**:
```bash
docker compose logs graph-mcp-vault --since 5m | head -50
```

**What to look for** (each log line is a JSON object):

| Event | Field | Expected value |
|-------|-------|----------------|
| Session created | `event` | `"session_created"` |
| Tool call success | `event` | `"tool_call"`, `isError: false` |
| Tool call error | `event` | `"tool_call"`, `isError: true` |
| Auth failure | `event` | `"auth_failure"` |
| All log lines | `timestamp` | ISO-8601 string |
| All log lines | `level` | one of `trace`, `debug`, `info`, `warn`, `error` |

**Confirm absent**: no `Authorization` header values, no JWT token strings, no entry `content` field in logs.

**Pass criteria**: log lines are valid JSON; expected events appear; no secrets visible.
**Fail criteria**: plain-text logs, missing events, or secrets in output.

---

## Cleanup

After passing all steps, delete the test entry:

**Prompt to LLM**:
```
Delete the knowledge entry with id "<id from Step 2>".
```

**Expected result**: success, no error.

---

## Summary Table

| Step | What it tests | Pass? |
|------|--------------|-------|
| 1 | Tool discovery | ☐ |
| 2 | Create entry | ☐ |
| 3 | Retrieve same session | ☐ |
| 3b | Retrieve new session | ☐ |
| 4 | Full-text search | ☐ |
| 5 | Update + re-read | ☐ |
| 6 | Namespace isolation | ☐ |
| 7a | Permission denied | ☐ |
| 7b | Entry not found | ☐ |
| 7c | Invalid params | ☐ |
| 8 | Logging | ☐ |
| Cleanup | Delete entry | ☐ |
