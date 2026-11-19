// Pre-publish scrub: fail if any word on your private list appears in the
// source OR in the built bundle.
//
//   npm run build && npm run scrub
//
// Why check dist/ too: identifiers survive minification. A method named
// after a client, or a label drawn onto a canvas, ends up in the public
// JavaScript even if no "string" in your config mentions it.
//
// Put your own words in scrub-words.txt (one per line, # for comments).
// That file is git-ignored on purpose — a list of your secrets is itself
// a secret. Run this before every deploy and every push.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'private']);
const TEXT = /\.(js|mjs|css|html|json|md|txt|toml|example|yml|yaml)$/i;

let words = [];
try {
  words = (await readFile(join(ROOT, 'scrub-words.txt'), 'utf8'))
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
} catch {
  console.log('scrub: no scrub-words.txt — create one with a private word per line.');
  process.exit(0);
}
if (!words.length) {
  console.log('scrub: scrub-words.txt is empty — nothing to check.');
  process.exit(0);
}

async function* walk(dir) {
  for (const name of await readdir(dir)) {
    if (SKIP_DIRS.has(name) || name === 'scrub-words.txt') continue;
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) yield* walk(p);
    else if (TEXT.test(name) || name.startsWith('Dockerfile')) yield p;
  }
}

let hits = 0;
for await (const file of walk(ROOT)) {
  const lower = (await readFile(file, 'utf8')).toLowerCase();
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase());
    if (i === -1) continue;
    hits += 1;
    const line = lower.slice(0, i).split('\n').length;
    console.log(`LEAK  "${w}"  ${relative(ROOT, file)}:${line}`);
  }
}
if (hits) {
  console.log(`\nscrub: ${hits} hit(s) — fix them before you publish.`);
  process.exit(1);
}
console.log(`scrub: clean (${words.length} word(s) checked against source and dist).`);
