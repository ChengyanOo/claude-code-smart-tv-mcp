#!/usr/bin/env node
// Smoke test: spawn the server over stdio and call tools. Usage: node smoke.mjs [tool] [json-args]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: process.env }));
const [tool, args] = process.argv.slice(2);
const call = async (name, a = {}) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: a });
  const text = r.content?.[0]?.text ?? '';
  console.log(`\n== ${name} ${JSON.stringify(a)} [${Date.now() - t0}ms]${r.isError ? ' ERROR' : ''}\n${text.slice(0, 1500)}`);
};
if (tool) await call(tool, args ? JSON.parse(args) : {});
else {
  console.log((await c.listTools()).tools.map(t => t.name).join(', '));
  await call('yt_search', { query: 'nvidia earnings', upload_date: 'week', prioritize: 'popularity', limit: 3 });
  await call('yt_channel', { channel: '@bloomberg', query: 'fed rate', limit: 3 });
  await call('yt_video', { id: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', include: ['related', 'transcript', 'description'], max_chars: 300 });
  await call('yt_feed', { source: 'explore', limit: 4 });
  await call('profile_get');
  await call('yt_feed', { source: 'home', limit: 3 });
}
await c.close();
