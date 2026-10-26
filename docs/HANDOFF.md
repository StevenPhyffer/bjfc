# bjfc — handoff (project memory)

Keep this current: the next session (human or AI) starts here. No secrets.

## State
- Built 2026-10-03 as a client demo; first hosted copy was uploaded by hand.
- 2026-10-26: the staging webapp was deleted (we thought the client had dropped it), then the
  client said he's still interested. The project was brought under Iris (git, `iris.yml`,
  `deploy/deploy.sh`) and staging was restored from this repo with the full demo content.
- The client has no server access on his side yet, so staging is the live demo for now.

## Environments
| | branch | URL | where |
|---|---|---|---|
| staging | test | https://bjfc.webpress.solutions | 144.76.56.119 (`bjfc-staging`), `/home/runcloud/webapps/bjfc-sa` |
| production | main | — | none yet (client's own server, once available) |

## Server layout (staging)
- `releases/<sha>`, `current` → active release, `shared/.env` (mode 600), `shared/data/`
  (users.json, config.json — survive deploys; each release links `data` → `shared/data`).
- pm2 process `bjfc-sa` runs `current/server.js` on 127.0.0.1:4310; nginx (RunCloud) proxies the
  domain to it. SSL is issued in the RunCloud panel.
- `shared/.env` holds: ANTHROPIC_API_KEY, SESSION_SECRET, PUBLIC_MODE=1,
  ALLOWED_HOSTS=bjfc.webpress.solutions, SOURCES_ROOT=…/current/demo-data, ADMIN_EMAIL/NAME.
- Demo login password: macOS Keychain, service `bjfc-staging-admin`.

## Decisions
- `data/` is runtime state, not in git. The demo SharePoint site and source list were seeded into
  `shared/data/config.json` from the local copy (paths rewritten to the server).

## Gotchas
- SSH alias `bjfc-staging` uses `~/.ssh/debeer_deploy` (the key runcloud already trusts);
  `id_ed25519` isn't authorised for runcloud yet (D1 says it should be).
- GitHub repo was created through the API; branch protection / environments from
  `infra/terraform` are not set up yet.

## In progress / next
- Add infra/terraform (GitHub branch protection) and authorise `id_ed25519` for runcloud.
- Rotate the Anthropic key that was pasted into a chat session on 2026-10-26 (S6).
