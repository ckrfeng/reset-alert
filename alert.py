"""
Tibo Reset Tracker - pings a Discord channel when @thsottiaux posts about a reset.

Setup:
  pip install discord.py feedparser
  Set these environment variables (or paste values in below):
    DISCORD_TOKEN  - your bot token from the Discord Developer Portal
    CHANNEL_ID     - the channel to post in (Developer Mode -> right-click channel -> Copy ID)
    RSS_URL        - an RSS feed of https://x.com/thsottiaux (e.g. from RSS.app)
  Run: python bot.py
"""

import asyncio
import html
import os
import re

import discord
import feedparser
from discord.ext import tasks

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "PASTE_TOKEN_HERE")
CHANNEL_ID = int(os.environ.get("CHANNEL_ID", "123456789012345678"))
RSS_URL = os.environ.get("RSS_URL", "PASTE_RSS_FEED_URL_HERE")
CHECK_MINUTES = float(os.environ.get("CHECK_MINUTES", "3"))

# What counts as a "reset" post. Matches reset, resets, resetting, banked, etc.
# Add phrases here if Tibo words announcements differently.
KEYWORDS = re.compile(r"\b(reset\w*|banked)\b", re.IGNORECASE)

client = discord.Client(
    intents=discord.Intents.default(),  # no Message Content Intent needed; the bot only sends
    allowed_mentions=discord.AllowedMentions(everyone=True),
)

seen_ids: set[str] = set()
primed = False


def entry_id(entry) -> str:
    return entry.get("id") or entry.get("link") or entry.get("title", "")


def entry_text(entry) -> str:
    raw = f"{entry.get('title', '')} {entry.get('summary', '')}"
    return html.unescape(re.sub(r"<[^>]+>", " ", raw))  # strip HTML tags


@tasks.loop(minutes=CHECK_MINUTES)
async def check_feed():
    global primed

    # feedparser is blocking, so run it off the event loop
    feed = await asyncio.to_thread(feedparser.parse, RSS_URL)
    if not feed.entries:
        print(f"Feed returned nothing (error: {getattr(feed, 'bozo_exception', 'none')})")
        return

    new_entries = [e for e in feed.entries if entry_id(e) not in seen_ids]
    for e in new_entries:
        seen_ids.add(entry_id(e))

    # First check after startup: remember existing posts but don't ping for them
    if not primed:
        primed = True
        print(f"Primed with {len(new_entries)} existing posts; watching for new ones.")
        return

    if not new_entries:
        return

    channel = client.get_channel(CHANNEL_ID) or await client.fetch_channel(CHANNEL_ID)

    # Feeds list newest first; announce oldest first so order is natural
    for entry in reversed(new_entries):
        if KEYWORDS.search(entry_text(entry)):
            link = entry.get("link", "")
            # Point links at x.com even if the feed uses a mirror domain
            link = re.sub(r"https?://[^/]+/", "https://x.com/", link, count=1)
            await channel.send(f"@everyone 🚨 Tibo just posted about a reset!\n{link}")
            print(f"Pinged for: {link}")


@check_feed.before_loop
async def before_check():
    await client.wait_until_ready()


@check_feed.error
async def on_check_error(error):
    print(f"Check failed: {error!r}")  # loop keeps running on the next tick


@client.event
async def on_ready():
    print(f"Logged in as {client.user}")
    if not check_feed.is_running():  # on_ready can fire again after reconnects
        check_feed.start()


client.run(DISCORD_TOKEN)
