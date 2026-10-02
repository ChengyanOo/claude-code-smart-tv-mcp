// profile.reply() (the one JSON object shown on the TV) and the Stop hook that enforces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.TV_AGENT_DIR = mkdtempSync(join(tmpdir(), 'tv-agent-test-'));
const profile = await import('../dist/profile.js');
const { remember, recallItem } = await import('../dist/yt.js');
const { validate, lastTurn, SHAPE } = await import('../scripts/reply-json-hook.mjs');
const HOOK = fileURLToPath(new URL('../scripts/reply-json-hook.mjs', import.meta.url));

const known = { vid00000001: { title: 'Work Blues', channel: 'Blues Lounge', duration: '8:00:00', views: '1.2M views', published: '1 year ago' } };

test('reply: served picks become full TV items; url/thumbnail from the id; agent only adds reason/kind/lane', () => {
  const r = profile.reply({ ask: ' blues for work ', based_on: ['your Music feed'], served: [
    { id: 'vid00000001', kind: 'personal', reason: 'you liked 2 from this channel', lane: 'background' },
    { id: 'unknown0001', kind: 'explore', reason: 'outside your bubble: new channel', title: 'Agent Title', channel: 'Agent Channel' },
  ] }, id => known[id]);
  assert.equal(r.type, 'recommendation');
  assert.equal(r.ask, 'blues for work');
  assert.deepEqual(r.based_on, ['your Music feed']);
  assert.equal(r.message, undefined);
  assert.deepEqual(r.items[0], { id: 'vid00000001', title: 'Work Blues', channel: 'Blues Lounge', duration: '8:00:00', views: '1.2M views', published: '1 year ago',
    url: 'https://youtu.be/vid00000001', thumbnail: 'https://i.ytimg.com/vi/vid00000001/hqdefault.jpg', reason: 'you liked 2 from this channel', kind: 'personal', lane: 'background' });
  assert.deepEqual(Object.keys(r.items[0]), ['id', 'title', 'channel', 'duration', 'views', 'published', 'url', 'thumbnail', 'reason', 'kind', 'lane'], 'stable key order');
  assert.deepEqual(r.items[1], { id: 'unknown0001', title: 'Agent Title', channel: 'Agent Channel', url: 'https://youtu.be/unknown0001', thumbnail: 'https://i.ytimg.com/vi/unknown0001/hqdefault.jpg',
    reason: 'outside your bubble: new channel', kind: 'explore' }, 'unknown id: agent-provided title/channel, no undefined keys');
  assert.equal(validate(JSON.stringify(r)), null, 'what the server builds passes the hook');
});

test('reply: feedback-only call gets a one-line message of what changed', () => {
  const r = profile.reply({ add_blocked_channels: ['Loud Guy'], add_interests: ['blues'], feedback: [{ id: 'a', verdict: 'disliked' }, { id: 'b', verdict: 'liked' }, { id: 'c', verdict: 'liked' }], explore_ratio: 0.4 });
  assert.deepEqual(r, { type: 'feedback', items: [], message: 'Noted: blocked Loud Guy · interests + blues · 2 liked · 1 disliked · explore ratio 40%.' });
  assert.equal(validate(JSON.stringify(r)), null);
  assert.deepEqual(profile.reply({}), { type: 'feedback', items: [], message: 'Profile updated.' });
  const both = profile.reply({ add_blocked_channels: ['Loud Guy'], served: [{ id: 'x', kind: 'personal', reason: 'r', title: 't' }] });
  assert.equal(both.type, 'recommendation');
  assert.equal(both.message, 'Noted: blocked Loud Guy.');
});

test('update() returns reply filled from recall; served.reason is logged; old served.why migrates', () => {
  writeFileSync(join(process.env.TV_AGENT_DIR, 'profile.json'), JSON.stringify({ served: [{ id: 'old00000001', kind: 'personal', why: 'legacy reason', at: '2026-01-01T00:00:00Z' }] }));
  assert.equal(profile.load().served[0].reason, 'legacy reason', 'why → reason');
  remember([{ id: 'vid00000001', ...known.vid00000001, url: 'https://youtu.be/vid00000001' }]);
  const u = profile.update({ ask: 'blues', served: [{ id: 'vid00000001', kind: 'personal', reason: 'fits work' }] }, recallItem);
  assert.equal(u.reply.type, 'recommendation');
  assert.equal(u.reply.items[0].title, 'Work Blues');
  assert.equal(u.reply.items[0].duration, '8:00:00');
  assert.deepEqual(profile.get().last_served.map(s => s.reason), ['legacy reason', 'fits work']);
});

test('hook validate: accepts the contract, names what is wrong otherwise', () => {
  const ok = { type: 'message', items: [], message: 'hi' };
  assert.equal(validate(JSON.stringify(ok)), null);
  assert.equal(validate(` \n${JSON.stringify(ok, null, 2)}\n`), null, 'whitespace / pretty print fine');
  assert.match(validate('Here you go:\n' + JSON.stringify(ok)), /prose/);
  assert.match(validate('```json\n' + JSON.stringify(ok) + '\n```'), /code fence/);
  assert.match(validate('[]'), /one JSON object/);
  assert.match(validate('{"items": []}'), /"type"/);
  assert.match(validate('{"type":"message","items":[]}'), /"message" is required/);
  assert.match(validate('{"type":"recommendation","items":{}}'), /"items" must be an array/);
  assert.match(validate('{"type":"recommendation","items":[{"title":"t","url":"https://youtu.be/x"}]}'), /items\[0\]\.reason/);
  assert.match(validate('{"type":"recommendation","items":[{"title":"t","url":"http://evil","reason":"r"}]}'), /YouTube link/);
  assert.equal(validate(''), 'reply is empty');
  assert.equal(validate(JSON.stringify(ok) + ' thanks'), 'reply is not valid JSON (text around it, or a syntax error)');
});

const row = (type, content, id) => JSON.stringify({ type, message: { role: type, ...(id ? { id } : {}), content } });
const transcript = (...rows) => rows.join('\n') + '\n';
const user = t => row('user', [{ type: 'text', text: t }]);
const result = () => row('user', [{ type: 'tool_result', content: '{}' }]);
const tool = (name, id) => row('assistant', [{ type: 'tool_use', name, input: {} }], id);
const text = (t, id) => row('assistant', [{ type: 'text', text: t }], id);

test('hook lastTurn: scopes to the last human message, reads the final text, notices tv tools', () => {
  const t = transcript(
    user('what should I watch'), tool('mcp__tv__profile_get', 'm1'), result(), text('{"type":"message","items":[],"message":"x"}', 'm2'),
    user('fix the code'), text('Looking.', 'm3'), tool('Bash', 'm3'), result(), text('Done.', 'm4'),
  );
  assert.deepEqual(lastTurn(t), { usedTv: false, text: 'Done.' }, 'a tv call in an earlier turn does not count');
  const t2 = transcript(user('hey'), text('intro', 'm1'), tool('mcp__tv__yt_search', 'm1'), result(), text('part 1', 'm2'), text('part 2', 'm2'));
  assert.deepEqual(lastTurn(t2), { usedTv: true, text: 'part 1\npart 2' }, 'all text blocks of the final message, not the intro');
  const t3 = transcript(user('hey'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'mcp__tv__yt_search' }] } }), text('hi', 'm1'), 'not json', '');
  assert.deepEqual(lastTurn(t3), { usedTv: false, text: 'hi' }, 'sidechain rows and junk lines are ignored');
  assert.deepEqual(lastTurn(''), { usedTv: false, text: '' });
});

test('hook end to end: blocks prose after tv tools; lets JSON, dev turns and the retry through', () => {
  const run = (rows, extra = {}) => {
    const p = join(process.env.TV_AGENT_DIR, 'transcript.jsonl');
    writeFileSync(p, transcript(...rows));
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ transcript_path: p, stop_hook_active: false, ...extra }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const tv = [user('recs'), tool('mcp__tv__profile_get', 'm1'), result()];
  const blocked = run([...tv, text('Based on: blues · 1. Work Blues — https://youtu.be/x', 'm2')]);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /prose, not JSON/);
  assert.ok(blocked.reason.includes(SHAPE), 'tells the agent the shape');
  assert.equal(run([...tv, text('{"type":"error","items":[],"message":"Not signed in"}', 'm2')]), null, 'valid JSON passes');
  assert.equal(run([user('fix code'), tool('Bash', 'm1'), result(), text('Fixed it.', 'm2')]), null, 'no tv tools: not enforced');
  assert.equal(run([...tv, text('still prose', 'm2')], { stop_hook_active: true }), null, 'never loops');
  assert.equal(run([...tv, tool('mcp__tv__yt_feed', 'm2')]), null, 'turn without a final text passes');
  const r = spawnSync(process.execPath, [HOOK], { input: '{"transcript_path":"/nonexistent"}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'fails open');
});
