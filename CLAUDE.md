# bjfc

BJFC Command Centre — AI assistant, document finder and system monitor. A client demo for
BJ-FC Consulting Engineers; see README.md for what is demo vs real.

## Iris rules
This project follows the Jarrah Labs standards: `/Volumes/MacD/iris/standards/STANDARDS.md`.
Read them, plus `iris.yml` and `docs/HANDOFF.md`, before your first change, and tell Steven
which rules apply to the task. Every commit is reviewed by Iris in the pre-commit hook.

- Work on `feat/<name>` → merge to `test` (staging) → merge to `main` (production).
- Deploy only with `deploy/deploy.sh staging|production` — never from the working tree.
- Secrets: `.env` (gitignored, keys listed in `.env.example`); passwords in the macOS Keychain.
- Update `docs/HANDOFF.md` before ending a session that changed something.

## Project
- Stack: Node 20+ (plain `http` server, no build step), `@anthropic-ai/sdk`
- Hosting target: ubuntu-vps (see `iris.yml`) — staging on the shared RunCloud box, webapp `bjfc-sa`
- Run locally: `npm install && npm start` → http://localhost:4310

## Exceptions
- none
