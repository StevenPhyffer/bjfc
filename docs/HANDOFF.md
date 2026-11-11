# bjfc — handoff (project memory)

Keep this current: the next session (human or AI) starts here. No secrets.

## State
- Built 2026-10-03 as a client demo; first hosted copy was uploaded by hand.
- 2026-10-26: the staging webapp was deleted (we thought the client had dropped it), then the
  client said he's still interested. The project was brought under Iris (git, `iris.yml`,
  `deploy/deploy.sh`) and staging was restored from this repo with the full demo content.
  Checked end to end through the domain: login, demo financials (20 quotes, 26 invoices) and the
  Claude assistant with tool use all work.
- 2026-11-11: production moved to BJFC's own Azure (tenant managed by Datalink IT — Ugan Rajoo,
  Govind Maharaj). Terraform in `infra/terraform` created the B1 plan, web app `bjfc-commandcentre`
  (Node 24, Linux) and Key Vault `kv-bjfc-commandcentre` in `rg-bjfc-commandcentre` (South Africa North).
  Staging stays on RunCloud (`target` = ubuntu-vps, `target_production` = azure-webapp).

## Environments
| | branch | URL | where |
|---|---|---|---|
| staging | test | https://bjfc.webpress.solutions | 144.76.56.119 (`bjfc-staging`), `/home/runcloud/webapps/bjfc-sa` |
| production | main | https://bjfc-commandcentre.azurewebsites.net (later command.bjfc.co.za) | BJFC Azure, sub `f42cbabf-…`, `rg-bjfc-commandcentre` |

## Server layout (staging)
- `releases/<sha>`, `current` → active release, `shared/.env` (mode 600), `shared/data/`
  (users.json, config.json — survive deploys; each release links `data` → `shared/data`).
- pm2 process `bjfc-sa` runs `current/server.js` on 127.0.0.1:4310. nginx proxies the domain to it
  through `/etc/nginx-rc/extra.d/bjfc-sa.location.main-before.node.conf` (copy in `deploy/nginx/`;
  install as root, then `nginx-rc -t && systemctl reload nginx-rc`). SSL is issued in the RunCloud panel.
  Deleting the web app in RunCloud deletes that snippet too — that's why the domain showed the
  RunCloud welcome page after the restore until it was put back.
- `shared/.env` holds: ANTHROPIC_API_KEY, SESSION_SECRET, PUBLIC_MODE=1,
  ALLOWED_HOSTS=bjfc.webpress.solutions, SOURCES_ROOT=…/current/demo-data, ADMIN_EMAIL/NAME.
- Demo login: `admin@bjfc.co.za`, password in the macOS Keychain, service `bjfc-staging-admin`.
  The client's previous login was lost with the old users.json (hashes only, not recoverable).
  Change it with `node scripts/user.js passwd <email>` in `current/` on the server.

## Production (Azure)
- Access: Steven is a guest (steven@jarrahlabs.dev) with Contributor + RBAC Administrator on the
  resource group only. The RBAC role has an ABAC condition: it may only grant **Key Vault Secrets
  User**. Datalink granted Steven Key Vault Secrets Officer on the vault (2026-11-12, outside Terraform).
- Login: `az login --tenant bjfc.co.za`. Tools live in `~/.local/bin` (no Homebrew: no sudo in
  Claude's shell): terraform (HashiCorp zip), az (venv in `~/.local/share/azure-cli`).
- Terraform state: `/Volumes/MacD/Vault/bjfc/terraform/` (local backend). `terraform.tfvars` holds
  only the subscription id (gitignored).
- App settings: non-secrets managed by Terraform. SESSION_SECRET and ADMIN_PASSWORD are Key Vault
  references (secrets `session-secret`, `admin-password`), set with az — Terraform ignores those keys.
  Admin password also in the Keychain, service `bjfc-production-admin`. ANTHROPIC_API_KEY not set
  yet — use a NEW key (old one leaked, S6): `az keyvault secret set -n anthropic-api-key --file …`,
  then the app setting `ANTHROPIC_API_KEY` = Key Vault reference, and add it to Terraform's ignore list.
- Data: `DATA_DIR=/home/data` (users.json, config.json, and `ENV_FILE=/home/data/.env`) — /home
  survives deploys. App Service runs `npm install` on deploy (SCM_DO_BUILD_DURING_DEPLOYMENT).
- Deploy: `deploy/deploy.sh production` zips the commit and runs `az webapp deploy` (Entra auth;
  basic-auth publishing is off). No slot — staging is the RunCloud box.
- Still to do: Anthropic key, seed config.json (SharePoint demo site) like staging, custom domain
  command.bjfc.co.za (CNAME + asuid TXT to Datalink), M365 app registration for SharePoint.

## Decisions
- `data/` is runtime state, not in git. The demo SharePoint site and source list were seeded into
  `shared/data/config.json` from the local copy (paths rewritten to the server).

## Gotchas
- Azure: `az webapp deploy --track-status true` hangs on "Starting the site" even after the site is
  up — the target uses `--track-status false` and deploy.sh's health check decides.
- The VPS target's release prune failed every deploy when nothing needed pruning (grep exit 1 under
  pipefail), so staging deploys were never logged. Fixed here; the Iris template still has the bug.
- First production deploy 2026-11-11 (2af91b6): admin login checked OK on the Azure URL.
- SSH alias `bjfc-staging` uses `~/.ssh/debeer_deploy` (the key runcloud already trusts);
  `id_ed25519` isn't authorised for runcloud yet (D1 says it should be).
- GitHub repo was created by hand on github.com (no `iris-github-token` in the Keychain yet); branch protection / environments from
  `infra/terraform` are not set up yet.

## In progress / next
- Add infra/terraform (GitHub branch protection) and authorise `id_ed25519` for runcloud.
- Rotate the Anthropic key that was pasted into a chat session on 2026-10-26 (S6).
- `.env.example` needs `DATA_DIR=` and `ENV_FILE=` added (Claude can't read .env* files here).
