# MCP Hub 🔌

**One shareable page listing every free MCP plugin.** → **https://mcp-hub.mahendrakarpranay.workers.dev**

It's **self-updating**: it doesn't hardcode a list — it reads GitHub. Tag a repo with the `mcp-plugin`
topic and it appears here automatically.

## Add your plugin to the hub

**1. Tag the repo:**
```bash
gh repo edit <owner>/<repo> \
  --add-topic mcp-plugin \
  --homepage https://<your-worker>.workers.dev/mcp
```

**2. Add an `mcp.json` at the repo root** so your tools show as chips:
```json
{
  "name": "your-plugin",
  "mcpUrl": "https://your-plugin.<account>.workers.dev/mcp",
  "tools": ["tool_a", "tool_b"]
}
```

That's the whole integration. Within ~15 minutes it appears — no code change, no redeploy.
(`mcp.json` is optional; without it the card renders fine, just without tool chips.)

- **Name** ← repo name (acronyms like MCP/AI/API are cased correctly)
- **Description** ← the repo's GitHub description
- **Connector URL** ← the repo's `homepage` field (falls back to `https://<repo>.<account>.workers.dev/mcp`)
- **Tools** ← the repo's `mcp.json`
- **Stars** ← live from GitHub

> ⚠️ Write `mcp.json` as **UTF-8 without a BOM**. `JSON.parse` rejects a leading BOM — PowerShell's
> `Set-Content -Encoding utf8` adds one. (The hub strips BOMs defensively, but other tools won't.)

## Why tools come from `mcp.json` and not a live probe

The obvious design is to ask each server `tools/list` directly. **Cloudflare forbids it:** a deployed
Worker fetching another Worker on the same account fails with **error 1042** ("Worker tried to fetch from
another Worker on the same zone"). It works from `wrangler dev` and fails in production — a trap worth
knowing. Service bindings would fix it but need per-plugin config, which would kill zero-config
auto-discovery. `raw.githubusercontent.com` is a different origin, so reading the manifest works — and it
keeps the tool list next to the code that defines it.

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
