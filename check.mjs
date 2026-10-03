#!/usr/bin/env node
// ai-visibility-check: compare what an AI crawler sees (raw HTML, no JavaScript)
// with what a person sees (fully rendered page), then generate a fix.
//
// Usage: node check.mjs <url> [--out <dir>]

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "CCBot"];

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : "report";
if (!url) {
  console.error("Usage: node check.mjs <url> [--out <dir>]");
  process.exit(1);
}

// Same extraction for both views, so the comparison is apples to apples.
const extract = () => ({
  title: document.title,
  description: document.querySelector('meta[name="description"]')?.content || "",
  text: document.body?.innerText || "",
  // Everything in the HTML, visible or not: a crawler reads the source, not the screen.
  source: [...(document.body?.querySelectorAll("*") || [])]
    .filter((el) => !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName))
    .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent))
    .join(" "),
  links: [...document.querySelectorAll("a[href]")]
    .map((a) => ({ text: a.innerText.trim().replace(/\s+/g, " "), href: a.href }))
    .filter((l) => l.text && l.href.startsWith("http")),
});

async function view(browser, javaScriptEnabled) {
  const ctx = await browser.newContext({ javaScriptEnabled });
  // Optional: fetch every request through Node instead of Chromium, for networks with a
  // TLS-intercepting proxy whose CA Chromium doesn't trust (Node uses NODE_EXTRA_CA_CERTS).
  if (process.env.ROUTE_VIA_NODE) {
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      try {
        const res = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined, redirect: "manual" });
        await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
      } catch {
        await route.abort();
      }
    });
  }
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: javaScriptEnabled ? "networkidle" : "domcontentloaded", timeout: 45000 });
  const html = javaScriptEnabled ? null : await res.text();
  const data = await page.evaluate(extract);
  await ctx.close();
  return { ...data, html };
}

const lines = (t) => [...new Set(t.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => l.length > 2))];
const words = (t) => (t.match(/\S+/g) || []).length;

function detectStack(html) {
  if (/__NEXT_DATA__|\/_next\//.test(html)) return { name: "Next.js", fix: "Render these pages on the server: move data fetching into Server Components / getStaticProps, and avoid 'use client' wrappers around the whole page." };
  if (/astro-island|data-astro|\/_astro\//.test(html)) return { name: "Astro", fix: "Astro ships HTML by default. Check components marked client:only, which render nothing until JavaScript runs." };
  if (/__NUXT__|\/_nuxt\//.test(html)) return { name: "Nuxt", fix: "Make sure ssr: true (the default) is on, and fetch content with useAsyncData so it ships in the HTML." };
  if (/data-wf-(site|page)/.test(html)) return { name: "Webflow", fix: "Webflow ships HTML already. Check for content loaded by custom embeds or third-party widgets." };
  if (/wp-content|wp-includes/.test(html)) return { name: "WordPress", fix: "WordPress ships HTML already. Check page-builder blocks or plugins that load content with JavaScript." };
  if (/<div id="(root|app)">\s*<\/div>/.test(html)) return { name: "Client-side single-page app (React/Vue/Vite)", fix: "The page is an empty shell until JavaScript runs. Add pre-rendering at build time (e.g. vite-plugin-prerender / react-snap), or move to a framework with server rendering (Next.js, Astro, Remix)." };
  return { name: "Unknown", fix: "Look at which sections are missing below and check how each one is loaded." };
}

// Parse robots.txt into groups of { agents, rules } as the spec (RFC 9309) defines them.
function parseRobots(txt) {
  const groups = [];
  let group = null;
  for (const raw of txt.split("\n")) {
    const line = raw.split("#")[0].trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) groups.push((group = { agents: [], rules: [] }));
      group.agents.push(val.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group) {
      group.rules.push({ allow: key === "allow", path: val });
    }
  }
  return groups;
}

// Does this path match a robots.txt rule path? Supports * and a trailing $.
const ruleMatches = (rule, path) =>
  new RegExp("^" + rule.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")).test(path);

// RFC 9309: a bot follows the group that names it, otherwise the "*" group.
// The longest matching rule wins; on a tie, allow wins. An empty Disallow allows everything.
function isBlocked(groups, bot, path) {
  const named = groups.filter((g) => g.agents.includes(bot.toLowerCase()));
  const applies = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  const rules = applies.flatMap((g) => g.rules).filter((r) => r.path && ruleMatches(r.path, path));
  if (!rules.length) return { blocked: false };
  rules.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return { blocked: !rules[0].allow, via: named.length ? bot : "*" };
}

async function robotsCheck() {
  try {
    const res = await fetch(new URL("/robots.txt", url));
    const type = res.headers.get("content-type") || "";
    // Single-page apps often answer every path with index.html; that isn't a robots.txt.
    if (!res.ok || type.includes("text/html")) return { found: false, blocked: [] };
    const groups = parseRobots(await res.text());
    const path = new URL(url).pathname;
    const blocked = AI_BOTS.map((bot) => ({ bot, ...isBlocked(groups, bot, path) })).filter((r) => r.blocked);
    return { found: true, blocked };
  } catch {
    return { found: false, blocked: [] };
  }
}

function toMarkdown(r) {
  const body = lines(r.text).join("\n\n");
  const seen = new Set();
  const links = r.links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 40);
  return [
    `# ${r.title || url}`,
    "",
    r.description ? `> ${r.description}` : `> Text version of ${url} for AI tools.`,
    "",
    `Source: ${url}`,
    "",
    "## Page content",
    "",
    body,
    "",
    "## Links",
    "",
    ...links.map((l) => `- [${l.text}](${l.href})`),
    "",
  ].join("\n");
}

const browser = await chromium.launch();
const [crawler, human] = [await view(browser, false), await view(browser, true)];
await browser.close();

// A line counts as visible to AI if its text appears anywhere in the raw HTML.
const norm = (t) => t.replace(/\s+/g, " ").toLowerCase();
const crawlerSource = norm(crawler.source);
const humanLines = lines(human.text);
const missing = humanLines.filter((l) => !crawlerSource.includes(norm(l)));
const missingWords = words(missing.join(" "));
const coverage = words(human.text) ? Math.round(((words(human.text) - missingWords) / words(human.text)) * 100) : 100;
const stack = detectStack(crawler.html || "");
const robots = await robotsCheck();
// llms.txt is meant to be one site-wide index. A single page's text copy goes at the
// page's own URL + ".md" (the llms.txt proposal's convention), so pages never clash.
const pagePath = new URL(url).pathname;
const mdPath = (pagePath.endsWith("/") ? pagePath + "index.html" : pagePath) + ".md";
const linkTag = `<link rel="alternate" type="text/markdown" href="${mdPath}" title="Text version for AI tools">`;

const verdict = coverage >= 90 ? "Good: AI crawlers can read almost all of this page." : coverage >= 50 ? "Partial: AI crawlers miss a real chunk of this page." : "Poor: to an AI crawler this page is mostly empty.";

const report = `# AI visibility report

**URL:** ${url}
**Checked:** ${new Date().toISOString()}

## Result: ${coverage}% visible to AI crawlers

${verdict}

| | Words | Title | Meta description |
|---|---|---|---|
| AI crawler (no JavaScript) | ${words(crawler.source)} | ${crawler.title ? "yes" : "**missing**"} | ${crawler.description ? "yes" : "**missing**"} |
| Person (full browser) | ${words(human.text)} | ${human.title ? "yes" : "missing"} | ${human.description ? "yes" : "missing"} |

## Why
Detected stack: **${stack.name}**
${stack.fix}

## AI bots blocked from this page in robots.txt
${!robots.found ? "No robots.txt found." : robots.blocked.length ? robots.blocked.map((b) => `- ${b.bot}${b.via === "*" ? " (blocked by the rule for all bots, User-agent: *)" : ""}`).join("\n") : "None of the major AI bots are blocked."}

## What AI crawlers can't see (${missing.length} ${missing.length === 1 ? "line" : "lines"})
${missing.length ? missing.slice(0, 30).map((l) => `- ${l.slice(0, 140)}`).join("\n") + (missing.length > 30 ? `\n- ...and ${missing.length - 30} more` : "") : "Nothing. Every line a person sees is in the raw HTML."}

## The fix
1. **Real fix:** ${stack.fix}
2. **Quick fix:** upload the generated \`page.md\` to your site at \`${mdPath}\`, and list it in your site's \`/llms.txt\` index.
3. **Point to it:** paste this in your page's \`<head>\`. It sits in the raw HTML, so crawlers that skip JavaScript still see it:

\`\`\`html
${linkTag}
\`\`\`

Note: no AI company has confirmed its crawler reads llms.txt or .md copies of pages. The real fix (1) is the only guaranteed one.
`;

await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/report.md`, report);
await writeFile(`${outDir}/page.md`, toMarkdown(human));
console.log(`${coverage}% visible to AI crawlers (${words(human.text) - missingWords} of ${words(human.text)} words). Stack: ${stack.name}. Missing lines: ${missing.length}.`);
console.log(`Wrote ${outDir}/report.md and ${outDir}/page.md`);
