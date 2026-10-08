#!/usr/bin/env bash
# Install upstream's published native addons for the base release into
# packages/natives/native. FleetDriver patches do not touch native sources, so
# the addon upstream published for the base tag is the one this tree would
# build. That keeps fd-release independent of upstream's internal Bazel CI.
# The embed step rejects addons without this release's version stamp, and the
# release binary's --smoke-test loads the embedded addon.
#
# Usage: fd-natives.sh <platform-tag>...   e.g. linux-x64 darwin-arm64
set -euo pipefail

UPSTREAM="${UPSTREAM:-https://github.com/can1357/oh-my-pi.git}"
version="$(jq -r .version packages/coding-agent/package.json)"
tag="v$version"

if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
	git fetch -q --no-tags --depth=1 "$UPSTREAM" "refs/tags/$tag:refs/tags/$tag"
fi
changed="$(git diff --name-only "$tag" HEAD -- crates Cargo.toml Cargo.lock)"
if [ -n "$changed" ]; then
	echo "::error::FleetDriver patches change native sources; upstream's $tag addons do not match:"
	echo "$changed"
	exit 1
fi

for platform in "$@"; do
	t="$(mktemp -d)"
	curl -fsSL --retry 3 "$(npm view "@oh-my-pi/pi-natives-$platform@$version" dist.tarball)" | tar -xz -C "$t"
	cp "$t"/package/pi_natives."$platform"*.node packages/natives/native/
	echo "installed @oh-my-pi/pi-natives-$platform@$version"
done
