// Normalizer + profile-filter tests against recorded youtubei.js nodes (test/fixtures, see capture-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TV_AGENT_DIR = mkdtempSync(join(tmpdir(), 'tv-agent-test-'));
const { toItem, items, more, applyProfile, mentions, tag, remember, recall } = await import('../dist/yt.js');
const profile = await import('../dist/profile.js');
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));

test('search Video node → full item', () => {
  const it = toItem(fx('search-video'));
  assert.ok(it);
  assert.match(it.id, /^[\w-]{11}$/);
  assert.ok(it.title.length > 0);
  assert.ok(it.channel, 'channel name');
  assert.match(it.channelId ?? '', /^UC/);
  assert.match(it.duration ?? '', /^\d+:\d\d/);
  assert.equal(it.url, `https://youtu.be/${it.id}`);
});

test('home RichItem → LockupView unwrapped with channel, views, duration', () => {
  const it = toItem(fx('home-richitem-lockup'));
  assert.ok(it);
  assert.match(it.id, /^[\w-]{11}$/);
  assert.ok(it.channel, 'channel from metadata row 0');
  assert.match(it.views ?? '', /view/i);
  assert.match(it.duration ?? '', /^\d+:\d\d/);
});

test('shorts are dropped by default and kept with shorts:true', () => {
  const n = fx('shorts-lockup');
  assert.equal(toItem(n), null);
  const it = toItem(n, { shorts: true });
  assert.ok(it && it.id && it.title);
});

test('more() keeps first-page metadata and dedups across pages', () => {
  const first = items([fx('search-video')], 10);
  assert.equal(first.length, 1);
  const page2 = [fx('search-video'), fx('home-richitem-lockup')]; // repeats page-1 video
  const out = more(first, page2, 10);
  assert.equal(out.length, 2, 'duplicate removed');
  assert.equal(out[0].channel, first[0].channel, 'channel survives continuation');
  assert.ok(out[1].channel);
});

test('applyProfile drops blocked / disliked / served / too long and counts them', () => {
  const a = { ...toItem(fx('search-video')), duration: '10:00' }, b = { ...toItem(fx('home-richitem-lockup')), duration: '12:34' };
  const mk = (id, extra = {}) => ({ ...a, id, url: `https://youtu.be/${id}`, ...extra });
  const list = [
    a,                                            // kept
    mk('blocked00001', { channel: 'Some Blocked Guy' }),
    mk('blocked00002', { channel: 'other', channelId: 'UCblockedbyidXXXXXXXXXXX' }),
    mk('disliked0001'),
    mk('served000001'),
    mk('toolong00001', { duration: '2:30:00' }),
    b,
  ];
  writeFileSync(join(process.env.TV_AGENT_DIR, 'profile.json'), JSON.stringify({
    blocked_channels: ['@some blocked guy', 'UCblockedbyidXXXXXXXXXXX'],
    feedback: [{ id: 'disliked0001', verdict: 'disliked', at: 'x' }],
    served: [{ id: 'served000001', kind: 'personal', at: 'x' }],
    prefs: { max_duration_min: 90 },
  }));
  const r = applyProfile(list);
  assert.deepEqual(r.items.map(i => i.id), [a.id, b.id]);
  assert.deepEqual(r.dropped, { blocked: 2, disliked: 1, served: 1, too_long: 1 });
  assert.equal(applyProfile(list, { served: false }).items.length, 3, 'served dedup can be skipped');
});

test('mentions: whole-word / all-words / CJK matching', () => {
  const it = (title, channel) => ({ id: 'x', title, channel, url: '' });
  assert.ok(mentions('blues', it('Work Blues - Slow Blues to Study')));
  assert.ok(!mentions('ai', it('Rain and Train sounds')), 'no substring match inside words');
  assert.ok(mentions('AI', it('Anthropic AI spending surges | Bloomberg Tech')));
  assert.ok(mentions('blues music', it('Delta Blues Guitar - Relaxing Music')), 'all words of a multi-word topic');
  assert.ok(!mentions('blues music', it('Delta Blues Guitar')));
  assert.ok(mentions('bloomberg', it('Rate cuts', 'Bloomberg Television')), 'channel counts too');
  assert.ok(mentions('美食', it('中国美食之旅')), 'CJK: plain containment');
});

test('applyProfile drops avoid topics and counts them', () => {
  const a = { ...toItem(fx('search-video')), duration: '10:00' };
  const mk = (id, extra = {}) => ({ ...a, id, url: `https://youtu.be/${id}`, ...extra });
  writeFileSync(join(process.env.TV_AGENT_DIR, 'profile.json'), JSON.stringify({ avoid_topics: ['ASMR', 'true crime'] }));
  const r = applyProfile([a, mk('avoid0000001', { title: 'Rain ASMR for sleep' }), mk('avoid0000002', { title: 'The True Crime Files' }), mk('keep00000001', { title: 'Crime novels ranked' })]);
  assert.deepEqual(r.items.map(i => i.id), [a.id, 'keep00000001']);
  assert.deepEqual(r.dropped, { avoided: 2 });
});

test('tag explains a pick from subs, history, feedback and interests', () => {
  const p = { ...profile.load(), interests: ['blues', 'lofi'], favorite_channels: ['@Blues Lounge'],
    feedback: [{ id: 'a', verdict: 'liked', channel: 'Blues Lounge', at: 'x' }, { id: 'b', verdict: 'liked', channel: 'Blues Lounge', at: 'x' }, { id: 'c', verdict: 'disliked', channel: 'Loud Guy', at: 'x' }] };
  const ctx = { signed_in: true, subs: new Set(['ucsubbed0000000000000000', 'tommy emmanuel, cgp']), hist: new Map([['blues lounge', 3]]), watched: new Set(['watched0001']) };
  const it = (o) => ({ id: 'v', title: 't', url: '', ...o });
  assert.deepEqual(tag(it({ title: 'Bourbon Blues', channel: 'Blues Lounge' }), p, ctx), ['favorite_channel', 'liked_channel:2', 'history:3', 'interest:blues']);
  assert.deepEqual(tag(it({ title: 'Somewhere Over The Rainbow', channel: 'Tommy Emmanuel, CGP' }), p, ctx), ['subscribed']);
  assert.deepEqual(tag(it({ id: 'watched0001', title: 'x', channel: 'Other', channelId: 'UCsubbed0000000000000000' }), p, ctx), ['subscribed', 'watched']);
  assert.deepEqual(tag(it({ title: 'Loud stuff', channel: 'Loud Guy' }), p, ctx), ['disliked_channel:1', 'new_channel']);
  assert.deepEqual(tag(it({ title: 'lofi beats', channel: 'Nobody' }), p, ctx), ['interest:lofi', 'new_channel']);
  assert.deepEqual(tag(it({ title: 'plain', channel: 'Nobody' }), { ...p, interests: [] }, { ...ctx, signed_in: false }), [], 'anonymous: no new_channel guess');
});

test('profile: ask + served.reason are logged; recall fills title/channel; get() summarizes taste', () => {
  writeFileSync(join(process.env.TV_AGENT_DIR, 'profile.json'), JSON.stringify({}));
  remember([{ id: 'vid00000001', title: 'Work Blues', channel: 'Blues Lounge', url: '' }]);
  assert.deepEqual(recall('vid00000001'), { title: 'Work Blues', channel: 'Blues Lounge' });
  assert.equal(recall('nope'), undefined);
  profile.update({ ask: ' blues for work ', served: [{ ...recall('vid00000001'), id: 'vid00000001', kind: 'personal', reason: '8h instrumental, fits work' }],
    feedback: [{ ...recall('vid00000001'), id: 'vid00000001', verdict: 'liked' }, { id: 'other000001', channel: 'Blues Lounge', verdict: 'liked' }, { id: 'bad000000001', channel: 'Loud Guy', verdict: 'disliked' }] });
  const g = profile.get();
  assert.deepEqual(g.recent_asks.map(a => a.text), ['blues for work']);
  assert.match(g.recent_asks[0].at, /^\d{4}-\d\d-\d\d$/);
  assert.equal(g.last_served.length, 1);
  assert.deepEqual({ ...g.last_served[0], at: undefined }, { id: 'vid00000001', title: 'Work Blues', channel: 'Blues Lounge', kind: 'personal', reason: '8h instrumental, fits work', at: undefined });
  assert.deepEqual(g.taste, { liked_channels: [{ channel: 'Blues Lounge', n: 2 }], disliked_channels: [{ channel: 'Loud Guy', n: 1 }] });
  assert.equal(g.served, undefined); assert.equal(g.asks, undefined);
  assert.equal(g.feedback[0].title, 'Work Blues');
});
