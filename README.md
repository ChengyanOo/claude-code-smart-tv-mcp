# smart-tv-mcp

Minimal MCP server that turns Claude Code into a smart-TV agent for YouTube: personalized recommendations that deliberately avoid an echo chamber, plus on-demand research ("show me Bloomberg's take on the rate cut"). Links only, no playback.

- **Backend**: [youtubei.js](https://github.com/LuanRT/YouTube.js) (YouTube's internal API). No API key, no quota.
- **Personalization**: your YouTube account (home / subscriptions / history via cookie) + a tiny local profile (`~/.config/tv-agent/profile.json`) that learns from feedback and from what you ask for.
- **Explainable picks**: every item comes with `why` tags (`subscribed`, `liked_channel:2`, `history:3`, `interest:blues`, `watched`, `new_channel`…) computed server-side from your subscriptions, last 40 watched, feedback and interests, so each recommendation carries a concrete one-line reason instead of "popular".
- **One JSON object per reply**: a TV app parses the agent, so every reply is a single JSON object (`items[]` with `title`, `channel`, `duration`, `url`, `thumbnail`, `reason`, `kind`…, see [Reply contract](#reply-contract)). The server builds it from the served ids (`profile_update` → `reply`) and a Claude Code Stop hook rejects anything else.
- **Anti echo-chamber**: the server tracks what share of served picks were non-personal and tells the agent when exploration is due. Explore picks come from an anonymous session, never from your subscriptions.
- **Research**: YouTube side via `yt_channel` (in-channel search) + `yt_video` (transcripts). Web side uses Claude Code's built-in search/fetch, so nothing is duplicated here.
- ~450 lines TypeScript, 6 tools, compact JSON tool output (no thumbnails; the final reply derives one from the id) to keep token use low.

## Setup

```bash
npm install
npm run build
```

### Sign in (optional, needed for home / subscriptions / history)

**Automatic (recommended).** `scripts/start.sh` pulls the YouTube cookies out of a browser you are already logged into, writes them to `~/.config/tv-agent/cookie.txt` (mode 600), then starts the server. Nothing to copy by hand, and the cookie is refreshed every time the server starts.

1. Install yt-dlp (its browser cookie extractors do the work; Firefox is plain sqlite, Chrome/Brave/Chromium are decrypted via the GNOME keyring through `python3-secretstorage`):
   ```bash
   curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp
   ```
2. In `.mcp.json` point `command` at `scripts/start.sh` and set `YT_BROWSER` to the browser(s) to try, in order. Profiles use yt-dlp syntax:
   `"YT_BROWSER": "firefox,chrome"` or `"YT_BROWSER": "chrome:Profile 2"` (comma separated; `python3 scripts/yt-cookie.py --list` shows profiles with account names).
3. Make sure that browser profile is logged into the YouTube account you actually watch with. A fresh/empty account gives empty feeds.

The server also re-extracts the cookie by itself, once, when YouTube rejects the current one (expired / rotated), so a working browser login is all you need to maintain. The refresh is skipped while `cookie.txt` is younger than `YT_COOKIE_MAX_AGE_H` (12h); `--force` overrides.

Run `/usr/bin/python3 scripts/yt-cookie.py --list` to see browser profiles with the account signed into each, then `YT_BROWSER="chrome:Profile 2" /usr/bin/python3 scripts/yt-cookie.py` to test: it prints which browser worked and how many cookies it found, never the values. Use the system python (a virtualenv usually lacks `secretstorage`, so Chrome cookies fail to decrypt). `YT_COOKIE_AUTO=0` disables the refresh. If the refresh fails the server still starts with the previous `cookie.txt`.

Caveat: YouTube occasionally rotates session cookies when two clients share them. If feeds start erroring, reload youtube.com in the browser and restart the server; the refresh picks up the new cookie.

**Manual fallback.**

1. Open youtube.com in an **incognito** window, log in.
2. DevTools → Network → click any request to `www.youtube.com` → Request Headers → copy the full `Cookie` value (1–3 KB, contains `SID=`, `SAPISID=`, …).
3. Either paste it into `.mcp.json` → `env.YT_COOKIE` (then add `.mcp.json` to `.gitignore`), or save it to `~/.config/tv-agent/cookie.txt` (`chmod 600`).
4. Close the incognito window **without logging out** (logging out invalidates the cookie).

`cookie.txt` wins over `YT_COOKIE` when both exist (the file is the auto-refreshed one). Without a cookie, `yt_feed home|subscriptions|history` return a clear error. Everything else works.

### Register with Claude Code

The repo ships `.mcp.json`, so running `claude` inside this directory loads the server automatically. To use it from anywhere:

```bash
claude mcp add --scope user tv -e YT_BROWSER="chrome" -- /absolute/path/to/scripts/start.sh
```

`CLAUDE.md` holds the agent policy (JSON reply contract, recommend flow, explore rule, research flow). The same policy is embedded in the server's MCP `instructions`, so other MCP clients get it too.

`.claude/settings.json` adds a Stop hook (`scripts/reply-json-hook.mjs`): on any turn that called a `tv` tool, a reply that is not one JSON object in the contract below is rejected once with the reason, so Claude rewrites it before the TV sees it. Turns without `tv` calls (development work in this repo) are left alone, and the hook fails open if it cannot read the transcript.

## Tools

| Tool | Purpose |
|---|---|
| `yt_search` | Search with filters (`upload_date`, `type`, `duration`, `prioritize=popularity`) |
| `yt_feed` | `home` (with optional filter chip), `subscriptions`, `history`, `explore` (non-personal: "New to you" chip + popularity search outside the profile, subscribed channels removed) |
| `yt_channel` | Channel by `@handle`/URL/name/id; latest uploads or in-channel `query` |
| `yt_video` | Details + `description` / `related` / `transcript` |
| `profile_get` | Profile + `taste` (liked/disliked channels), `recent_asks`, `last_served` (with the reasons shown), `explore_due`, `recently_served_ids`, `disliked_ids` |
| `profile_update` | Interests, avoid topics, favorite/blocked channels, feedback, `ask` log, served log (`kind` + `reason` + optional `lane`), `based_on`, `explore_ratio`. Title/channel are filled in from the id. Returns `reply`, the JSON object to show (see [Reply contract](#reply-contract)). |

`yt_feed` and `yt_search` apply the profile server-side by default (`apply_profile=false` to see everything): blocked channels, avoid topics, disliked and recently served ids, and videos over `prefs.max_duration_min` are removed and reported as `dropped` counts, so the agent does not spend tokens re-filtering. `history` is never filtered.

### Why tags

`yt_search`, `yt_feed` and `yt_channel` tag every item with `why: [...]` so the agent can say *why* it picked something:

| Tag | Meaning |
|---|---|
| `subscribed` | channel is in your subscriptions feed |
| `favorite_channel` | channel is in `favorite_channels` |
| `liked_channel:N` / `disliked_channel:N` | you gave N liked / disliked verdicts to videos of this channel |
| `history:N` | N of your last 40 watched videos are from this channel |
| `watched` | this exact video is in your last 40 watched |
| `interest:<topic>` | title or channel matches one of your `interests` (whole words; all words of a multi-word topic) |
| `new_channel` | signed in, and the channel is in none of the above |

Subscriptions and history are fetched once per 5 minutes for this; without a cookie only the feedback/interest tags apply. The agent logs the ask (`profile_update ask=`) and the reason it showed for each pick (`served[].reason`), and `profile_get` returns both (`recent_asks`, `last_served`) so the next session can build on them ("you asked for focus music three times this week").

## Tests

`npm test` builds and runs `test/*.test.mjs`: the renderer normalizer (`toItem`), continuation merging and profile filtering against recorded YouTube nodes in `test/fixtures/`, the `reply` builder, and the Stop hook (validation, transcript parsing, a spawned run). When YouTube changes its layout, refresh the fixtures with `node test/capture-fixtures.mjs` (uses the cookie for the home/history ones).

## Try it

```
what should I watch tonight?
some blues to listen to while I work
something different from my usual
show me Bloomberg's take on Nvidia's earnings
I didn't like the second one, and never show me that channel again
```

## Reply contract

Every reply from the agent is exactly one JSON object with nothing around it, so a TV app can `JSON.parse` it. `type` is `recommendation`, `research`, `feedback`, `message` or `error`; `items` is `[]` when there is nothing to show and `message` then says why in one sentence.

```json
{
  "type": "recommendation",
  "ask": "blues for work",
  "based_on": ["your Music feed (guitar/jazz heavy)", "you liked 2 from Blues Lounge", "explore due"],
  "items": [
    {
      "id": "Z9L67jTYI4I",
      "title": "Work Blues - Dark Slow Blues Music played on Guitar to Work and Study",
      "channel": "Blues Lounge",
      "duration": "8:00:00",
      "views": "1.2M views",
      "published": "1 year ago",
      "url": "https://youtu.be/Z9L67jTYI4I",
      "thumbnail": "https://i.ytimg.com/vi/Z9L67jTYI4I/hqdefault.jpg",
      "reason": "you liked 2 from this channel; 8h instrumental, fits work",
      "kind": "personal",
      "lane": "background"
    },
    {
      "id": "rWQfgKpq4eI",
      "title": "Delta Blues Guitar - Relaxing Instrumental Blues And Vintage Acoustic Country Blues",
      "channel": "Rabbit & Dust",
      "duration": "1:21:14",
      "url": "https://youtu.be/rWQfgKpq4eI",
      "thumbnail": "https://i.ytimg.com/vi/rWQfgKpq4eI/hqdefault.jpg",
      "reason": "outside your bubble: channel you've never watched, same mood",
      "kind": "explore"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `items[].reason` | ≤12 words, concrete, built from the item's why tags and the ask; explore picks start with "outside your bubble:" |
| `items[].kind` | `personal` or `explore` (the anti-echo-chamber share is computed from this) |
| `items[].lane` | optional 2–3 word group label when picks split (background vs active listening, long vs short) |
| `items[].live` | `true` for live streams, otherwise absent |
| `message` | one sentence: what changed (`feedback`), the summary (`research`), or what to do (`error`) |

For recommendations and feedback the server builds the object: the agent calls `profile_update ask= based_on= served=[{id, kind, reason, lane?}]` and echoes the returned `reply`, so `title`, `channel`, `duration`, `views`, `published`, `url` and `thumbnail` come from what the list tools returned for that id and are never typed by the model. Research replies put the cited videos in `items` and the 3–5 sentence summary in `message`.

## Smoke test

```bash
node smoke.mjs                      # runs every tool once
node smoke.mjs yt_channel '{"channel":"@bloomberg","query":"fed rate"}'
TV_AGENT_DIR=/tmp/tv node smoke.mjs # isolated profile dir
```

## Env

| Var | Default | Meaning |
|---|---|---|
| `YT_COOKIE` | – | YouTube cookie header for personal feeds (overrides `cookie.txt`) |
| `YT_BROWSER` | `firefox,chrome` | browsers/profiles `scripts/start.sh` tries for cookie refresh (yt-dlp syntax, e.g. `chrome:Profile 2`) |
| `YT_COOKIE_AUTO` | `1` | set `0` to disable cookie refresh (startup and the server's retry on rejection) |
| `YT_COOKIE_MAX_AGE_H` | `12` | skip the startup refresh while `cookie.txt` is younger than this; `0` = always refresh |
| `TV_AGENT_DIR` | `~/.config/tv-agent` | profile.json, cookie.txt, cache |
| `YT_LANG` / `YT_LOCATION` | `en` / `US` | Innertube locale |

## Caveats

**Bot gating.** YouTube often answers anonymous *player* requests with "Sign in to confirm you're not a bot" (seen from office/datacenter IPs). Search, feeds, channels, and video metadata still work, but `duration` and `transcript` in `yt_video` then need `YT_COOKIE`. The tool reports this with a `note` / `transcript_error` so the agent can fall back to the description or web search.

youtubei.js talks to an unofficial API; YouTube changes can break it. Bump the dependency when that happens. Cookies expire after weeks to months; refresh the same way.
