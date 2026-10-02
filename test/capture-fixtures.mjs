#!/usr/bin/env node
// Capture real youtubei.js renderer nodes as JSON fixtures for test/toItem.test.mjs.
// Re-run when YouTube changes its layout: node test/capture-fixtures.mjs
import { Innertube } from 'youtubei.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const cookieFile = `${homedir()}/.config/tv-agent/cookie.txt`;
const cookie = process.env.YT_COOKIE || (existsSync(cookieFile) ? readFileSync(cookieFile, 'utf8').trim() : undefined);
const yt = await Innertube.create({ lang: 'en', location: 'US', retrieve_player: false, generate_session_locally: true, enable_session_cache: false, cookie });
const save = (name, node) => { writeFileSync(`test/fixtures/${name}.json`, JSON.stringify(node, null, 1)); console.log(name, node?.type); };

const s = await yt.search('lofi hip hop', { type: 'video' });
save('search-video', s.videos.find(v => v.type === 'Video' || v.type === 'LockupView'));
if (cookie) {
  const h = await yt.getHomeFeed();
  const rich = h.contents?.contents?.find(c => c.type === 'RichItem' && c.content?.type === 'LockupView' && c.content.content_type === 'VIDEO');
  if (rich) save('home-richitem-lockup', rich);
  const short = h.contents?.contents?.find(c => c.type === 'RichItem' && c.content?.content_type === 'SHORT');
  if (short) save('home-richitem-short', short);
  const hi = await yt.getHistory();
  const shortNode = [...hi.videos, ...(h.videos ?? [])].find(v => v.type === 'ShortsLockupView' || v.type === 'ReelItem');
  if (shortNode) save('shorts-lockup', shortNode);
}
