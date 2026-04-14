#!/usr/bin/env bash
# validate-pins.sh — verify every pinned action SHA in .github/workflows/*.yml
# resolves to a real commit via the GitHub API.
#
# Requires: gh CLI authenticated (GH_TOKEN env var in CI)
# Usage: bash scripts/ci/validate-pins.sh

set -euo pipefail

WORKFLOWS_DIR=".github/workflows"
ERRORS=()

# Collect all workflow files
mapfile -t files < <(find "$WORKFLOWS_DIR" -name '*.yml' -o -name '*.yaml' | sort)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No workflow files found in ${WORKFLOWS_DIR}"
  exit 0
fi

echo "Checking pinned action SHAs in ${#files[@]} workflow file(s)..."
echo ""

for file in "${files[@]}"; do
  while IFS= read -r line; do
    # Match: uses: owner/repo@<40-hex>  or  uses: owner/repo/subpath@<40-hex>
    # Capture group 1: owner/repo  (group 2: optional /subpath)  group 3: sha
    if [[ "$line" =~ uses:[[:space:]]+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(/[^@[:space:]]*)?@([0-9a-f]{40}) ]]; then
      repo="${BASH_REMATCH[1]}"
      sha="${BASH_REMATCH[3]}"

      if gh api "repos/${repo}/commits/${sha}" --silent > /dev/null 2>&1; then
        printf "  OK    %-55s %s\n" "${repo}" "${sha}"
      else
        printf "  FAIL  %-55s %s\n" "${repo}" "${sha}"
        ERRORS+=("${file}: ${repo}@${sha}")
      fi
    fi
  done < "$file"
done

echo ""

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "::error::${#ERRORS[@]} invalid pinned SHA(s) found:"
  for e in "${ERRORS[@]}"; do
    echo "  - ${e}"
  done
  exit 1
fi

echo "All pinned action SHAs are valid."
