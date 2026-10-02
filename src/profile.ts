// Local taste profile: tiny JSON file. Tracks interests, feedback, what was asked and what was served
// (personal vs explore, with the reason shown) so the agent can personalize, explain, and stay out of an echo chamber.
// Also builds `reply`: the one JSON object the agent shows on the TV after profile_update (CLAUDE.md "Output").
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.TV_AGENT_DIR ?? join(homedir(), '.config', 'tv-agent');
const FILE = join(DATA_DIR, 'profile.json');

export type Verdict = 'liked' | 'disliked' | 'skipped' | 'watched';
export type Kind = 'personal' | 'explore';

/** A pick the agent showed: the id, personal|explore, the one-line reason, and an optional lane label. */
export interface Served { id: string; title?: string; channel?: string; kind: Kind; reason?: string; lane?: string }

export interface Profile {
  interests: string[];
  avoid_topics: string[];
  favorite_channels: string[];
  blocked_channels: string[];
  feedback: { id: string; title?: string; channel?: string; verdict: Verdict; note?: string; at: string }[];
  served: (Served & { at: string })[];
  asks: { text: string; at: string }[];
  explore_ratio: number;
  prefs: { max_duration_min?: number | null; lang?: string; notes?: string };
}

export interface ProfileOps {
  add_interests?: string[];
  remove_interests?: string[];
  add_avoid_topics?: string[];
  remove_avoid_topics?: string[];
  add_favorite_channels?: string[];
  remove_favorite_channels?: string[];
  add_blocked_channels?: string[];
  remove_blocked_channels?: string[];
  feedback?: { id: string; title?: string; channel?: string; verdict: Verdict; note?: string }[];
  served?: Served[];
  ask?: string;
  /** 2–3 profile facts the picks were based on; echoed as reply.based_on */
  based_on?: string[];
  explore_ratio?: number;
  prefs?: Profile['prefs'];
}

const EMPTY: Profile = {
  interests: [], avoid_topics: [], favorite_channels: [], blocked_channels: [],
  feedback: [], served: [], asks: [], explore_ratio: 0.25, prefs: { lang: 'en' },
};

const WINDOW = 20;
const SERVED_CAP = 300;
const FEEDBACK_CAP = 200;
const ASK_CAP = 50;

export function load(): Profile {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    // served[].why (before 0.3) → served[].reason
    if (Array.isArray(raw.served)) raw.served = raw.served.map(({ why, ...s }: any) => (why && !s.reason ? { ...s, reason: why } : s));
    return { ...structuredClone(EMPTY), ...raw };
  } catch { return structuredClone(EMPTY); }
}

function save(p: Profile) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(p, null, 1));
}

const day = (iso: string) => iso.slice(0, 10);

/** Profile + what the agent needs to personalize and explain: taste summary, recent asks, last picks with
 *  their reasons, and explore stats that say when to break the bubble. */
export function get() {
  const p = load();
  const recent = p.served.slice(-WINDOW);
  const exploreShare = recent.length ? recent.filter(s => s.kind === 'explore').length / recent.length : 0;
  const byChannel = (v: Verdict) => {
    const m = new Map<string, number>();
    for (const f of p.feedback) if (f.verdict === v && f.channel) m.set(f.channel, (m.get(f.channel) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([channel, n]) => ({ channel, n }));
  };
  // Compact on purpose: this goes into the agent's context on every recommendation.
  // Full feedback/served history stays on disk; the server applies it itself (yt.applyProfile / yt.tag).
  return {
    ...p,
    feedback: p.feedback.slice(-20).map(f => ({ id: f.id, verdict: f.verdict, ...(f.title ? { title: f.title } : {}), ...(f.channel ? { channel: f.channel } : {}), ...(f.note ? { note: f.note } : {}) })),
    served: undefined,
    asks: undefined,
    taste: { liked_channels: byChannel('liked'), disliked_channels: byChannel('disliked') },
    recent_asks: p.asks.slice(-10).map(a => ({ text: a.text, at: day(a.at) })),
    last_served: p.served.slice(-8).map(s => ({ id: s.id, title: s.title, channel: s.channel, kind: s.kind, reason: s.reason, at: day(s.at) })),
    stats: {
      served_total: p.served.length,
      explore_share_last_20: Number(exploreShare.toFixed(2)),
      explore_due: recent.length < 4 || exploreShare < p.explore_ratio,
      recently_served_ids: p.served.slice(-40).map(s => s.id),
      disliked_ids: p.feedback.filter(f => f.verdict === 'disliked').map(f => f.id).slice(-40),
    },
  };
}

const uniq = (a: string[]) => [...new Set(a.map(s => s.trim()).filter(Boolean))];
const minus = (a: string[], b: string[]) => { const l = b.map(s => s.toLowerCase()); return a.filter(x => !l.includes(x.toLowerCase())); };

/** Apply the ops, persist, and return `reply` (the object to show) plus the compact stats. */
export function update(ops: ProfileOps, known?: (id: string) => Known | undefined) {
  const p = load();
  const now = new Date().toISOString();
  const list = (k: 'interests' | 'avoid_topics' | 'favorite_channels' | 'blocked_channels', add?: string[], rm?: string[]) => {
    if (add) p[k] = uniq([...p[k], ...add]);
    if (rm) p[k] = minus(p[k], rm);
  };
  list('interests', ops.add_interests, ops.remove_interests);
  list('avoid_topics', ops.add_avoid_topics, ops.remove_avoid_topics);
  list('favorite_channels', ops.add_favorite_channels, ops.remove_favorite_channels);
  list('blocked_channels', ops.add_blocked_channels, ops.remove_blocked_channels);
  if (ops.feedback) p.feedback = [...p.feedback, ...ops.feedback.map(f => ({ ...f, at: now }))].slice(-FEEDBACK_CAP);
  if (ops.served) p.served = [...p.served, ...ops.served.map(s => ({ ...s, at: now }))].slice(-SERVED_CAP);
  if (ops.ask?.trim()) p.asks = [...p.asks, { text: ops.ask.trim(), at: now }].slice(-ASK_CAP);
  if (ops.explore_ratio !== undefined) p.explore_ratio = Math.min(1, Math.max(0, ops.explore_ratio));
  if (ops.prefs) p.prefs = { ...p.prefs, ...ops.prefs };
  save(p);
  const g = get();
  return { ok: true, reply: reply(ops, known), interests: g.interests, blocked_channels: g.blocked_channels, explore_ratio: g.explore_ratio, stats: g.stats };
}

// ---- the TV reply ---------------------------------------------------------------
/** What the list tools already know about a video (a yt.Item), used to fill the reply. */
export interface Known { title?: string; channel?: string; duration?: string; views?: string; published?: string; live?: boolean }
export interface ReplyItem {
  id: string; title: string; channel?: string; duration?: string; views?: string; published?: string; live?: true;
  url: string; thumbnail: string; reason: string; kind: Kind; lane?: string;
}
export interface Reply { type: 'recommendation' | 'feedback'; ask?: string; based_on?: string[]; items: ReplyItem[]; message?: string }

export const videoUrl = (id: string) => `https://youtu.be/${id}`;
export const thumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
/** Drop undefined keys so the JSON shown on the TV has no nulls and a stable key order. */
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The exact JSON object the agent shows after profile_update. url and thumbnail come from the id, title/channel/
 *  duration/views/published from what the list tools returned for it (`known`), so the agent never types a link or a
 *  title: it only adds reason, kind and lane. Feedback-only calls get a one-line message saying what changed. */
export function reply(ops: ProfileOps, known: (id: string) => Known | undefined = () => undefined): Reply {
  const items = (ops.served ?? []).map(s => {
    const k = known(s.id) ?? {};
    return compact<ReplyItem>({
      id: s.id, title: k.title || s.title || '', channel: k.channel || s.channel || undefined,
      duration: k.duration || undefined, views: k.views || undefined, published: k.published || undefined, live: k.live ? true : undefined,
      url: videoUrl(s.id), thumbnail: thumbnail(s.id), reason: s.reason?.trim() || '', kind: s.kind, lane: s.lane?.trim() || undefined,
    });
  });
  const list = (label: string, l?: string[]) => (l?.length ? `${label} ${l.join(', ')}` : '');
  const verdicts = (['liked', 'disliked', 'skipped', 'watched'] as const).map(v => { const n = (ops.feedback ?? []).filter(f => f.verdict === v).length; return n ? `${n} ${v}` : ''; });
  const changes = [
    list('blocked', ops.add_blocked_channels), list('unblocked', ops.remove_blocked_channels),
    list('avoiding', ops.add_avoid_topics), list('no longer avoiding', ops.remove_avoid_topics),
    list('interests +', ops.add_interests), list('interests −', ops.remove_interests),
    list('favorites +', ops.add_favorite_channels), list('favorites −', ops.remove_favorite_channels),
    ...verdicts,
    ops.explore_ratio !== undefined ? `explore ratio ${Math.round(ops.explore_ratio * 100)}%` : '',
    ops.prefs?.max_duration_min !== undefined ? (ops.prefs.max_duration_min ? `max ${ops.prefs.max_duration_min} min` : 'no max duration') : '',
  ].filter(Boolean);
  const message = changes.length ? `Noted: ${changes.join(' · ')}.` : items.length ? undefined : 'Profile updated.';
  return compact<Reply>({
    type: items.length ? 'recommendation' : 'feedback',
    ask: ops.ask?.trim() || undefined,
    based_on: ops.based_on?.length ? ops.based_on : undefined,
    items,
    message,
  });
}
