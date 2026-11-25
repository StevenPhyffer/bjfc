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
  - Whole-library switch NOT done, and not safe on B1. Local trial 2026-11-25 (whole site, text
    for the newest 300 files, 700 MB heap cap): listing 158,209 files took 415 s; names alone =
    263 MB heap / 469 MB RSS; reading PDFs pushed RSS to ~1.0 GB peak; queries stay fast
    (recent list 36 ms, search ~50 ms). Production B1 sits at ~80% of 1.8 GB with the app at
    210 MB, so there is no room. Needs a bigger plan (B2 3.5 GB / B3 7 GB) — Steven to decide.
    Then: SHAREPOINT_MAX_FILES=200000 and SHAREPOINT_TEXT_FILES=<budget> in Terraform, clear the
    site's folder list. Whole site also means HR / salary / legal files become searchable.
- Ollama (2026-11-25): Steven asked about a locally hosted model on the production server (not
  on his Mac — a trial install there was removed). B1 can't run a useful model (1 core, 1.8 GB,
  no GPU). Decision: **stay with Anthropic for now.** No provider-switch code was written.
- Production and staging are both on 7b96a22 (monitor redesign, document filters, and the two
  document date-ordering fixes cc6fd52 / 7b96a22).
- 2026-11-25: production assistant switched to `claude-sonnet-5-5` (effort medium) to save cost —
  a runtime setting (Settings › Model, stored in `/home/data/config.json`), not a code change.
- 2026-11-25: checked production sign-in. Microsoft sign-in is on; users are the password admin
  (ADMIN_EMAIL), Steven and Adrian Joubert — both admins, Microsoft-only, and both already bound
  to their Microsoft account (i.e. each has signed in at least once).
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
- 2026-11-25 (afternoon): Yanick Douce (ydouce@bjfc.co.za, Adrian's partner) added on production
  as admin, Microsoft-only, at Adrian's request. Not yet bound (hasn't signed in).
- **Name-only folders, read on demand, categories from content** (Steven: "the data stays on
  SharePoint … pulls it forward if needed", "include everything", "don't always rely on their
  folder names, you will have to scan the data"):
  - `sp.listOnly` — folders listed by name only. Their text is never kept (not in memory, not in
    sp-cache). `liveText(doc)` in lib/sharepoint.js fetches one file from SharePoint when the
    drawer opens it (`GET /api/documents/:id`) or the assistant calls read_document; the last 8
    stay in memory only. `sp.exclude` — folders left out. Both in Data Sources › SharePoint.
  - Listing: with name-only folders (or the whole site) it is one delta listing of the library,
    filtered by path — a per-folder walk of "BJFC Admin" took 86 min in a trial. Small indexed
    folders alone are still walked.
  - lib/categorise.js: rule-based area + category (Projects, Finance, Human Resources, Legal &
    Contracts, Tenders & Business Development, Quality & Compliance, Marketing, IT & Equipment,
    Company Admin, Personal, Other). Content outweighs name/folder; a known project code (from
    the invoice register and "…Projects/<CODE - name>" folders) files it under that project.
    `categorisedBy` = "content" | "name". Expect some wrong labels — tune RULES there.
  - Sync stage 5: name-only files are opened once each, ONE AT A TIME (shared `serial()` queue
    with liveText), to categorise them; only the label is kept
    (`DATA_DIR/sp-cache/<site>.labels.jsonl`). A "being read" mark is written first, so a file
    that crashes the server is skipped afterwards. Env: SHAREPOINT_SCAN=off disables it,
    SHAREPOINT_SCAN_MB (default 10) size limit, SHAREPOINT_SCAN_FILES max per sync.
    The first pass over ~25,000 readable files takes many hours; the site shows "Syncing" meanwhile.
  - Documents page: Area and Category filters (`/api/documents/facets`); assistant's
    search_documents takes `area` and `folder`.
  - Terraform: SHAREPOINT_MAX_FILES=60000 (needs `terraform apply` on production).
  - Intended production scope for site "BJFC Consulting": keep the three indexed folders + the
    register; listOnly = `BJFC Admin`, `BJFC Projects`; exclude = `BJFC Projects/DoT KZN`
    (98,000 files — needs a bigger plan first, then just remove the exclusion and raise the cap).
    Steven chose to include Members and Human Resources (personal tax/medical files are in
    "BJ-FC Members"): their names are visible to every Command Centre user.
  - Access control: there is none per folder or per user. Any signed-in user (auth check in
    server.js before the routes) can list and open any indexed file; the assistant additionally
    needs the site's "AI access" switch. Today's users are all admins/partners. Before adding
    ordinary staff, add a per-area permission.
  - TODO: `.env.example` doesn't list SHAREPOINT_SCAN / SHAREPOINT_SCAN_MB / SHAREPOINT_SCAN_FILES
    yet (Claude's permission settings block that file — add by hand).
- **Live on production 2026-11-25 ~10:20 SAST** (743c3dc, through staging; `terraform apply`
  added SHAREPOINT_MAX_FILES=60000 — plan showed that one change). Site "BJFC Consulting" now has
  listOnly `BJFC Admin` + `BJFC Projects`, exclude `BJFC Projects/DoT KZN`: 35,277 files listed
  (688 with stored text: the indexed finance/quotation folders have filled up since the morning).
  Checked live: Area/Category filters with counts, and a name-only Word file read on demand.
  - Numbers: listing ~8.5 min (delta); local trial peak 358 MB RSS for the whole run incl. the
    scan at ~50 files/min; production app went 221 → ~325 MB RSS while scanning. The first
    categorising pass (~25,000 readable files) will take many hours on B1 — until a file is
    scanned its category comes from its name/folder, so "General" buckets are large at first
    (Projects 3,900, Company Admin 4,200). Check them again when the scan is done and tune RULES.
  - Live reads share the one-at-a-time queue with the scan, so opening a file during the first
    pass can wait behind the file being scanned.
- 2026-11-25 ~16:30: after go-live Steven reported "a massive error", slow pages, and no new
  folders in the side menu. Cause: PDF text extraction ran on the main thread, so during the
  categorising scan every request took 1.5–3 s on B1's single core and the app restarted once
  (health check unanswered, or memory). Fix in 97ca14a (on staging; main is fast-forwarded;
  **production deploy was blocked by Claude's permission check — needs Steven's explicit OK**):
  - lib/extractPool.js + lib/extractWorker.js: extraction in one worker thread with a heap
    ceiling (EXTRACT_WORKER_MB, default 320) and a 3-minute timeout (EXTRACT_TIMEOUT_MS).
  - Side menu "Library": one entry per area with its file count; the open area lists its
    categories (public/app.js renderAreas, fed by /api/documents/facets).
  - A folder in `folders` stays text-indexed even inside a `listOnly` folder (it had lost its
    text: "BJFC Admin/BJ-FC Quotations"); name-only files named "tender…/proposal…" are no longer
    type "quote" (the Quotes badge had jumped to 714).
  - Iris asked for tests of those two rules and of the worker pool — not written yet.
