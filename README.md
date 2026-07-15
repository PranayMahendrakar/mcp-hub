# MCP Hub 🔌

**One shareable page listing every free MCP plugin.** → **https://mcp-hub.mahendrakarpranay.workers.dev**

It's **self-updating**: it doesn't hardcode a list — it reads GitHub. Tag a repo with the `mcp-plugin`
topic and it appears here automatically.

## Add your plugin to the hub

```bash
gh repo edit <owner>/<repo> \
  --add-topic mcp-plugin \
  --homepage https://<your-worker>.workers.dev/mcp
```

That's the whole integration. Within the hour it shows up on the page — no code change, no redeploy.

- **Name** ← repo name (acronyms like MCP/AI/API are cased correctly)
- **Description** ← the repo's GitHub description
- **Connector URL** ← the repo's `homepage` field (falls back to `https://<repo>.<account>.workers.dev/mcp`)
- **Stars** ← live from GitHub

## Routes

| Route | What |
|-------|------|
| `/` | The hub page — cards with one-click copy for each connector URL |
| `/api/plugins` | The same data as JSON (CORS-open), so anything can consume it |

## How it stays reliable

GitHub's unauthenticated API allows 60 requests/hour, and Cloudflare Workers share egress IPs — so a naive
implementation would rate-limit itself into a broken page. Two defences:

1. **Cache the GitHub response for an hour** via the Workers Cache API.
2. **A built-in fallback list** — if GitHub is rate-limited or down, the page still renders every plugin.
   The `source` field in `/api/plugins` tells you which path served it (`github` or `fallback`).

Bump the cache key (`plugins-vN` in `src/index.ts`) to force an immediate refresh after changing repo metadata.

## Deploy your own

```powershell
npm install
npx wrangler deploy
```

Change `OWNER`, `TOPIC` and `ACCOUNT` at the top of [`src/index.ts`](src/index.ts) to point it at your own
GitHub account and workers.dev subdomain.

## License
MIT © 2026 Pranay Mahendrakar
