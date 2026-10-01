#!/usr/bin/env bash
# Rebase the FleetDriver patch queue onto upstream tag LATEST.
# The queue is merge-base(HEAD, LATEST)..HEAD, not "nearest tag": upstream has
# re-pointed release tags, which made `git describe` pick an older tag and
# replay upstream commits as if they were ours.
# Patches already present upstream become empty and are dropped by rebase.
# Used by fd-sync.yml; the gate and publish jobs must produce the same tree.
set -euo pipefail

: "${LATEST:?}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

base="$(git merge-base HEAD "$LATEST")"
if [ "$base" != "$(git rev-parse "$LATEST^{commit}")" ]; then
	echo "==> rebasing patches $base..HEAD onto $LATEST"
	git log --oneline "$base..HEAD"
	if ! git rebase --onto "$LATEST" "$base" HEAD; then
		git status --short || true
		git rebase --abort || true
		echo "::error::FleetDriver patches do not apply cleanly onto $LATEST; rebase manually"
		exit 1
	fi
fi

version="$(jq -r .version packages/coding-agent/package.json)"
if [ "$version" != "${LATEST#v}" ]; then
	echo "::error::packages/coding-agent version $version does not match $LATEST"
	exit 1
fi

echo "==> FleetDriver patches on $LATEST:"
git log --oneline "$LATEST..HEAD"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
	echo "tree=$(git rev-parse 'HEAD^{tree}')" >> "$GITHUB_OUTPUT"
fi
