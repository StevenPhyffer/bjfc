#!/usr/bin/env bash
# deploy/deploy.sh <staging|production> — the only way this project ships (STANDARDS D3).
#
# Gates, in order: clean tree → commit is on GitHub (G3) → Iris reviewed its tree (R4)
# → production only if that commit already went to staging (G4). Then the target
# script in deploy/targets/<target>.sh runs, then the health check (D5).
set -euo pipefail
ENV="${1:-}"; [ "$ENV" = staging ] || [ "$ENV" = production ] || { echo "usage: $0 staging|production" >&2; exit 2; }
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
cfg() { sed -n "s/^$1:[[:space:]]*//p" iris.yml | head -1 | sed 's/^"\(.*\)"$/\1/'; }
die() { printf '\033[31m✋ %s\033[0m\n' "$*" >&2; exit 1; }
NAME=$(cfg name); TARGET=$(cfg target)
BRANCH=$([ "$ENV" = staging ] && echo test || echo main)
IRIS_HOME="${IRIS_HOME:-$HOME/.iris}"
LOG="$IRIS_HOME/deploys/$NAME.log"; mkdir -p "$(dirname "$LOG")"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit (Iris reviews it) or stash first"
git fetch -q origin "$BRANCH" || die "can't fetch origin/$BRANCH — push to GitHub first (G3)"
SHA=$(git rev-parse "origin/$BRANCH")
TREE=$(git rev-parse "$SHA^{tree}")

# A merge commit with the same tree as its reviewed parent passes; a non-fast-forward
# merge that combines changes needs its own review (iris-review --commit).
reviewed() { local f="$IRIS_HOME/reviews/$1.json"; [ -f "$f" ] && [ "$(jq -r .verdict "$f")" = pass ]; }
reviewed "$TREE" || die "origin/$BRANCH (${SHA:0:8}) has no passing Iris review — run: iris-review --commit $SHA"

if [ "$ENV" = production ]; then
  git fetch -q origin test || true
  git merge-base --is-ancestor "$SHA" origin/test || die "${SHA:0:8} is not on origin/test — staging first (G4)"
  grep -q "staging $TREE" "$LOG" 2>/dev/null || die "this exact code (${TREE:0:8}) was never deployed to staging (G4)"
  printf 'Deploy %s %s to PRODUCTION? [y/N] ' "$NAME" "${SHA:0:8}"; read -r yn; [ "$yn" = y ] || exit 1
fi

export IRIS_ENV="$ENV" IRIS_SHA="$SHA" IRIS_NAME="$NAME" IRIS_ROOT="$ROOT"
export IRIS_SSH_HOST=$(cfg "ssh_host_$ENV") IRIS_APP_DIR=$(cfg "app_dir_$ENV")
export IRIS_BUILD=$(cfg build) IRIS_RESTART=$(cfg restart) IRIS_STATIC_DIR=$(cfg static_dir)
export IRIS_AZ_RG=$(cfg azure_resource_group) IRIS_AZ_APP=$(cfg azure_webapp)
export IRIS_CUSTOM_CMD=$(cfg "deploy_$ENV")
SCRIPT="$ROOT/deploy/targets/$TARGET.sh"
[ -x "$SCRIPT" ] || die "no deploy target script: deploy/targets/$TARGET.sh"
echo "▶ $NAME → $ENV via $TARGET (${SHA:0:8})"
"$SCRIPT"

URL=$(cfg "health_url_$ENV")
if [ -n "$URL" ]; then
  for i in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -A 'Mozilla/5.0 iris-deploy' "$URL" || true)
    [ "${code:0:1}" = 2 ] || [ "${code:0:1}" = 3 ] && break; sleep 5
  done
  [ "${code:0:1}" = 2 ] || [ "${code:0:1}" = 3 ] || die "health check failed: $URL → $code (previous release is kept; deploy/rollback.sh $ENV — code only, migrations stay applied)"
  echo "✓ health $URL → $code"
fi
LINE="$(date -u +%FT%TZ) $ENV $TREE $SHA"
echo "$LINE" >>"$LOG"
# Iris's Reviews view shows deploys too (best effort).
printf '%s\n' "$LINE" | ssh -o BatchMode=yes -o ConnectTimeout=8 "${IRIS_VAULT_SSH:-iris-server}" \
  "mkdir -p /home/runcloud/webapps/iris-kuphal/data/reviews/deploys && cat >> '/home/runcloud/webapps/iris-kuphal/data/reviews/deploys/$NAME.log'" 2>/dev/null || true
echo "✓ $NAME deployed to $ENV"
