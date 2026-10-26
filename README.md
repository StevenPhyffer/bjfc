# BJFC Command Centre (demo)

A private dashboard for the owner of BJ-FC Consulting Engineers. It runs on the office computer and includes:

- **AI Assistant (Claude Opus 5.5):** chat that searches every file on the office PC, the file server and connected SharePoint sites. It can pull up quotes and invoices, summarise documents and give business and IT advice.
- **Quotes & Invoices:** fields such as client, amount, status and days overdue are pulled from the files automatically.
- **System monitor:** live CPU, memory, disks, services and backups, with alerts.
- **Data sources:** choose which folders and SharePoint sites the AI can see, with an on/off switch for each.
- **Light and dark mode:** follows the system setting, or set it by hand with the toggle.

## Run it
```bash
npm install
npm start            # → http://localhost:4310
```
On macOS you can also double-click `start.command`.

The API key is read from `.env` (`ANTHROPIC_API_KEY=...`) or can be set under **Settings**. Without a key, the assistant runs in **offline demo mode**. That mode uses keyword rules over the same real index.

## What's demo vs real
| Area | Demo state | For production |
|---|---|---|
| Files | Fictional sample business in `demo-data/` (`npm run seed -- --force` to regenerate) | Add real folders / mounted server shares under Data sources |
| Text extraction | .txt .md .csv .json .xml .html | Add PDF, Word and Excel parsing (e.g. `pdf-parse`, `mammoth`, `xlsx`) |
| This computer | **Real** live metrics | — |
| BJFC-SRV01 / NAS | **Simulated** | Small agent, SNMP or WMI on the real machines |
| SharePoint | "Demo mode" sample libraries; real Microsoft Graph code included (`lib/sharepoint.js`) | Entra ID app with `Sites.Read.All` / `Sites.Selected` |
| AI | **Real** Claude agent with read-only tools | — |

## Layout
```
server.js              local web server (127.0.0.1 only) + API
lib/agent.js           Claude tool-use loop (streaming, adaptive thinking, refusal fallback)
lib/tools.js           tools the agent can call (search, list, read, financials, system, SharePoint)
lib/demoAgent.js       offline fallback agent
lib/indexer.js         folder walker, classifier, field extraction, search
lib/monitor.js         system metrics + alerts
lib/sharepoint.js      Microsoft Graph connector
public/                dashboard UI (no build step)
scripts/seed-demo-data.js
```

## Security notes
- The server binds to localhost only and rejects other Host headers.
- The agent's tools are read-only. Files are never modified, moved or deleted.
- The API key and SharePoint secrets stay on this machine (`.env`, `data/config.json`). Neither is sent to the browser.
