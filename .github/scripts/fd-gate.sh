#!/usr/bin/env bash
# Gate a rebased FleetDriver patch queue: upstream's linux-x64 native addons for
# the base tag, a full type check, and every test file the patch queue adds or
# changes. Deriving the tests from the queue keeps new patches gated without
# editing fd-sync.yml. Run after fd-rebase.sh and `bun install`.
set -euo pipefail

LATEST="${LATEST:-$(bash "$(dirname "$0")/fd-rebase.sh" --print-latest)}"
if ! git merge-base --is-ancestor "$LATEST" HEAD; then
	echo "error: HEAD is not rebased onto $LATEST; run fd-rebase.sh first" >&2
	exit 1
fi

t="$(mktemp -d)"
curl -fsSL --retry 3 "$(npm view "@oh-my-pi/pi-natives-linux-x64@${LATEST#v}" dist.tarball)" | tar -xz -C "$t"
cp "$t"/package/pi_natives.linux-x64-*.node packages/natives/native/

bun run check:ts

mapfile -t tests < <(git diff --name-only --diff-filter=AMR "$LATEST" HEAD -- 'packages/*/test/*' | grep -E '\.test\.tsx?$' || true)
if [ "${#tests[@]}" -eq 0 ]; then
	echo "::warning::FleetDriver patch queue changes no test files"
	exit 0
fi
for pkg in $(printf '%s\n' "${tests[@]}" | cut -d/ -f1-2 | sort -u); do
	rel=()
	for f in "${tests[@]}"; do
		[ "${f#"$pkg"/}" != "$f" ] && rel+=("${f#"$pkg"/}")
	done
	echo "==> $pkg: ${rel[*]}"
	(cd "$pkg" && bun test "${rel[@]}")
done
