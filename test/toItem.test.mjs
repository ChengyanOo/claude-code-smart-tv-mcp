// Normalizer + profile-filter tests against recorded youtubei.js nodes (test/fixtures, see capture-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TV_AGENT_DIR = mkdtempSync(join(tmpdir(), 'tv-agent-test-'));
const { toItem, items, more, applyProfile } = await import('../dist/yt.js');
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
