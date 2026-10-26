#!/usr/bin/env bash
# Any Ubuntu server reachable by an ~/.ssh/config alias with this computer's key (D1).
# Layout on the server:  $APP_DIR/releases/<sha>  $APP_DIR/current → release  $APP_DIR/shared/.env
#   $APP_DIR/deploy-history — "<utc time> <sha>" per deploy, oldest first (rollback.sh reads it).
# Point nginx / pm2 at $APP_DIR/current. Keeps 5 releases for rollback.
set -euo pipefail
: "${IRIS_SSH_HOST:?ssh_host_$IRIS_ENV missing in iris.yml}" "${IRIS_APP_DIR:?app_dir_$IRIS_ENV missing in iris.yml}"
REL="$IRIS_APP_DIR/releases/$IRIS_SHA"
git -C "$IRIS_ROOT" archive --format=tar "$IRIS_SHA" |
  ssh -o BatchMode=yes "$IRIS_SSH_HOST" "mkdir -p '$REL' '$IRIS_APP_DIR/shared' && tar -x -C '$REL'"
ssh -o BatchMode=yes "$IRIS_SSH_HOST" bash -s <<REMOTE
set -euo pipefail
cd '$REL'
[ -f '$IRIS_APP_DIR/shared/.env' ] && ln -sfn '$IRIS_APP_DIR/shared/.env' .env
${IRIS_BUILD:-true}
ln -sfn '$REL' '$IRIS_APP_DIR/current.new' && mv -Tf '$IRIS_APP_DIR/current.new' '$IRIS_APP_DIR/current'
echo "\$(date -u +%FT%TZ) $IRIS_SHA" >>'$IRIS_APP_DIR/deploy-history'
cd '$IRIS_APP_DIR/current'
${IRIS_RESTART:-true}
# Prune: keep current, the last 5 deployed (by history) and the 5 newest dirs (servers deployed before the history file existed).
cur=\$(readlink -f '$IRIS_APP_DIR/current')
keep=\$( { tail -n 5 '$IRIS_APP_DIR/deploy-history' | awk '{print "$IRIS_APP_DIR/releases/" \$2}'; ls -1dt '$IRIS_APP_DIR'/releases/* | head -5; echo "\$cur"; } | sort -u)
ls -1d '$IRIS_APP_DIR'/releases/* | grep -vxF "\$keep" | xargs -r rm -rf
REMOTE
