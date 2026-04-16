# Release Runbook

This runbook describes the standard release flow for this repository.

## Preconditions

- You are authenticated in GitHub CLI (`gh auth status`).
- Docker is running (tests use Testcontainers).
- You can push to `main` and create tags.

## 1. Prepare branch state

```bash
git checkout main
git pull --ff-only
git status --short
```

Expected: no output from `git status --short` (clean working tree).

## 2. Review changes since the previous release

```bash
PREV_TAG="$(git describe --tags --abbrev=0)"
git log --oneline "${PREV_TAG}..HEAD"
git diff --stat "${PREV_TAG}..HEAD"
```

Use this output to prepare the changelog section for the next version.

## 3. Pick the release version

Set the target SemVer without the `v` prefix:

```bash
VERSION="0.0.3"
TAG="v${VERSION}"
```

## 4. Review `src/server-instructions.md`

Open `src/server-instructions.md` and verify that every statement still matches the actual implementation:

- **Data model fields** — check that the listed fields (`namespace`, `entry_type`, `title`, `content`, `topic`, `tags`, `summary`, `source`, `last_verified_at`) match what the tool schemas in `src/tools/resources.ts` actually accept.
- **Relations** — confirm the constraint "both entries must be in the same namespace" is still enforced in `src/neo4j-client.ts`.
- **Search workflow** — confirm the three-step deduplication flow still matches the tool behaviour.
- **Namespace override** — confirm that the per-tool `namespace` parameter still exists in the tool definitions.

Update the file if anything has drifted. This file is the LLM's only source of truth about the data model, so accuracy matters for every release.

## 5. Update release metadata

1. Bump package version:

```bash
pnpm version "${VERSION}" --no-git-tag-version
```

2. Update server version constant:
- `src/routers/mcp.ts` (`SERVER_VERSION`)
- `tests/mcp-lifecycle.test.ts` (assertion for `serverInfo.version`)

3. Add the new section at the top of `CHANGELOG.md`:
- `## [<VERSION>] - YYYY-MM-DD`
- Include a short intro summary paragraph before subsection headings.
- Include `Added` / `Changed` / `Fixed` / `Security` headings as applicable.
- End the section with:
  - `**Full Changelog**: https://github.com/<owner>/<repo>/compare/<PREV_TAG>...v<VERSION>`

## 6. Run the full preflight checks

```bash
pnpm install --frozen-lockfile
pnpm biome check .
pnpm tsc --noEmit
pnpm test
pnpm build
```

## 7. Commit release changes (do not tag yet)

```bash
git add package.json src/routers/mcp.ts tests/mcp-lifecycle.test.ts CHANGELOG.md docs/RELEASE.md
git commit -m "chore(release): prepare ${TAG}"
```

## 8. Approval gate before any push

Before pushing the release commit or tag, get explicit approval from the release owner.

## 9. Push release commit to `main` and wait for CI

```bash
git push origin main
```

Wait for the `CI` workflow on `main` for this exact release commit to complete successfully.
If CI is not `success`, stop and do not push the tag.

## 10. Create and push the annotated tag

```bash
git tag -a "${TAG}" -m "Release ${TAG}"
git push origin "${TAG}"
```

## 11. Create a draft GitHub release

Build release notes from only the current changelog section (without the section heading), then append a compare link:

```bash
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
COMPARE_URL="https://github.com/${REPO}/compare/${PREV_TAG}...${TAG}"

{
awk '
  $0 ~ "^## \\[" VERSION "\\]" { in_section=1; next }
  $0 ~ "^## \\[" && in_section { exit }
  in_section { print }
' VERSION="${VERSION}" CHANGELOG.md
  printf "\n**Full Changelog**: %s\n" "${COMPARE_URL}"
} > /tmp/release-notes.md
```

Create the draft release:

```bash
gh release create "${TAG}" \
  --title "${TAG}" \
  --draft \
  --notes-file /tmp/release-notes.md
```

## 12. Verify publish pipeline, then publish release

- Tag push triggers `.github/workflows/docker-publish.yml`.
- That workflow enforces `vX.Y.Z` tag format and checks that `CI` passed on the tagged commit.
- If the workflow fails, do not publish the release.
- After the workflow succeeds, review the draft release and publish it.

## Recovery

If you tagged the wrong commit and have not published the release yet:

```bash
git tag -d "${TAG}"
git push origin ":refs/tags/${TAG}"
gh release delete "${TAG}" --yes
```
