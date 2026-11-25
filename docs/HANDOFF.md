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
  Admin password also in the Keychain, service `bjfc-production-admin`. ANTHROPIC_API_KEY set
  2026-11-12 (Key Vault reference) — use a NEW key (old one leaked, S6): `az keyvault secret set -n anthropic-api-key --file …`,
  then the app setting `ANTHROPIC_API_KEY` = Key Vault reference, and add it to Terraform's ignore list.
- Data: `DATA_DIR=/home/data` (users.json, config.json, and `ENV_FILE=/home/data/.env`) — /home
  survives deploys. App Service runs `npm install` on deploy (SCM_DO_BUILD_DURING_DEPLOYMENT).
- Deploy: `deploy/deploy.sh production` zips the commit and runs `az webapp deploy` (Entra auth;
  basic-auth publishing is off). No slot — staging is the RunCloud box.
- Still to do: Anthropic key, seed config.json (SharePoint demo site) like staging, custom domain
  command.bjfc.co.za (CNAME + asuid TXT to Datalink), M365 app registration for SharePoint.

## Microsoft sign-in + SharePoint (feat/ms-signin, in progress)
- Sign-in code done (lib/entra.js, tests/entra.test.mjs). Switches on when ENTRA_TENANT_ID,
  ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET are app settings.
  Tenant id: e1ec689f-56b4-4ede-8ff1-5cf9776b2fa8. Redirect URIs: https://<host>/auth/microsoft/callback.
- 2026-11-20: app registration "BJFC Command Centre" (app id 5a314e37-4861-48de-a66b-6e15014fc4cc,
  object id 8d3eabde-…) is live. Datalink created the client secret and put it in Key Vault as
  **`BJFC-CC-Key`** (credential `BJFC_CC_Secret`, expires 2028-11-17). A second credential
  `entra-client-secret` (exp 2028-11-18) is on the app but unused — ask Datalink to delete it.
  Checked: client-credentials token works, roles = [Sites.Selected] (admin consent granted).
  Production app settings set: ENTRA_TENANT_ID/ENTRA_CLIENT_ID via Terraform, ENTRA_CLIENT_SECRET
  = Key Vault ref to BJFC-CC-Key via az (Terraform ignores it); all refs show Resolved.
  Deployed b3e38f4 to staging and production 2026-11-20. Production: /api/auth-options →
  microsoft:true, /auth/microsoft → BJFC authorize URL (right client id + callback, PKCE S256),
  password login OK. Staging: no ENTRA_* (Microsoft button hidden), password login OK.
  Not yet tested: a real Microsoft sign-in (needs a person) — the user must exist in the Command
  Centre with email = their UPN (amjoubert@bjfc.co.za, steven@jarrahlabs.dev).
  After an Azure deploy the old code serves for ~1–2 min after deploy.sh says ✓ (health check
  passes on the old process).
- Steven is owner of the app but the guest account can't change it (addPassword → 403) or read the
  Enterprise Application (consent/assignments) — Datalink does those.
- SharePoint sites Adrian chose (bjfc1.sharepoint.com): "BJFC Projects" and "BJ-FC_Finance_Accounts"
  (finance one gets filled later). URLs not confirmed (guessed /sites/BJFCProjects → 404); Datalink
  to grant read and send the URLs.
- Users are matched on the Entra sign-in name (preferred_username), so a user's email in the Command
  Centre must equal their UPN (guests: their own email). First sign-in binds the Entra object id.
- One app registration for sign-in + SharePoint (Sites.Selected, chosen sites only — decided
  2026-11-12). Datalink says assignment required + Adrian/Steven assigned is done (18 Nov).
- SharePoint connector (feat/sharepoint-connector, 2026-11-20): uses the ENTRA_* app credentials
  when a site has none of its own (form hides the credential fields then; nothing secret in
  config.json). Walks each library with Graph delta (all files, cap 5000/site), extracts text from
  PDF (unpdf 1.6.2 — newer unpdf needs Node ≥22/24, local is 20), docx/xlsx/pptx (lib/extract.js,
  own zip reader) and text files; ≤25 MB per file, 4 at a time, 429 back-off, unchanged files not
  re-downloaded. Sync runs in the background (add / Sync button / start-up / every
  SHAREPOINT_SYNC_HOURS=6). Only admins add/change/remove sites. Legacy .doc/.xls and scanned PDFs
  are indexed by name only. Local folders (indexer.js) still read text files only.
- Live check 2026-11-20 with the real app: token OK; bjfc1.sharepoint.com root → "Access denied"
  (= not granted yet, as expected). Connect each site under Data Sources › SharePoint once granted.
- 2026-11-23: Adrian changed the scope to the whole primary site (https://bjfc1.sharepoint.com —
  "BJFC Projects" and "BJ-FC_Finance_Accounts" are folders/libraries in it, not separate sites).
  Govind says the app was allowed. Live check 2026-11-24 02:35 UTC: token OK, roles =
  [Sites.Selected], but `/sites/root`, `/sites/bjfc1.sharepoint.com` and its `/drives` still → 403
  accessDenied (Graph request-id b4cbfadd-2a6b-4dae-88a0-958f8ea03eb7). So no site permission for
  app 5a314e37-… is in effect yet — asked Datalink to check how it was granted (needs
  `Grant-PnPAzureADAppSitePermission … -Site https://bjfc1.sharepoint.com -Permissions Read`, or
  Graph POST /sites/root/permissions). Steven's guest user has no access to the site either.
- 2026-11-24 06:55 UTC, after Datalink re-ran the grant: root site now readable ("BJFC Consulting
  Team Site", connector's testConnection OK). But it holds almost nothing: one library "Documents"
  with one folder "BJFC Admin" = a OneNote notebook (8 files, 2.5 MB), no subsites. "BJFC Projects"
  and "BJ-FC_Finance_Accounts" are NOT folders in it — they must be separate site collections
  (bjfc1.sharepoint.com/sites/<name>), which a grant on the root site does not cover. Guessed URLs
  still 404. Asked Datalink for the exact URLs and a read grant on each of those two sites.
- 2026-11-25: Adrian sent a phone screenshot of a "Documents" library with four folders:
  BJFC_Accounts, BJFC Projects, BJFC Archives, BJFC Admin (all modified 2024-12-05). That is NOT
  the root site's library (which has only a 2021 "BJFC Admin" OneNote folder) — it is another
  site's Documents library; its URL is still unknown. Need that site's URL + a read grant on it.
  Also seen: Graph drive search (`/drive/root/search`) returns 500 generalException with the
  Sites.Selected app token on the root site — searchSharePoint() (the agent's live search tool)
  uses it, so check it on the real site and fall back to the local index if it still fails.
- **2026-11-25: the real site is https://bjfc1.sharepoint.com/sites/BJFCConsulting** ("BJFC Consulting")
  and the app can already read it (Datalink's grant covers it; site-permission list not visible to
  us). Its "Documents" library is BJFC's whole file store: BJFC Admin (33 GB, incl. HR, staff,
  legal, salaries), BJFC Projects (323 GB, 282 GB of it "DoT KZN"), BJFC_Accounts (14 GB),
  BJFC Archives. The root site (bjfc1.sharepoint.com) is irrelevant — only an old OneNote folder.
  Also exist but not granted (403): /sites/BJFCAccounts, /sites/BJFCAdmin. Ignore the earlier
  notes about asking Datalink for URLs.
- Connector additions (uncommitted on feat/sharepoint-connector, tests pass, checked live locally):
  - `sp.folders` — index only these folders (paths from the library root; blank = whole site).
    Needed here: the site is far over the 5000-file cap and holds HR/legal/salary files.
  - `sp.invoiceRegister` — path of the accounts "schedule of invoices" workbook; lib/register.js
    turns each row into an invoice (paid = has "Date of Pmt"; overdue = unpaid past
    INVOICE_TERMS_DAYS, default 30 — an assumption, confirm BJFC's terms). Uses the sheet with the
    newest invoice (currently the one named "2024", IN002195 → today). "Client" on the dashboard is
    the project code (DOT86 …): the register has no client names.
  - Both are set in Data Sources › SharePoint (add form, or "Whole site / Limited to…" on a site).
  - search_sharepoint falls back to the synced index: Graph folder search 500s with this token.
- Live figures from that run (register as at 2026-11-24): 180 invoices, 23 unpaid = R11.39m,
  18 overdue = R10.19m, billed last 90 days R6.03m. Scope used: the register +
  `BJFC_Accounts/BJ-FC_Finance_Accounts` (empty folder tree so far) +
  `BJFC_Accounts/Accounts Administration/Quotations` + `BJFC Admin/BJ-FC Quotations` → 201 docs, 22 s.
- **Live on production 2026-11-25** (aaf3ed4, through staging first): site "BJFC Consulting"
  connected with that scope, `DEMO_DATA=off` applied with Terraform (plan: 1 in-place change).
  Checked on the Azure URL: 180 invoices, 23 unpaid R11.39m, 18 overdue R10.19m, 201 files, monitor
  shows only "Hosting server". Staging keeps the demo data (no ENTRA_*, no real data there).
- Terraform backend path now `/Users/steven/Library/MacD/Vault/bjfc/terraform/` (was /Volumes/MacD).
- Production admin login for API checks: email = app setting ADMIN_EMAIL, password = Key Vault
  secret `admin-password`. The Keychain items `bjfc-staging-admin` / `bjfc-production-admin` /
  `bjfc-anthropic-api-key` were NOT found on this Mac on 2026-11-25 (lost in the workspace move?).
- Library census 2026-11-25 (whole "Documents" library): 158,029 files in 87,351 folders, 370 GB.
  98,251 files / 282 GB are `BJFC Projects/DoT KZN`. 97,663 files (99 GB) are readable types
  ≤25 MB (pdf 70k, docx 14k, xlsx 12.5k). A full listing by Graph delta takes ~7.5 min.
- 2026-11-25 (second commit of the day, on staging; production pending Steven's go-ahead):
  - **Monitor page redesigned**: per machine, separate Processor / Memory / Storage panels (ring
    gauge, 5-min history with hover, per-core bars, the app's own memory, volumes), colours
    --m-cpu / --m-ram / --m-disk (validated chart palette slots 1–3), plus a "Command Centre
    services" card (SharePoint sync, index, AI, Microsoft sign-in — real state from server.js
    appServices()). On production the one machine, "Hosting server", is REAL: the Azure B1
    container (1 core, 1.8 GB RAM, ~70% used at idle). BJFC's office servers are not monitored —
    the BJFC-SRV01 / NAS cards on staging are simulated. `App data` volume = /home on Azure.
  - **Documents page**: `/api/documents?page=1` → idx.queryDocs(): newest first by default (invoice
    date for invoices, modified date for files), every filter combines (status, keyword — all
    words must match — location, file kind, period), sort options, and "Showing 500 of N".
  - **Connector for big libraries**: SHAREPOINT_MAX_FILES (default 5000) and SHAREPOINT_TEXT_FILES
    (default: all; else the newest N get text, the rest are listed by name). Extracted text is
    kept in DATA_DIR/sp-cache/<site>.jsonl so restarts don't re-download. Results are published
    in stages (register invoices → all files by name → text as it's read). Graph calls retry
    dropped connections/5xx and time out (2 min listing, 10 min download) — a whole-library
    listing hung and died without these. With a register set, only its rows are type "invoice".
  - Whole-library switch NOT done yet: needs SHAREPOINT_MAX_FILES≈200000 + a text budget in
    Terraform and the site's folder list cleared; waiting on a local trial for memory numbers
    (B1 has little headroom).
- Ollama (2026-11-25): Steven wants the assistant on a locally hosted model ON THE PRODUCTION
  SERVER, not on his Mac (a trial install on the Mac was removed again). B1 can't run a useful
  model (1 core, 1.8 GB, no GPU) — needs a bigger plan or a GPU VM; decision + cost pending.
  No provider-switch code written yet (lib/agent.js is Anthropic-only).
- Still open: "Open quotes" stays R0 — BJFC has no quote register and real quotes carry no status
  field (everything under a "Quotations" folder is typed quote, even photos). BJFC Projects is not
  indexed yet (size; needs a per-project choice). To go live: commit → test → main, connect the
  site in production with the scope above, then DEMO_DATA=off. Real BJFC data should not go on
  the shared staging box (no ENTRA_* there anyway).
- `DEMO_DATA=off` hides demo folders, simulated servers and demo SharePoint (filtered on read,
  kept in config.json) and skips demo seeding. Set it in Terraform app_settings for production
  only after the real sites are connected and synced — otherwise the dashboards go empty.
- `.env.example` also needs ENTRA_TENANT_ID=, ENTRA_CLIENT_ID=, ENTRA_CLIENT_SECRET=.
- The Anthropic key (Keychain `bjfc-anthropic-api-key`, Key Vault `anthropic-api-key`) was pasted in
  a chat on 2026-11-12 — rotate it when convenient (S6).

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
