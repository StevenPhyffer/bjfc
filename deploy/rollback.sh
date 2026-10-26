#!/usr/bin/env bash
# deploy/rollback.sh <staging|production> [<sha>|--list] — ubuntu-vps/hetzner-cloud.
#
# No sha: undo the latest deploy, i.e. point current at the release deployed before it.
# Safe to run twice: if current is no longer the latest deploy, it says so and changes
# nothing — going further back needs an explicit <sha> (see --list).
# Rollback restores CODE only. Database migrations the bad release ran stay applied;
# if migrations_dir is set in iris.yml, the ones the target release lacks are listed
# and production asks before switching.
set -euo pipefail
ENV="${1:?staging|production [<sha>|--list]}"; ARG="${2:-}"; cd "$(git rev-parse --show-toplevel)"
cfg() { sed -n "s/^$1:[[:space:]]*//p" iris.yml | head -1 | sed 's/^"\(.*\)"$/\1/'; }
HOST=$(cfg "ssh_host_$ENV"); DIR=$(cfg "app_dir_$ENV"); RESTART=$(cfg restart); MIG=$(cfg migrations_dir)
[ "$ENV" = staging ] || [ "$ENV" = production ] || { echo "usage: $0 staging|production [<sha>|--list]" >&2; exit 2; }
[ -z "$ARG" ] || [ "$ARG" = --list ] || [[ "$ARG" =~ ^[0-9a-f]{40}$ ]] || { echo "<sha> must be a full 40-char release name (see --list)" >&2; exit 2; }
[ -n "$HOST" ] && [ -n "$DIR" ] || { echo "ssh_host_$ENV / app_dir_$ENV missing in iris.yml" >&2; exit 2; }
remote() { ssh -o BatchMode=yes "$HOST" bash -s -- "$@"; }

if [ "$ARG" = --list ]; then
  remote <<REMOTE
cur=\$(basename "\$(readlink -f '$DIR/current')"); echo "current: \$cur"
[ -f '$DIR/deploy-history' ] && { echo "deploys (newest last):"; tail -n 10 '$DIR/deploy-history'; }
echo "on disk:"; ls -1t '$DIR/releases'
REMOTE
  exit 0
fi

# Pick the target on the server; prints "<current> <target>" or a message + exit 3 (nothing to do).
PLAN=$(remote "$ARG" <<REMOTE
set -euo pipefail
want="\${1:-}"; hist='$DIR/deploy-history'
cur=\$(basename "\$(readlink -f '$DIR/current')")
if [ -n "\$want" ]; then
  [ -d '$DIR/releases/'"\$want" ] || { echo "no release \$want on the server (try --list)" >&2; exit 1; }
  [ "\$want" != "\$cur" ] || { echo "\$want is already current — nothing to do" >&2; exit 3; }
  echo "\$cur \$want"; exit 0
fi
if [ -f "\$hist" ]; then
  last=\$(tail -n 1 "\$hist" | awk '{print \$2}')
  [ "\$cur" = "\$last" ] || { echo "already rolled back: current is \$cur, latest deploy was \$last. To go further back: deploy/rollback.sh $ENV <sha> (see --list)" >&2; exit 3; }
  # Skip releases already rolled back from — they were bad once; pass a <sha> to pick one anyway.
  bad=\$(awk '{print \$2}' '$DIR/rollback-log' 2>/dev/null; echo "\$cur")
  prev=\$(awk '{print \$2}' "\$hist" | grep -vxF "\$bad" | tac | while read -r s; do [ -d '$DIR/releases/'"\$s" ] && { echo "\$s"; break; }; done)
else
  # Deployed before deploy-history existed: fall back to directory age, but only from the newest release.
  newest=\$(basename "\$(ls -1dt '$DIR'/releases/* | head -1)")
  [ "\$cur" = "\$newest" ] || { echo "current (\$cur) isn't the newest release — looks already rolled back. Pass a <sha> (see --list)" >&2; exit 3; }
  prev=\$(ls -1t '$DIR/releases' | grep -vxF "\$cur" | head -1)
fi
[ -n "\$prev" ] || { echo "no previous release on the server" >&2; exit 1; }
echo "\$cur \$prev"
REMOTE
) || { rc=$?; [ $rc = 3 ] && exit 0; exit $rc; }
read -r FROM TO <<<"$PLAN"
echo "▶ $ENV: $FROM → $TO"

# Migrations: files in the bad release's migrations_dir that the target release doesn't have.
if [ -n "$MIG" ]; then
  NEW=$(remote <<REMOTE
comm -23 <(ls -1 '$DIR/releases/$FROM/$MIG' 2>/dev/null | sort) <(ls -1 '$DIR/releases/$TO/$MIG' 2>/dev/null | sort)
REMOTE
)
  if [ -n "$NEW" ]; then
    printf '\033[33m⚠ %s ships migrations that %s does not have. Rollback does NOT undo them — the old code\n  will run against the newer schema. Revert them by hand first if they are not backward-compatible:\033[0m\n' "$FROM" "$TO"
    printf '    %s\n' $NEW
    if [ "$ENV" = production ]; then printf 'Roll back production anyway? [y/N] '; read -r yn; [ "$yn" = y ] || exit 1; fi
  fi
else
  echo "note: rollback restores code only — any migrations $FROM ran are still applied (set migrations_dir in iris.yml to have them listed)."
fi

remote <<REMOTE
set -euo pipefail
ln -sfn '$DIR/releases/$TO' '$DIR/current.new' && mv -Tf '$DIR/current.new' '$DIR/current'
echo "\$(date -u +%FT%TZ) $FROM -> $TO" >>'$DIR/rollback-log'
cd '$DIR/current'; ${RESTART:-true}; echo "✓ rolled back to $TO"
REMOTE
