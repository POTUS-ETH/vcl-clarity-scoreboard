# Cloudflare Worker for VCL Clarity V2 Scoreboard

Queries Notion directly on every widget load. No commit lag, no GitHub Actions wait — target latency ~500 ms per widget refresh.

## One-time setup

1. **Install wrangler CLI:**
   ```bash
   npm install -g wrangler
   ```

2. **Log in to Cloudflare** (opens browser — sign up free if needed):
   ```bash
   wrangler login
   ```

3. **From this `worker/` folder, set the Notion token as a Worker secret:**
   ```bash
   cd ~/Documents/Paladin/Paladin/Obsidian/PaladinV0/scoreboard/worker
   wrangler secret put NOTION_TOKEN
   ```
   Paste your Notion integration token when prompted (same one used by GitHub Actions — grab from https://www.notion.so/my-integrations).

4. **Deploy:**
   ```bash
   wrangler deploy
   ```
   You'll get back a URL like `https://vcl-clarity-scoreboard.YOUR-SUBDOMAIN.workers.dev`. Copy it.

5. **Point the widget at the Worker.** Edit `../v2/index.html`, find the `poll()` function, replace `./data.json?t=${Date.now()}` with your Worker URL from step 4. Commit + push.

## How it works

- Widget fetches from Worker URL every 5 seconds
- Worker queries Notion API in real-time and returns computed scoreboard JSON
- No commits, no Actions, no data.json file needed
- Response time: ~300–800 ms (Notion API is the bottleneck)

## Updating the Worker

Edit `index.js`, then re-run `wrangler deploy`. No versioning ceremony needed.
