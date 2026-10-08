// Tibo Reset Tracker - Cloudflare Worker version
// Runs on a Cron Trigger, reads the RSS feed, and posts to Discord via a webhook.
//
// Needs (set in the Worker's Settings in the Cloudflare dashboard):
//   WEBHOOK_URL  (Secret)        - Discord channel webhook URL
//   RSS_URL      (Text variable) - your RSS.app feed URL
//   SEEN         (KV binding)    - a KV namespace used to remember which posts were already seen
// And a Cron Trigger, e.g.  */3 * * * *   (every 3 minutes)

// What counts as a "reset" post. Matches reset, resets, resetting, banked, etc.
const KEYWORDS = /\b(reset\w*|banked)\b/i;
const MAX_REMEMBERED = 200;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkFeed(env));
  },

  // Visiting the Worker's URL runs a check too, handy for testing. It never pings twice for the same post.
  async fetch(request, env) {
    const result = await checkFeed(env);
    return new Response(result + "\n", { headers: { "content-type": "text/plain" } });
  },
};

async function checkFeed(env) {
  const res = await fetch(env.RSS_URL, { headers: { "user-agent": "tibo-reset-tracker" } });
  if (!res.ok) {
    console.log(`Feed fetch failed: ${res.status}`);
    return `Feed fetch failed: ${res.status}`;
  }
  const items = parseItems(await res.text());
  if (items.length === 0) return "Feed had no posts.";

  const stored = await env.SEEN.get("seen");
  const seen = new Set(stored ? JSON.parse(stored) : []);
  const newItems = items.filter((item) => !seen.has(item.id));

  // First run: remember everything already in the feed, don't ping for old posts.
  // Send first, save second: if Discord fails, nothing is saved and the next run tries again.
  if (!stored) {
    await sendToDiscord(env, `✅ Reset tracker is live. Watching @thsottiaux (${items.length} existing posts skipped).`, false);
    await save(env, items.map((i) => i.id));
    return `Primed with ${items.length} existing posts.`;
  }

  if (newItems.length === 0) return "No new posts.";

  // Feed is newest first; announce oldest first
  let pinged = 0;
  for (const item of [...newItems].reverse()) {
    if (KEYWORDS.test(item.title)) {
      const link = item.link.replace(/^https?:\/\/[^/]+\//, "https://x.com/");
      await sendToDiscord(env, `@everyone 🚨 Tibo just posted about a reset!\n${link}`, true);
      pinged++;
    }
  }

  // Remember new IDs first, then the older ones, capped so storage stays small
  await save(env, [...newItems.map((i) => i.id), ...seen]);
  return `${newItems.length} new post(s), ${pinged} ping(s) sent.`;
}

async function save(env, ids) {
  await env.SEEN.put("seen", JSON.stringify(ids.slice(0, MAX_REMEMBERED)));
}

async function sendToDiscord(env, content, pingEveryone) {
  const res = await fetch(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: pingEveryone ? ["everyone"] : [] },
    }),
  });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
}

function parseItems(xml) {
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return "";
      return decode(m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim());
    };
    const link = get("link");
    items.push({ id: get("guid") || link, title: get("title"), link });
  }
  return items;
}

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
