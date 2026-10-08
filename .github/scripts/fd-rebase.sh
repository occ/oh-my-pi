#!/usr/bin/env bash
# Rebase the FleetDriver patch queue onto upstream tag LATEST (default: newest
# stable upstream tag). fd-sync.yml and the manual path below share this script,
# so both produce the same tree.
#
# The queue is merge-base(HEAD, LATEST)..HEAD, not "nearest tag": upstream has
# re-pointed release tags, which made `git describe` pick an older tag and
# replay upstream commits as if they were ours. Patches already present
# upstream become empty and are dropped by rebase.
#
# Manual path (when fd-sync reports a conflict), from a checkout of fork main:
#   .github/scripts/fd-rebase.sh       # stops at the conflicting patch
#   # resolve, `git add <files>`, `git rebase --continue`; repeat
#   .github/scripts/fd-rebase.sh       # no-op rebase; verifies the result
#   .github/scripts/fd-gate.sh         # same gate fd-sync runs
#   git push --force-with-lease=main:<old main sha> <fork remote> HEAD:main
#   gh workflow run fd-sync.yml -R occ/oh-my-pi   # releases <tag>-fd.1
#
# Usage: fd-rebase.sh [--print-latest]
set -euo pipefail

UPSTREAM="${UPSTREAM:-https://github.com/can1357/oh-my-pi.git}"

git fetch -q --no-tags "$UPSTREAM" '+refs/tags/v*:refs/tags/v*'
if [ -z "${LATEST:-}" ]; then
	LATEST="$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1)"
fi
if [ "${1:-}" = "--print-latest" ]; then
	echo "$LATEST"
	exit 0
fi

if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
	echo "error: a rebase is in progress; finish it (git rebase --continue) or abort it first" >&2
	exit 1
fi

if [ -n "${GITHUB_ACTIONS:-}" ]; then
	git config user.name "github-actions[bot]"
	git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi

# Writes the conflict report to the job summary and the `report` step output
# (fd-sync's tracking issue); locally it goes to stderr.
report_conflict() {
	local stopped files report eof
	stopped="$(git log -1 --format='%h %s' REBASE_HEAD 2>/dev/null || echo unknown)"
	files="$(git diff --name-only --diff-filter=U)"
	report="$(
		echo "### FleetDriver patches conflict with $LATEST"
		echo
		echo "Conflicting patch: \`$stopped\`"
		echo
		echo "Conflicted files:"
		echo
		# shellcheck disable=SC2016 # literal Markdown backticks and sed's $ anchor
		sed 's/^/- `/; s/$/`/' <<<"$files"
		echo
		echo "Resolve locally from fork \`main\`: run \`.github/scripts/fd-rebase.sh\`;"
		echo "the full manual path is in that script's header."
	)"
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		echo "$report" | tee -a "$GITHUB_STEP_SUMMARY"
	else
		echo "$report" >&2
	fi
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		eof="EOF_$(openssl rand -hex 8)"
		printf 'report<<%s\n%s\n%s\n' "$eof" "$report" "$eof" >> "$GITHUB_OUTPUT"
	fi
}

base="$(git merge-base HEAD "$LATEST")"
if [ "$base" != "$(git rev-parse "$LATEST^{commit}")" ]; then
	echo "==> rebasing patches $base..HEAD onto $LATEST"
	git log --oneline "$base..HEAD"
	if ! git -c merge.conflictStyle=zdiff3 rebase --onto "$LATEST" "$base" HEAD; then
		report_conflict
		if [ -n "${GITHUB_ACTIONS:-}" ]; then
			git rebase --abort || true
			echo "::error::FleetDriver patches do not apply cleanly onto $LATEST; see the job summary"
		else
			echo "Rebase stopped for manual resolution. Resolve, then git rebase --continue." >&2
		fi
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
