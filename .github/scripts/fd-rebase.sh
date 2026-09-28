#!/usr/bin/env bash
# Rebase the FleetDriver patch queue (BASE..HEAD) onto upstream tag LATEST.
# Patches already present upstream become empty and are dropped by rebase.
# Used by fd-sync.yml; the gate and publish jobs must produce the same tree.
set -euo pipefail

: "${BASE:?}" "${LATEST:?}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if [ "$BASE" != "$LATEST" ]; then
	echo "==> rebasing patches $BASE..HEAD onto $LATEST"
	if ! git rebase --onto "$LATEST" "$BASE" HEAD; then
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
