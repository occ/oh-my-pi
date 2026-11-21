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

# Registry metadata via curl+jq, not `npm view`: local resolution shells often
# lack npm. Standalone assignments so a failed lookup stops the script under
# errexit, and the tarball must match the registry's integrity before unpacking.
for platform in "$@"; do
	pkg="@oh-my-pi/pi-natives-$platform"
	meta="$(curl -fsSL --retry 3 "https://registry.npmjs.org/$pkg/$version")"
	url="$(jq -er .dist.tarball <<<"$meta")"
	integrity="$(jq -er .dist.integrity <<<"$meta")"
	t="$(mktemp -d)"
	curl -fsSL --retry 3 -o "$t/addon.tgz" "$url"
	actual="sha512-$(openssl dgst -sha512 -binary "$t/addon.tgz" | openssl base64 -A)"
	if [ "$actual" != "$integrity" ]; then
		echo "::error::$pkg@$version tarball does not match the registry integrity $integrity"
		exit 1
	fi
	tar -xzf "$t/addon.tgz" -C "$t"
	cp "$t"/package/pi_natives."$platform"*.node packages/natives/native/
	rm -rf "$t"
	echo "installed $pkg@$version"
done
