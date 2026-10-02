// YouTube access via Innertube (youtubei.js). Two lazy sessions:
//   auth  — cookie-authenticated, for personal feeds (home/subscriptions/history)
//   anon  — no identity, for non-personal "explore" signals (anti echo-chamber)
import { Innertube, UniversalCache, YTNodes } from 'youtubei.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, load as loadProfile } from './profile.js';

export interface Item {
  id: string; title: string; channel?: string; channelId?: string;
  views?: string; published?: string; duration?: string; live?: boolean; url: string;
}

const LANG = process.env.YT_LANG ?? 'en';
const LOCATION = process.env.YT_LOCATION ?? 'US';
const base = () => ({
  lang: LANG, location: LOCATION, retrieve_player: false, generate_session_locally: true,
  cache: new UniversalCache(true, join(DATA_DIR, 'cache')),
});

// ---- cookie / sessions --------------------------------------------------------
const COOKIE_FILE = join(DATA_DIR, 'cookie.txt');
const COOKIE_SCRIPT = fileURLToPath(new URL('../scripts/yt-cookie.py', import.meta.url));

/** cookie.txt (auto-refreshed from the browser) wins; YT_COOKIE env is the manual fallback. */
function cookie(): string | undefined {
  if (existsSync(COOKIE_FILE)) { const c = readFileSync(COOKIE_FILE, 'utf8').trim(); if (c) return c; }
  return process.env.YT_COOKIE?.trim() || undefined;
}
const looksSignedIn = (c: string) => /(^|;\s*)SAPISID=/.test(c);

/** Re-extract the cookie from the browser via scripts/yt-cookie.py. True if cookie.txt changed. */
function refreshCookie(): boolean {
  if (process.env.YT_COOKIE_AUTO === '0' || !existsSync(COOKIE_SCRIPT)) return false;
  const before = existsSync(COOKIE_FILE) ? statSync(COOKIE_FILE).mtimeMs : 0;
  const py = process.env.PYTHON ?? (existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
  const r = spawnSync(py, [COOKIE_SCRIPT, '--force'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 30_000 });
  return r.status === 0 && existsSync(COOKIE_FILE) && statSync(COOKIE_FILE).mtimeMs > before;
}

let _auth: Promise<Innertube> | undefined;
let _anon: Promise<Innertube> | undefined;

/** youtubei.js sets session.logged_in = !!cookie, which proves nothing. Verify with a real personal
 *  request: a signed-in home feed has filter chips and/or videos; a rejected cookie or an account
 *  with no activity gets only a "FeedNudge". Sessions are not persisted to disk (cache keyed by
 *  nothing), so switching accounts can't pick up stale session data. */
async function createAuth(c: string): Promise<Innertube> {
  const yt = await Innertube.create({ ...base(), cookie: c, enable_session_cache: false });
  const h = await yt.getHomeFeed();
  if (!h.filters.length && !items(h.videos, 1).length) throw new Error('home feed empty (cookie rejected, or that account has no YouTube activity)');
  return yt;
}

export function auth(): Promise<Innertube> {
  if (_auth) return _auth;
  return (_auth = (async () => {
    let c = cookie();
    if ((!c || !looksSignedIn(c)) && refreshCookie()) c = cookie();
    if (!c) throw new Error(`Not signed in: no cookie. Run scripts/yt-cookie.py (see README) or set YT_COOKIE. Personal feeds need it; search/explore/channel/video do not.`);
    try { return await createAuth(c); }
    catch (e: any) {
      // Cookie present but unusable (expired/rotated): re-extract from the browser once and retry.
      if (refreshCookie()) { const c2 = cookie(); if (c2 && c2 !== c) return createAuth(c2); }
      throw new Error(`YouTube cookie unusable: ${e?.message ?? e}. Log into youtube.com in the browser profile named by YT_BROWSER (python3 scripts/yt-cookie.py --list), then restart or run scripts/yt-cookie.py --force.`);
    }
  })().catch(e => { _auth = undefined; throw e; }));
}
export function anon(): Promise<Innertube> {
  return (_anon ??= Innertube.create({ ...base(), enable_session_cache: false }).catch(e => { _anon = undefined; throw e; }));
}
/** Prefer the signed-in session for non-personal lookups too (better results); fall back to anon if auth fails. */
const any = () => (cookie() ? auth().catch(anon) : anon());

// ---- 5-minute memo cache ----------------------------------------------------
const TTL = 5 * 60_000;
const memo = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v as T;
  const v = await fn();
  memo.set(key, { t: Date.now(), v });
  return v;
}

// ---- normalizer -------------------------------------------------------------
const txt = (t: any): string | undefined => (t == null ? undefined : typeof t === 'string' ? t : t.text ?? t.toString?.());
const url = (id: string) => `https://youtu.be/${id}`;

/** Normalize the zoo of YouTube renderer nodes into one compact Item. Returns null for non-videos. */
export function toItem(n: any, opts: { shorts?: boolean } = {}): Item | null {
  if (!n) return null;
  if (n.type === 'RichItem') return toItem(n.content, opts);
  if (n.type === 'LockupView') {
    if (n.content_type === 'SHORT' && !opts.shorts) return null;
    if (n.content_type !== 'VIDEO' && n.content_type !== 'SHORT') return null;
    const rows: any[] = n.metadata?.metadata?.metadata_rows ?? [];
    const parts = (i: number) => (rows[i]?.metadata_parts ?? []).map((p: any) => txt(p.text)).filter(Boolean) as string[];
    const [channel] = parts(0);
    const [views, published] = parts(1);
    const badges: any[] = n.content_image?.overlays?.flatMap((o: any) => o.badges ?? []) ?? [];
    const dur = badges.find(b => /^\d+:\d\d/.test(b.text))?.text;
    const live = badges.some(b => /live/i.test(b.badge_style ?? '') || /^live$/i.test(b.text ?? ''));
    const channelId = n.metadata?.image?.avatar?.endpoint?.payload?.browseId
      ?? n.metadata?.image?.endpoint?.payload?.browseId;
    return { id: n.content_id, title: txt(n.metadata?.title) ?? '', channel, channelId, views, published, duration: dur, live: live || undefined, url: url(n.content_id) };
  }
  if (n.type === 'ShortsLockupView' || n.type === 'ReelItem') {
    if (!opts.shorts) return null;
    const id = n.on_tap_endpoint?.payload?.videoId ?? n.id;
    return id ? { id, title: txt(n.overlay_metadata?.primary_text ?? n.title) ?? '', views: txt(n.overlay_metadata?.secondary_text ?? n.views), url: url(id) } : null;
  }
  const id = n.video_id ?? n.id;
  if (!id || !n.title) return null;
  return {
    id, title: txt(n.title) ?? '',
    channel: n.author?.name, channelId: n.author?.id,
    views: txt(n.short_view_count) ?? txt(n.view_count),
    published: txt(n.published),
    // `duration` is a getter on youtubei.js's Video class (derived from length_text / the overlay), so read the raw fields too
    duration: n.duration?.text ?? txt(n.duration) ?? txt(n.length_text)
      ?? (n.thumbnail_overlays ?? []).find((o: any) => o.type === 'ThumbnailOverlayTimeStatus')?.text ?? undefined,
    live: n.is_live || (n.badges ?? []).some((b: any) => /LIVE/.test(b.style ?? '')) || undefined,
    url: url(id),
  };
}

export function items(nodes: Iterable<any>, limit: number, opts?: { shorts?: boolean }): Item[] {
  const out: Item[] = []; const seen = new Set<string>();
  for (const n of nodes) {
    const it = toItem(n, opts);
    if (it && it.id && !seen.has(it.id)) { seen.add(it.id); out.push(it); if (out.length >= limit) break; }
  }
  return out;
}
/** Append a continuation page to already-normalized items, deduping across pages. */
export function more(out: Item[], nodes: Iterable<any>, limit: number, opts?: { shorts?: boolean }): Item[] {
  const seen = new Set(out.map(i => i.id));
  return [...out, ...items(nodes, limit + out.length, opts).filter(i => !seen.has(i.id))].slice(0, limit);
}
const secs = (d?: string) => (d ? d.split(':').reduce((a, b) => a * 60 + Number(b), 0) : 0);

// ---- profile-aware filtering --------------------------------------------------
export interface Dropped { blocked?: number; disliked?: number; served?: number; too_long?: number; subscribed?: number }
const norm = (s?: string) => (s ?? '').trim().replace(/^@/, '').toLowerCase();
/** Drop what the local profile says not to show: blocked channels, disliked ids, recently served ids
 *  (skip with served=false, e.g. for history), anything over prefs.max_duration_min. Counts what it dropped. */
export function applyProfile(list: Item[], o: { served?: boolean } = {}): { items: Item[]; dropped?: Dropped } {
  const p = loadProfile();
  const blocked = new Set(p.blocked_channels.map(norm).filter(Boolean));
  const disliked = new Set(p.feedback.filter(f => f.verdict === 'disliked').map(f => f.id));
  const served = new Set(o.served === false ? [] : p.served.slice(-60).map(s => s.id));
  const maxSecs = p.prefs.max_duration_min ? p.prefs.max_duration_min * 60 : 0;
  const d: Dropped = {};
  const drop = (k: keyof Dropped) => { d[k] = (d[k] ?? 0) + 1; return false; };
  const kept = list.filter(i => {
    if (blocked.size && (blocked.has(norm(i.channel)) || blocked.has(norm(i.channelId)))) return drop('blocked');
    if (disliked.has(i.id)) return drop('disliked');
    if (served.has(i.id)) return drop('served');
    if (maxSecs && secs(i.duration) > maxSecs) return drop('too_long');
    return true;
  });
  return { items: kept, ...(Object.keys(d).length ? { dropped: d } : {}) };
}

// ---- operations --------------------------------------------------------------
export interface SearchOpts {
  upload_date?: 'all' | 'today' | 'week' | 'month' | 'year';
  type?: 'all' | 'video' | 'shorts' | 'channel' | 'playlist' | 'movie';
  duration?: 'all' | 'over_twenty_mins' | 'under_three_mins' | 'three_to_twenty_mins';
  prioritize?: 'relevance' | 'popularity';
  limit?: number;
}

export async function search(query: string, o: SearchOpts = {}) {
  const { limit = 10, ...filters } = o;
  return cached(`s:${query}:${JSON.stringify(filters)}:${limit}`, async () => {
    const yt = await any();
    const opts = { shorts: o.type === 'shorts' };
    let r = await yt.search(query, filters);
    let out = items(r.videos, limit, opts);
    for (let page = 0; out.length < limit && r.has_continuation && page < 3; page++) {
      r = await r.getContinuation();
      out = more(out, r.videos, limit, opts);
    }
    return out;
  });
}

export type FeedSource = 'home' | 'subscriptions' | 'history' | 'explore';
const EXPLORE_POOL = ['science', 'documentary', 'history', 'cooking', 'travel', 'nature', 'music live', 'engineering', 'art', 'comedy', 'sports highlights', 'space', 'economics explained', 'philosophy', 'architecture', 'world news'];

/** Channels the user is subscribed to (ids + names), learned from the subscriptions feed. Explore picks
 *  from these channels are never "outside the bubble", so explore drops them. */
const subChannels = new Set<string>();
const noteSubs = (list: Item[]) => list.forEach(i => { if (i.channelId) subChannels.add(norm(i.channelId)); if (i.channel) subChannels.add(norm(i.channel)); });
const isSub = (i: Item) => subChannels.has(norm(i.channelId)) || subChannels.has(norm(i.channel));

/** An explore topic the profile does not already cover (interests / avoid_topics). */
function exploreTopic(): string {
  const bubble = [...loadProfile().interests, ...loadProfile().avoid_topics].map(norm).filter(Boolean);
  const outside = EXPLORE_POOL.filter(t => !bubble.some(b => t.includes(b) || b.includes(t)));
  const pool = outside.length ? outside : EXPLORE_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function feed(source: FeedSource, o: { filter?: string; topic?: string; limit?: number } = {}) {
  const limit = o.limit ?? 15;
  if (source === 'explore') {
    // Non-personal signal, in order: 1) YouTube's own "New to you" chip on the signed-in home feed,
    // 2) anonymous home feed (mainstream; often empty from datacenter IPs), 3) popularity search on a topic outside the bubble.
    const topic = o.topic ?? exploreTopic();
    let out: Item[] = [];
    const sources: string[] = [];
    if (!o.topic && cookie()) {
      try {
        const [nty] = await Promise.all([feed('home', { filter: 'New to you', limit: Math.ceil(limit / 2) }), feed('subscriptions', { limit: 40 })]);
        out = nty.items; sources.push('home:New to you');
      } catch { /* chip missing or not signed in */ }
    }
    const yt = await anon();
    if (!o.topic && !out.length) {
      try { out = items((await yt.getHomeFeed()).videos, Math.ceil(limit / 2)); if (out.length) sources.push('anon home'); } catch { /* anon home may be empty */ }
    }
    const s = await yt.search(topic, { upload_date: 'week', prioritize: 'popularity', type: 'video' });
    // popularity sort is noisy: drop live streams, ads/clips under a minute, and shorts
    out = more(out, s.videos, limit * 2).filter(i => !i.live && secs(i.duration) >= 60);
    sources.push(`search:${topic}`);
    const subscribed = out.filter(isSub).length;
    out = out.filter(i => !isSub(i)).slice(0, limit);
    return { source, topic, sources, items: out, ...(subscribed ? { dropped: { subscribed } } : {}) };
  }
  const yt = await auth();
  return cached(`f:${source}:${o.filter ?? ''}:${limit}`, async () => {
    if (source === 'home') {
      let h = await yt.getHomeFeed();
      const filters = h.filters;
      if (o.filter) {
        const chip = filters.find(f => f.toLowerCase() === o.filter!.toLowerCase());
        if (!chip) throw new Error(`Unknown home filter "${o.filter}". Available: ${filters.join(', ')}`);
        h = await h.applyFilter(chip);
      }
      let out = items(h.videos, limit);
      if (out.length < limit && h.has_continuation) { h = await h.getContinuation(); out = more(out, h.videos, limit); }
      return { source, filter: o.filter, available_filters: filters, items: out };
    }
    if (source === 'subscriptions') {
      let f = await yt.getSubscriptionsFeed();
      let out = items(f.videos, limit);
      if (out.length < limit && f.has_continuation) { f = await f.getContinuation(); out = more(out, f.videos, limit); }
      noteSubs(out);
      return { source, items: out };
    }
    let h = await yt.getHistory();
    let out = items(h.videos, limit);
    if (out.length < limit && h.has_continuation) { h = await h.getContinuation(); out = more(out, h.videos, limit); }
    return { source, items: out };
  });
}

async function resolveChannelId(ref: string): Promise<string> {
  const yt = await any();
  ref = ref.trim();
  if (/^UC[\w-]{22}$/.test(ref)) return ref;
  const m = ref.match(/channel\/(UC[\w-]{22})/);
  if (m) return m[1];
  const handle = ref.match(/@([\w.-]+)/)?.[1];
  if (handle) {
    try { // resolve_url is flaky on YouTube's side; fall through to search on failure
      const ep = await yt.resolveURL(`https://www.youtube.com/@${handle}`);
      if (ep.payload?.browseId?.startsWith('UC')) return ep.payload.browseId;
    } catch { /* ignore */ }
  }
  const s = await yt.search(handle ?? ref, { type: 'channel' });
  const chans: any[] = s.channels.length ? [...s.channels] : s.results.filter((r: any) => r.type === 'Channel');
  const pick = (handle && chans.find(c => (c.author?.url ?? c.endpoint?.payload?.canonicalBaseUrl ?? '').toLowerCase().endsWith('/@' + handle.toLowerCase()))) ?? chans[0];
  const id = pick?.author?.id ?? pick?.id;
  if (!id) throw new Error(`Channel not found: ${ref}`);
  return id;
}

export async function channel(ref: string, o: { query?: string; limit?: number } = {}) {
  const limit = o.limit ?? 10;
  return cached(`c:${ref}:${o.query ?? ''}:${limit}`, async () => {
    const yt = await any();
    const id = await resolveChannelId(ref);
    const ch = await yt.getChannel(id);
    const meta = { id, title: ch.metadata.title, url: ch.metadata.url_canonical ?? `https://www.youtube.com/channel/${id}`, description: ch.metadata.description?.slice(0, 300) };
    const tab = o.query ? await ch.search(o.query) : await ch.getVideos();
    return { channel: meta, query: o.query, items: items(tab.videos, limit) };
  });
}

export type VideoPart = 'description' | 'related' | 'transcript';
export async function video(id: string, include: VideoPart[] = [], maxChars = 4000) {
  const yt = await any();
  const m = id.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
  if (m) id = m[1];
  const info = await yt.getInfo(id);
  const b = info.basic_info;
  // Anonymous WEB player calls are often bot-gated (LOGIN_REQUIRED); the `next` data still has the essentials.
  const p: any = (info as any).primary_info, sec: any = (info as any).secondary_info;
  const gated = info.playability_status?.status === 'LOGIN_REQUIRED';
  const out: Record<string, unknown> = {
    id: b.id ?? id, title: b.title ?? txt(p?.title), channel: b.channel?.name ?? b.author ?? sec?.owner?.author?.name,
    channelId: b.channel?.id ?? b.channel_id ?? sec?.owner?.author?.id,
    duration: b.duration, views: b.view_count ?? txt(p?.view_count?.view_count ?? p?.view_count),
    published: txt(p?.published) ?? b.start_timestamp?.toISOString(),
    category: b.category ?? undefined, live: b.is_live || undefined, url: url(b.id ?? id),
    ...(gated ? { note: 'player bot-gated for anonymous session; add YT_COOKIE for duration/transcript' } : {}),
  };
  if (include.includes('description')) out.description = (b.short_description ?? txt(sec?.description))?.slice(0, maxChars);
  if (include.includes('related')) out.related = items(info.watch_next_feed ?? [], 12);
  if (include.includes('transcript')) {
    const r = await transcript(yt, info, id);
    if ('text' in r) {
      out.transcript = r.text.length > maxChars ? r.text.slice(0, maxChars) + ' …[truncated]' : r.text;
      out.transcript_chars = r.text.length;
      out.transcript_source = r.source;
    } else out.transcript_error = r.error;
  }
  return out;
}

/** Best-effort transcript. YouTube's get_transcript often 400s for anonymous WEB sessions, so fall back
 *  to caption tracks exposed by the mobile clients and fetch them as json3. */
async function transcript(yt: Innertube, info: any, id: string): Promise<{ text: string; source: string } | { error: string }> {
  const errors: string[] = [];
  try {
    const t = await info.getTranscript();
    const segs = (t.transcript?.content?.body?.initial_segments ?? []) as any[];
    const text = segs.filter(s => s.type === 'TranscriptSegment').map(s => txt(s.snippet)).join(' ').trim();
    if (text) return { text, source: 'web' };
    errors.push('web: empty');
  } catch (e: any) { errors.push(`web: ${e?.message ?? e}`); }
  for (const client of ['IOS', 'ANDROID'] as const) {
    try {
      const i = await yt.getInfo(id, { client });
      const tracks: any[] = i.captions?.caption_tracks ?? [];
      if (!tracks.length) { errors.push(`${client}: no caption tracks`); continue; }
      const want = (process.env.YT_LANG ?? 'en').slice(0, 2);
      const track = tracks.find(t => t.language_code?.startsWith(want) && t.kind !== 'asr')
        ?? tracks.find(t => t.language_code?.startsWith(want)) ?? tracks[0];
      const res = await fetch(`${track.base_url}&fmt=json3`);
      if (!res.ok) { errors.push(`${client}: timedtext ${res.status}`); continue; }
      const body = await res.text();
      const text = (body.trimStart().startsWith('<')
        ? body.replace(/<[^>]+>/g, ' ') // srv XML: strip tags
        : ((JSON.parse(body) as { events?: { segs?: { utf8: string }[] }[] }).events ?? []).flatMap(e => e.segs ?? []).map(s => s.utf8).join(''))
        .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      if (text) return { text, source: `${client.toLowerCase()}:${track.language_code}${track.kind === 'asr' ? ':auto' : ''}` };
      errors.push(`${client}: empty`);
    } catch (e: any) { errors.push(`${client}: ${e?.message ?? e}`); }
  }
  return { error: `transcript unavailable (${errors.join('; ')}). Use include=["description"] or web search instead.` };
}
