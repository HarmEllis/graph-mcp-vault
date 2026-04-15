# Release Runbook

This runbook describes how to publish a tagged release.

## Preconditions

- You are on `main`.
- Working tree is clean.
- You are authenticated in GitHub CLI (`gh auth status`).

## Release v0.0.2

1. Run all checks locally:

```bash
pnpm install --frozen-lockfile
pnpm biome check .
pnpm tsc --noEmit
pnpm test
pnpm build
```

2. Commit release metadata:

```bash
git add package.json src/routers/mcp.ts tests/mcp-lifecycle.test.ts CHANGELOG.md README.md docs/RELEASE.md
git commit -m "chore(release): prepare v0.0.2"
```

3. Create and push the tag:

```bash
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin main
git push origin v0.0.2
```

4. Create the GitHub release:

```bash
gh release create v0.0.2 \
  --title "v0.0.2" \
  --draft \
  --notes-file CHANGELOG.md
```

## Notes

- Pushing `vX.Y.Z` triggers `.github/workflows/docker-publish.yml`.
- The docker-publish workflow enforces semver tag format and verifies CI success on the tagged commit.
- Always create GitHub releases as drafts first, then publish after final verification.
