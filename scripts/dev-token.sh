#!/usr/bin/env bash
# Fetch a short-lived access token from the local Keycloak dev instance.
#
# Usage:
#   source scripts/dev-token.sh          # sets GRAPH_MCP_TOKEN in current shell
#   export GRAPH_MCP_TOKEN=$(scripts/dev-token.sh --print)   # subshell / scripting
#
# Prerequisites: curl, jq, docker-compose stack running (keycloak on port 8081)

set -euo pipefail

KEYCLOAK_URL="http://localhost:8081"
REALM="graph-mcp-vault"
CLIENT_ID="graph-mcp-vault"
CLIENT_SECRET="dev-secret"
USERNAME="dev-user"
PASSWORD="dev-password"

TOKEN=$(curl -sf -X POST \
  "${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "username=${USERNAME}" \
  -d "password=${PASSWORD}" \
  | jq -r '.access_token')

if [[ -z "${TOKEN}" || "${TOKEN}" == "null" ]]; then
  echo "ERROR: failed to obtain token. Is docker-compose up?" >&2
  exit 1
fi

if [[ "${1:-}" == "--print" ]]; then
  echo "${TOKEN}"
else
  export GRAPH_MCP_TOKEN="${TOKEN}"
  echo "GRAPH_MCP_TOKEN set (expires in ~5 min). Start Claude Code in this shell." >&2
fi
