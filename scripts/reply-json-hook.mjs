#!/usr/bin/env node
// Claude Code Stop hook (.claude/settings.json): on a turn that used the `tv` tools, the final reply must be one JSON
// object in the shape CLAUDE.md "Output" describes, because a TV app parses it. Blocks once with the reason so Claude
// rewrites, never loops (stop_hook_active), and fails open on anything unexpected so a broken transcript cannot wedge
// a session. Turns that did not call a tv tool (development work in this repo) are left alone.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SHAPE = '{"type":"recommendation|research|feedback|message|error","ask":"…","based_on":["…"],"items":[{"id":"…","title":"…","channel":"…","duration":"…","url":"https://youtu.be/<id>","thumbnail":"https://i.ytimg.com/vi/<id>/hqdefault.jpg","reason":"…","kind":"personal|explore"}],"message":"…"}';
const TYPES = ['recommendation', 'research', 'feedback', 'message', 'error'];

/** null when `text` is a valid TV reply, else what is wrong with it. */
export function validate(text) {
  const t = (text ?? '').trim();
  if (!t) return 'reply is empty';
  if (t.startsWith('```')) return 'reply is wrapped in a code fence';
  let v;
  try { v = JSON.parse(t); } catch { return /^[{[]/.test(t) ? 'reply is not valid JSON (text around it, or a syntax error)' : 'reply is prose, not JSON'; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'reply must be one JSON object';
  if (!TYPES.includes(v.type)) return `"type" must be one of ${TYPES.join('|')}`;
  if (!Array.isArray(v.items)) return '"items" must be an array ([] when there is nothing to show)';
  for (const [i, it] of v.items.entries()) {
    for (const k of ['title', 'url', 'reason']) if (typeof it?.[k] !== 'string' || !it[k].trim()) return `items[${i}].${k} is missing`;
    if (!/^https:\/\/(youtu\.be\/|www\.youtube\.com\/watch\?v=)/.test(it.url)) return `items[${i}].url is not a YouTube link`;
  }
  if (!v.items.length && (typeof v.message !== 'string' || !v.message.trim())) return '"message" is required when items is empty';
  return null;
}

const human = c => typeof c === 'string' || (Array.isArray(c) && c.some(b => b?.type === 'text') && !c.some(b => b?.type === 'tool_result'));
const blocks = r => (Array.isArray(r?.message?.content) ? r.message.content : []);

/** The last turn of a Claude Code transcript (JSONL, one row per content block): whether a tv tool was called,
 *  and the text of the final assistant message (all its text blocks). */
export function lastTurn(jsonl) {
  const rows = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if ((r.type === 'user' || r.type === 'assistant') && !r.isSidechain) rows.push(r); } catch { /* not a row */ }
  }
  let start = rows.length;
  while (--start >= 0 && !(rows[start].type === 'user' && human(rows[start].message?.content)));
  const turn = rows.slice(start + 1).filter(r => r.type === 'assistant');
  const usedTv = turn.some(r => blocks(r).some(b => b.type === 'tool_use' && /^mcp__tv__/.test(b.name ?? '')));
  const last = turn.at(-1);
  const final = last?.message?.id ? turn.filter(r => r.message?.id === last.message.id) : last ? [last] : [];
  const text = final.flatMap(blocks).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
  return { usedTv, text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (!input.stop_hook_active) {                                   // one rewrite per turn, never a loop
      const { usedTv, text } = lastTurn(readFileSync(input.transcript_path, 'utf8'));
      const problem = usedTv && text ? validate(text) : null;        // dev turns and turns without a final text pass
      if (problem) console.log(JSON.stringify({ decision: 'block', reason: `TV reply rejected: ${problem}. Rewrite your whole message as exactly one JSON object, no code fence, nothing before or after it: ${SHAPE}` }));
    }
  } catch { /* fail open */ }
}
