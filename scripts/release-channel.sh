#!/usr/bin/env bash
# Classify a version into a NookBridge release channel.
#
# Channels:
#   stable  `major.minor.patch`
#   beta    `major.minor.patch-beta.<counter>`, counter a non-negative integer
#           with no leading zero
#
# Every other version is refused. The grammar is not reimplemented here: the
# version is first validated by `check-release-version.sh`, the single
# implementation of the release policy, so the operator command and the
# publishing workflow cannot disagree about what a well-formed version is and
# burn an immutable tag on a version they would reject later.
#
# Exit status: 0 with `stable` or `beta` on stdout, 1 with no output otherwise.
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
version=${1:-}

bash "$script_dir/check-release-version.sh" "$version" >/dev/null 2>&1 \
  || exit 1

case "$version" in
  *-*) prerelease=${version#*-} ;;
  *) printf 'stable\n'; exit 0 ;;
esac

case "$prerelease" in
  beta.*) ;;
  *) exit 1 ;;
esac

counter=${prerelease#beta.}
case "$counter" in
  ''|*[!0-9]*) exit 1 ;;
  0) ;;
  0*) exit 1 ;;
esac

printf 'beta\n'
