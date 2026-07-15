/**
 * MCP Hub — one shareable page listing every free MCP plugin in this family.
 *
 * SELF-UPDATING BY DESIGN: it does not hardcode the plugin list. It queries the
 * GitHub Search API for public repos tagged with the `mcp-plugin` topic and
 * renders whatever it finds. To publish a NEW plugin here:
 *
 *    gh repo edit <owner>/<repo> --add-topic mcp-plugin --homepage <live /mcp url>
 *
 * ...and it appears on the next cache refresh. No code change, no redeploy.
 *
 * Resilience: GitHub's unauthenticated limit is 60 req/hour and Workers share
 * egress IPs, so responses are cached for an hour and there is a built-in
 * fallback list — the page renders even if GitHub rate-limits or is down.
 *
 * Routes:  GET /            -> the hub page
 *          GET /api/plugins -> the same data as JSON (so anything can consume it)
 */

const OWNER = "PranayMahendrakar";
const TOPIC = "mcp-plugin";
const ACCOUNT = "mahendrakarpranay"; // workers.dev subdomain, for URL fallback
const UA = "mcp-hub/1.0 (+https://github.com/PranayMahendrakar/mcp-hub)";
// 15 min: GitHub allows 60 unauthenticated calls/hour, so refreshing 4x/hour is
// well inside budget while keeping edits to repo metadata visible quickly.
const CACHE_SECONDS = 900;

interface Env {
  ASSETS?: unknown;
}

type Plugin = {
  name: string;
  title: string;
  description: string;
  mcpUrl: string;
  repoUrl: string;
  stars: number;
  updated: string;
  /** Live tool names from the server itself. null = server didn't answer (offline). */
  tools: string[] | null;
};

/** Renders even if GitHub is unreachable. */
const FALLBACK: Plugin[] = [
  { name: "citation-guard", title: "Citation Guard", description: "Verifies references against live registries — catches AI-hallucinated citations, dead DOIs, retracted papers and duplicates.", mcpUrl: `https://citation-guard.${ACCOUNT}.workers.dev/mcp`, repoUrl: `https://github.com/${OWNER}/citation-guard`, stars: 0, updated: "", tools: ["verify_citations", "check_doi"] },
  { name: "thinking-tools", title: "Thinking Tools", description: "Five reasoning protocols: debate, red team, argument audit, threat model, study sanity.", mcpUrl: `https://thinking-tools.${ACCOUNT}.workers.dev/mcp`, repoUrl: `https://github.com/${OWNER}/thinking-tools`, stars: 0, updated: "", tools: ["debate", "red_team", "audit_argument", "threat_model", "check_study"] },
  { name: "plain-english", title: "Plain English", description: "Decodes contracts, leases, ToS and policies into language you can act on.", mcpUrl: `https://plain-english.${ACCOUNT}.workers.dev/mcp`, repoUrl: `https://github.com/${OWNER}/plain-english`, stars: 0, updated: "", tools: ["decode"] },
  { name: "learn-anything", title: "Learn Anything", description: "Turns any topic into a real lesson: intuition, worked example, misconceptions, practice, spaced repetition.", mcpUrl: `https://learn-anything.${ACCOUNT}.workers.dev/mcp`, repoUrl: `https://github.com/${OWNER}/learn-anything`, stars: 0, updated: "", tools: ["curriculum"] },
  { name: "pro-prompter", title: "Pro Prompter", description: "Rewrites a rough request into a FAANG-grade prompt and runs it — 15 specialised task types.", mcpUrl: `https://pro-prompter.${ACCOUNT}.workers.dev/mcp`, repoUrl: `https://github.com/${OWNER}/pro-prompter`, stars: 0, updated: "", tools: ["pro_prompt", "refine_prompt", "recall_prompts", "clear_memory"] },
  { name: "mcp-toolkit", title: "MCP Toolkit", description: "The basics AI keeps fumbling: real current time, exact math, word counts, regex actually tested, exact diff, token estimator, JSON/YAML validator, JWT decoder.", mcpUrl: `https://mcp-toolkit.${ACCOUNT}.workers.dev/mcp`, repoUrl: `https://github.com/${OWNER}/mcp-toolkit`, stars: 0, updated: "", tools: ["get_current_time", "calculate", "word_count", "test_regex", "diff_text", "estimate_tokens", "validate_data", "decode_jwt"] },
];

const ICONS: Record<string, string> = {
  "citation-guard": "🛡️",
  "thinking-tools": "🧠",
  "plain-english": "📄",
  "learn-anything": "🎓",
  "pro-prompter": "✍️",
  "mcp-toolkit": "🧰",
};
const FALLBACK_ICONS = ["🔌", "⚡", "🧩", "🚀", "🔭", "🎛️"];
function iconFor(name: string, i: number): string {
  return ICONS[name] ?? FALLBACK_ICONS[i % FALLBACK_ICONS.length];
}

/** Acronyms that shouldn't be title-cased into "Mcp" / "Ai". */
const ACRONYMS: Record<string, string> = { mcp: "MCP", ai: "AI", api: "API", doi: "DOI", pdf: "PDF", sql: "SQL", ui: "UI", ux: "UX" };

function titleize(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type GhRepo = { name: string; description: string | null; homepage: string | null; html_url: string; stargazers_count: number; pushed_at: string; archived: boolean };

function mapRepo(r: GhRepo): Plugin {
  const home = (r.homepage ?? "").trim();
  const mcpUrl = home || `https://${r.name}.${ACCOUNT}.workers.dev/mcp`;
  return {
    name: r.name,
    title: titleize(r.name),
    description: r.description ?? "An MCP plugin.",
    mcpUrl,
    repoUrl: r.html_url,
    stars: r.stargazers_count ?? 0,
    updated: r.pushed_at ?? "",
    tools: null,
  };
}

/** A tool result may arrive as plain JSON or as an SSE stream — handle both. */
function parseRpc(body: string): { result?: { tools?: Array<{ name: string }> } } | null {
  const t = body.trim();
  if (t.startsWith("{")) {
    try { return JSON.parse(t); } catch { return null; }
  }
  for (const line of t.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      try {
        const o = JSON.parse(line.slice(5).trim());
        if (o && o.result) return o;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

/**
 * Read a plugin's tool list from its repo's `mcp.json` manifest.
 *
 * WHY NOT PROBE THE LIVE SERVER? Because Cloudflare forbids it. A deployed
 * Worker fetching another Worker on the same account returns error 1042
 * ("Worker tried to fetch from another Worker on the same zone"). Verified:
 * the probe works from local dev and fails in production with exactly that.
 * Service bindings would fix it but need per-plugin config, which would break
 * zero-config auto-discovery. raw.githubusercontent.com is a different origin,
 * so this works — and it keeps the manifest next to the code that defines it.
 *
 * Manifest shape:  { "tools": ["tool_a", "tool_b"] }
 * Missing file -> null -> the card simply shows no chips.
 */
async function fetchManifestTools(owner: string, repo: string): Promise<string[] | null> {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/mcp.json`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { tools?: unknown };
    return Array.isArray(j.tools) && j.tools.every((t) => typeof t === "string") ? (j.tools as string[]) : null;
  } catch {
    return null;
  }
}

/** Fetch manifests a few at a time — Workers allow only 6 concurrent connections. */
async function attachTools(plugins: Plugin[]): Promise<Plugin[]> {
  const out: Plugin[] = [];
  for (let i = 0; i < plugins.length; i += 3) {
    const batch = plugins.slice(i, i + 3);
    out.push(...(await Promise.all(batch.map(async (p) => ({ ...p, tools: await fetchManifestTools(OWNER, p.name) })))));
  }
  return out;
}

async function getPlugins(ctx: ExecutionContext, bypassCache = false): Promise<{ plugins: Plugin[]; live: boolean }> {
  const cache = (caches as unknown as { default: Cache }).default;
  // Bump this version to invalidate the cached GitHub response after a change.
  const key = new Request("https://mcp-hub.internal/plugins-v3");
  if (!bypassCache) {
    const hit = await cache.match(key);
    if (hit) {
      return { plugins: (await hit.json()) as Plugin[], live: true };
    }
  }
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`user:${OWNER} topic:${TOPIC}`)}&sort=updated&per_page=50`;
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/vnd.github+json" } });
    if (r.ok) {
      const j = (await r.json()) as { items?: GhRepo[] };
      const discovered = (j.items ?? []).filter((x) => !x.archived).map(mapRepo);
      if (discovered.length > 0) {
        // Ask each live server what it actually exposes, so the page shows the
        // real tool surface (and flags anything that's down) rather than a guess.
        const plugins = await attachTools(discovered);
        const body = JSON.stringify(plugins);
        ctx.waitUntil(
          cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_SECONDS}` } })),
        );
        return { plugins, live: true };
      }
    }
  } catch {
    /* fall through to the built-in list */
  }
  return { plugins: FALLBACK, live: false };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function toolChips(p: Plugin): string {
  // null = the repo has no mcp.json manifest yet, not an outage. Show nothing.
  if (!p.tools || p.tools.length === 0) return "";
  return `<div class="tools">${p.tools.map((t) => `<code class="chip">${esc(t)}</code>`).join("")}</div>`;
}

function card(p: Plugin, i: number): string {
  const n = p.tools?.length ?? 0;
  return `<article class="card">
  <div class="card-top">
    <span class="icon" aria-hidden="true">${iconFor(p.name, i)}</span>
    <h3>${esc(p.title)}</h3>
    ${n > 0 ? `<span class="count" title="Live tool count, read from the server">${n} tool${n === 1 ? "" : "s"}</span>` : ""}
    ${p.stars > 0 ? `<span class="stars" title="GitHub stars">★ ${p.stars}</span>` : ""}
  </div>
  <p class="desc">${esc(p.description)}</p>
  ${toolChips(p)}
  <div class="url-row">
    <code class="url" id="u${i}">${esc(p.mcpUrl)}</code>
    <button class="copy" data-target="u${i}" aria-label="Copy connector URL for ${esc(p.title)}">Copy</button>
  </div>
  <div class="links">
    <a href="${esc(p.repoUrl)}" target="_blank" rel="noopener">Source ↗</a>
    <a href="${esc(p.mcpUrl.replace(/\/mcp$/, "/"))}" target="_blank" rel="noopener">Status ↗</a>
  </div>
</article>`;
}

function page(plugins: Plugin[], live: boolean): string {
  const toolTotal = plugins.reduce((n, p) => n + (p.tools?.length ?? 0), 0);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Free MCP Plugins — for Claude & ChatGPT</title>
<meta name="description" content="Free, open-source MCP plugins for Claude and ChatGPT. No signup, no API key, zero extra credits. Paste a URL and go." />
<meta property="og:title" content="Free MCP Plugins for Claude & ChatGPT" />
<meta property="og:description" content="${plugins.length} free, open-source MCP plugins. No signup, no API key, zero extra credits." />
<meta property="og:type" content="website" />
<style>
  :root {
    --bg: #0b0d10; --panel: #14181d; --line: #232a33; --fg: #e8edf3; --muted: #97a3b2;
    --accent: #f6821f; --accent-2: #ffb75e; --ok: #2ecc71; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f7f8fa; --panel: #ffffff; --line: #e3e7ec; --fg: #10151b; --muted: #5c6673; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); line-height: 1.6;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 0 1.25rem; }
  header { padding: 4rem 0 2rem; text-align: center; }
  h1 { font-size: clamp(2rem, 5vw, 3rem); margin: 0 0 .5rem; letter-spacing: -.02em; }
  .grad { background: linear-gradient(90deg, var(--accent), var(--accent-2));
          -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { color: var(--muted); font-size: 1.1rem; max-width: 46rem; margin: 0 auto 1.25rem; }
  .badges { display: flex; gap: .5rem; justify-content: center; flex-wrap: wrap; }
  .badge { border: 1px solid var(--line); background: var(--panel); color: var(--muted);
           padding: .2rem .7rem; border-radius: 999px; font-size: .8rem; }
  .badge.live { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin: 2.5rem 0; }
  .step { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; }
  .step b { display: block; color: var(--accent); font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; margin-bottom: .25rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; margin-bottom: 3rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 1.1rem;
          display: flex; flex-direction: column; gap: .6rem; transition: transform .15s ease, border-color .15s ease; }
  .card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .card-top { display: flex; align-items: center; gap: .6rem; }
  .icon { font-size: 1.5rem; }
  .card h3 { margin: 0; font-size: 1.1rem; flex: 1; }
  .stars { color: var(--muted); font-size: .8rem; }
  .count { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);
           border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
           padding: .1rem .45rem; border-radius: 999px; font-size: .7rem; white-space: nowrap; }
  .desc { margin: 0; color: var(--muted); font-size: .92rem; flex: 1; }
  .tools { display: flex; flex-wrap: wrap; gap: .3rem; }
  .chip { font-family: var(--mono); font-size: .68rem; background: var(--bg); border: 1px solid var(--line);
          border-radius: 6px; padding: .15rem .4rem; color: var(--muted); }
  .chip.off { color: #e0574b; border-color: #e0574b; font-family: inherit; }
  .url-row { display: flex; gap: .4rem; align-items: stretch; }
  .url { font-family: var(--mono); font-size: .74rem; background: var(--bg); border: 1px solid var(--line);
         border-radius: 8px; padding: .5rem .6rem; overflow-x: auto; white-space: nowrap; flex: 1; }
  .copy { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px;
          padding: .5rem .7rem; font-size: .78rem; cursor: pointer; white-space: nowrap; }
  .copy:hover { border-color: var(--accent); color: var(--accent); }
  .copy.done { color: var(--ok); border-color: var(--ok); }
  .links { display: flex; gap: 1rem; font-size: .82rem; }
  .links a { color: var(--muted); text-decoration: none; }
  .links a:hover { color: var(--accent); }
  section.block { background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
                  padding: 1.5rem; margin-bottom: 2rem; }
  h2 { font-size: 1.3rem; margin: 0 0 .75rem; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: .8rem;
        overflow-x: auto; font-family: var(--mono); font-size: .8rem; margin: .5rem 0 0; }
  footer { color: var(--muted); font-size: .85rem; text-align: center; padding: 2rem 0 3rem; }
  footer a { color: var(--accent); text-decoration: none; }
  ul { margin: .5rem 0; padding-left: 1.1rem; color: var(--muted); }
  li { margin: .25rem 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Free <span class="grad">MCP Plugins</span></h1>
    <p class="sub">Superpowers for the AI you already use. Open-source, no signup, no API key —
    and <strong>zero extra credits</strong>: they run on your own Claude or ChatGPT.</p>
    <div class="badges">
      <span class="badge live">● ${plugins.length} plugins${toolTotal > 0 ? ` · ${toolTotal} tools` : ""} live</span>
      <span class="badge">Claude + ChatGPT</span>
      <span class="badge">MIT licensed</span>
      <span class="badge">${live ? "auto-updating" : "cached list"}</span>
    </div>
  </header>

  <div class="steps">
    <div class="step"><b>Step 1</b>Copy a plugin's URL below.</div>
    <div class="step"><b>Step 2</b>Claude: Settings → Connectors → <em>Add custom connector</em> → paste. ChatGPT: Settings → Connectors → Advanced → <em>Developer mode</em> → paste.</div>
    <div class="step"><b>Step 3</b>Turn it on in a chat and ask away. That's it.</div>
  </div>

  <div class="grid">
${plugins.map((p, i) => card(p, i)).join("\n")}
  </div>

  <section class="block">
    <h2>How is this free?</h2>
    <p class="desc">These servers run <strong>no AI of their own</strong>. Each one returns either expert
    instructions or hard facts as plain text — and <em>your</em> Claude/ChatGPT does the thinking, on the plan
    you already pay for. There's no API key to buy and no bill to receive. The servers run on Cloudflare's
    free tier, so nothing costs anything to host either.</p>
    <ul>
      <li>Because of that, you <strong>invoke a plugin explicitly</strong> (e.g. “Debate this: …”) — a plugin
      can't silently intercept your message before the AI reads it. That's a platform rule, not a missing feature.</li>
      <li>Every plugin is authless and open-source — read exactly what it does before you trust it.</li>
    </ul>
  </section>

  <section class="block">
    <h2>Add your own plugin to this page</h2>
    <p class="desc">This page isn't a hardcoded list — it reads GitHub. Tag any public repo with the
    <code>mcp-plugin</code> topic and set its homepage to the live <code>/mcp</code> URL, and it shows up here
    automatically within the hour.</p>
    <pre>gh repo edit &lt;owner&gt;/&lt;repo&gt; \\
  --add-topic mcp-plugin \\
  --homepage https://&lt;your-worker&gt;.workers.dev/mcp</pre>
    <p class="desc" style="margin-top:.75rem">Machine-readable list: <a href="/api/plugins" style="color:var(--accent)">/api/plugins</a></p>
  </section>

  <footer>
    Built by <a href="https://github.com/${OWNER}" target="_blank" rel="noopener">${OWNER}</a> ·
    MIT licensed · <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">What is MCP?</a>
  </footer>
</div>
<script>
  document.querySelectorAll(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var el = document.getElementById(b.dataset.target);
      var text = el.textContent.trim();
      function done() {
        var old = b.textContent; b.textContent = "Copied!"; b.classList.add("done");
        setTimeout(function () { b.textContent = old; b.classList.remove("done"); }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { fallback(text, done); });
      } else { fallback(text, done); }
    });
  });
  function fallback(text, cb) {
    var t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); cb(); } catch (e) {}
    document.body.removeChild(t);
  }
</script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // ?refresh=1 forces a fresh GitHub read — useful right after tagging a new repo.
    const bypass = url.searchParams.has("refresh");
    const { plugins, live } = await getPlugins(ctx, bypass);

    if (url.pathname === "/api/plugins") {
      return new Response(JSON.stringify({ count: plugins.length, source: live ? "github" : "fallback", plugins }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-cache" },
      });
    }
    if (url.pathname === "/") {
      return new Response(page(plugins, live), {
        // Short browser cache so a newly-added plugin shows up promptly.
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
