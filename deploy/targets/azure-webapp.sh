#!/usr/bin/env bash
# Azure App Service (Linux), infra/terraform/azure.tf. This project has no slot: staging stays on
# the RunCloud VPS (target_staging), so production here deploys the reviewed, already-staged
# commit (deploy.sh enforces G4) straight to the web app. App Service runs `npm install` itself
# (SCM_DO_BUILD_DURING_DEPLOYMENT); data lives in /home/data, which deploys don't touch.
set -euo pipefail
: "${IRIS_AZ_RG:?azure_resource_group missing}" "${IRIS_AZ_APP:?azure_webapp missing}"
[ "$IRIS_ENV" = production ] || { echo "azure-webapp is the production target only" >&2; exit 1; }
command -v az >/dev/null || { echo "install the Azure CLI and run: az login" >&2; exit 1; }
SUB=(); [ -n "${IRIS_AZ_SUB:-}" ] && SUB=(--subscription "$IRIS_AZ_SUB")
ZIP=$(mktemp -t iris).zip; trap 'rm -f "$ZIP"' EXIT
git -C "$IRIS_ROOT" archive --format=zip -o "$ZIP" "$IRIS_SHA"
az webapp deploy ${SUB[@]+"${SUB[@]}"} -g "$IRIS_AZ_RG" -n "$IRIS_AZ_APP" --src-path "$ZIP" --type zip --track-status true
