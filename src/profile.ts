// Local taste profile: tiny JSON file. Tracks interests, feedback, and what was served
// (personal vs explore) so the agent can keep the user out of an echo chamber.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.TV_AGENT_DIR ?? join(homedir(), '.config', 'tv-agent');
const FILE = join(DATA_DIR, 'profile.json');

export type Verdict = 'liked' | 'disliked' | 'skipped' | 'watched';
export type Kind = 'personal' | 'explore';

export interface Profile {
  interests: string[];
  avoid_topics: string[];
  favorite_channels: string[];
  blocked_channels: string[];
  feedback: { id: string; title?: string; channel?: string; verdict: Verdict; note?: string; at: string }[];
  served: { id: string; title?: string; kind: Kind; at: string }[];
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
  served?: { id: string; title?: string; kind: Kind }[];
  explore_ratio?: number;
  prefs?: Profile['prefs'];
}

const EMPTY: Profile = {
  interests: [], avoid_topics: [], favorite_channels: [], blocked_channels: [],
  feedback: [], served: [], explore_ratio: 0.25, prefs: { lang: 'en' },
};

const WINDOW = 20;
const SERVED_CAP = 300;
const FEEDBACK_CAP = 200;

export function load(): Profile {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try { return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(FILE, 'utf8')) }; }
  catch { return structuredClone(EMPTY); }
}

function save(p: Profile) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(p, null, 1));
}

/** Profile + computed explore stats the agent uses to decide when to break the bubble. */
export function get() {
  const p = load();
  const recent = p.served.slice(-WINDOW);
  const exploreShare = recent.length ? recent.filter(s => s.kind === 'explore').length / recent.length : 0;
  // Compact on purpose: this goes into the agent's context on every recommendation.
  // Full feedback/served history stays on disk; the server applies it itself (yt.applyProfile).
  return {
    ...p,
    feedback: p.feedback.slice(-20).map(f => ({ id: f.id, verdict: f.verdict, ...(f.channel ? { channel: f.channel } : {}), ...(f.note ? { note: f.note } : {}) })),
    served: undefined,
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

export function update(ops: ProfileOps) {
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
  if (ops.explore_ratio !== undefined) p.explore_ratio = Math.min(1, Math.max(0, ops.explore_ratio));
  if (ops.prefs) p.prefs = { ...p.prefs, ...ops.prefs };
  save(p);
  const g = get();
  return { ok: true, interests: g.interests, blocked_channels: g.blocked_channels, explore_ratio: g.explore_ratio, stats: g.stats };
}
