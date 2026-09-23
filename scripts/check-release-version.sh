#!/usr/bin/env bash
# Validate a release version against the release policy.
#
# The release policy is SemVer: `major.minor.patch`, an optional `-prerelease`, no
# leading zeros in a numeric component or numeric prerelease identifier, and at most
# 64 characters, which is the limit the artifact builder enforces. Build metadata
# (`+`) is refused: it is legal SemVer, but it cannot survive asset naming and
# query-string handling in the publishing workflow unchanged.
#
# This lives in one place because a tag pushed by hand reaches the workflow without
# passing through the operator command, and two implementations of the same rule
# drift: the workflow previously accepted versions the operator command refused.
#
# Exit status: 0 when the version is acceptable, 1 when it is not.
set -u

version=${1:-}

if [ -z "$version" ] || [ "${#version}" -gt 64 ]; then
  exit 1
fi

case "$version" in
  *+*) exit 1 ;;
esac

case "$version" in
  *-*) core=${version%%-*}; prerelease=${version#*-} ;;
  *) core=$version; prerelease='' ;;
esac

case "$core" in
  *.*.*) ;;
  *) exit 1 ;;
esac

major=${core%%.*}
rest=${core#*.}
minor=${rest%%.*}
patch=${rest#*.}

case "$patch" in
  *.*) exit 1 ;;
esac

for component in "$major" "$minor" "$patch"; do
  case "$component" in
    ''|*[!0-9]*|0*[0-9]*) exit 1 ;;
  esac
done

if [ -n "$prerelease" ]; then
  case "$prerelease" in
    *[!0-9A-Za-z.-]*|.*|*.|*..*|*-) exit 1 ;;
  esac
  saved_ifs=$IFS
  IFS=.
  for identifier in $prerelease; do
    case "$identifier" in
      ''|*[!0-9]*) ;;
      0) ;;
      0*) IFS=$saved_ifs; exit 1 ;;
    esac
  done
  IFS=$saved_ifs
else
  # A trailing `-` with nothing after it is not a prerelease.
  case "$version" in
    *-) exit 1 ;;
  esac
fi

exit 0
