#!/usr/bin/env node
// Smart-TV YouTube agent MCP server (stdio). Six tools, compact JSON output.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yt from './yt.js';
import * as profile from './profile.js';

// Agent policy lives once, in CLAUDE.md (read at startup so Claude Code and other MCP clients share it).
// The inline text is only a fallback for installs that ship dist/ without the repo.
const FALLBACK = `You are a smart-TV agent for YouTube. Output is read on a TV: short, numbered picks, each "title — channel — duration — url".
Recommend flow: profile_get → yt_feed home + subscriptions (history to avoid rewatch; the server already drops blocked channels, disliked and recently served ids, over-long videos) → present 5-8 picks → profile_update served (kind personal|explore).
Anti echo-chamber: if stats.explore_due, or user sounds bored / asks for something different, include 1-3 picks from yt_feed explore. Label them "outside your bubble". Never serve zero explore picks in a session.
Research ("X's take on Y"): yt_channel channel=@handle query=Y → yt_video include=transcript → summarize their take with links.
Feedback ("liked / not this / block channel / more like this") → profile_update.`;
const POLICY = fileURLToPath(new URL('../CLAUDE.md', import.meta.url));
const INSTRUCTIONS = existsSync(POLICY) ? readFileSync(POLICY, 'utf8') : FALLBACK;

const server = new McpServer({ name: 'smart-tv', version: '0.1.0' }, { instructions: INSTRUCTIONS });

/** Over-fetch, filter by profile, cut to limit. Keeps `dropped` counts so the agent knows why a list is short. */
const applied = <T extends { items: yt.Item[]; dropped?: yt.Dropped }>(r: T, limit: number, apply: boolean, served = true): T => {
  if (!apply) return { ...r, items: r.items.slice(0, limit) };
  const f = yt.applyProfile(r.items, { served });
  const dropped = { ...(r.dropped ?? {}), ...(f.dropped ?? {}) };
  return { ...r, items: f.items.slice(0, limit), ...(Object.keys(dropped).length ? { dropped } : {}) };
};
const OVER = 10; // extra rows fetched to compensate for profile drops

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const run = async (fn: () => Promise<unknown>) => {
  try { return ok(await fn()); }
  catch (e: any) { return { isError: true, content: [{ type: 'text' as const, text: `Error: ${e?.message ?? String(e)}` }] }; }
};

server.registerTool('yt_search', {
  description: 'Search YouTube videos. Use prioritize=popularity + upload_date=week for trending-ish results on a topic.',
  inputSchema: {
    query: z.string(),
    upload_date: z.enum(['all', 'today', 'week', 'month', 'year']).optional(),
    type: z.enum(['all', 'video', 'shorts', 'channel', 'playlist', 'movie']).optional(),
    duration: z.enum(['all', 'over_twenty_mins', 'under_three_mins', 'three_to_twenty_mins']).optional(),
    prioritize: z.enum(['relevance', 'popularity']).optional(),
    limit: z.number().int().min(1).max(30).default(10),
    apply_profile: z.boolean().default(true).describe('drop blocked channels, disliked/recently served ids, over-long videos (see dropped counts)'),
  },
}, ({ query, apply_profile, limit, ...o }) => run(async () =>
  applied({ items: await yt.search(query, { ...o, limit: apply_profile ? Math.min(30, limit + OVER) : limit }) }, limit, apply_profile).items));

server.registerTool('yt_feed', {
  description: 'Personal feeds (home/subscriptions/history; need cookie) or explore (non-personal: "New to you" chip, mainstream feed, popularity search on a topic outside the profile; never subscribed channels). home accepts a filter chip (e.g. News, Gaming, Music, Live, "New to you"); response lists available_filters. Blocked/disliked/recently served/over-long items are already dropped (dropped counts in response) unless apply_profile=false.',
  inputSchema: {
    source: z.enum(['home', 'subscriptions', 'history', 'explore']),
    filter: z.string().optional().describe('home only: chip name'),
    topic: z.string().optional().describe('explore only: topic outside the user bubble; random if omitted'),
    limit: z.number().int().min(1).max(40).default(15),
    apply_profile: z.boolean().default(true).describe('history ignores this (it is the past)'),
  },
}, ({ source, apply_profile, limit, ...o }) => run(async () => {
  const apply = apply_profile && source !== 'history';
  return applied(await yt.feed(source, { ...o, limit: apply ? Math.min(40, limit + OVER) : limit }), limit, apply);
}));

server.registerTool('yt_channel', {
  description: 'Channel lookup by @handle, URL, name or UC id. Without query: latest uploads. With query: search inside the channel (e.g. channel="@bloomberg", query="rate cuts").',
  inputSchema: {
    channel: z.string(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(30).default(10),
  },
}, ({ channel, ...o }) => run(() => yt.channel(channel, o)));

server.registerTool('yt_video', {
  description: 'Video details by id or URL. include: description | related | transcript (transcript truncated to max_chars).',
  inputSchema: {
    id: z.string(),
    include: z.array(z.enum(['description', 'related', 'transcript'])).default([]),
    max_chars: z.number().int().min(200).max(60000).default(4000),
  },
}, ({ id, include, max_chars }) => run(() => yt.video(id, include, max_chars)));

server.registerTool('profile_get', {
  description: 'Taste profile + stats: explore_due, explore_share_last_20, recently_served_ids, disliked_ids. Call first when recommending.',
  inputSchema: {},
}, () => run(async () => profile.get()));

const strList = z.array(z.string()).optional();
server.registerTool('profile_update', {
  description: 'Update taste profile: interests, avoid topics, favorite/blocked channels, feedback on videos, log served picks (kind personal|explore), explore_ratio, prefs.',
  inputSchema: {
    add_interests: strList, remove_interests: strList,
    add_avoid_topics: strList, remove_avoid_topics: strList,
    add_favorite_channels: strList, remove_favorite_channels: strList,
    add_blocked_channels: strList, remove_blocked_channels: strList,
    feedback: z.array(z.object({
      id: z.string(), title: z.string().optional(), channel: z.string().optional(),
      verdict: z.enum(['liked', 'disliked', 'skipped', 'watched']), note: z.string().optional(),
    })).optional(),
    served: z.array(z.object({ id: z.string(), title: z.string().optional(), kind: z.enum(['personal', 'explore']) })).optional(),
    explore_ratio: z.number().min(0).max(1).optional(),
    prefs: z.object({ max_duration_min: z.number().nullable().optional(), lang: z.string().optional(), notes: z.string().optional() }).optional(),
  },
}, (ops) => run(async () => profile.update(ops)));

await server.connect(new StdioServerTransport());
