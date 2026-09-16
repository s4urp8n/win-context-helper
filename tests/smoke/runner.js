const fs = require('node:fs');
const path = require('node:path');
const { buildFlattenFixture, buildLongNamesFixture } = require('./fixtures');
const { explorerCompare } = require('../../src/main/utils/explorer-compare');

const args = process.argv.slice(2);
const onlyPlugin = (args.find((a) => a.startsWith('--plugin=')) || '').slice('--plugin='.length);

const cases = [];

// Preflight, then run the options the confirm dialog would pass for `options`.
async function flatten(dir, options) {
  const FlattenFolder = require('../../plugins/flatten-folder/plugin');
  const plugin = new FlattenFolder();
  const pre = await plugin.preflight({ targets: [dir] });
  const confirm = plugin.buildConfirmMessage({}, pre, options);
  if (!confirm.canContinue) throw new Error('the plan cannot run');
  const result = await plugin.run({ targets: [dir], options: confirm.runOptions, onProgress: () => {} });
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => !e.isFile())) throw new Error('subfolders left behind');
  const names = entries.map((e) => e.name).sort(explorerCompare);
  const contents = names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  return { pre, result, names, contents };
}

function withFixture(build, check) {
  return async () => {
    const dir = build();
    try {
      return await check(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

cases.push({
  id: 'flatten-folder',
  label: 'flatten, plain names',
  run: withFixture(buildFlattenFixture, async (dir) => {
    const { result, names } = await flatten(dir, { keepHierarchy: false });
    const expected = ['1.txt', '2.txt', '3.txt', 'photo (2).jpg', 'photo.jpg'];
    if ([...names].sort().join('|') !== expected.join('|')) throw new Error(`unexpected root entries: ${names.join(', ')}`);
    return { ok: result.ok, summary: `${result.processed} files → ${names.length} in root` };
  }),
});

cases.push({
  id: 'flatten-folder',
  label: 'flatten, hierarchy mixed',
  run: withFixture(buildFlattenFixture, async (dir) => {
    const { result, names } = await flatten(dir, { foldersFirst: false });
    const expected = ['a - 1.txt', 'a - b - 2.txt', 'a - b - c - 3.txt', 'collision - photo.jpg', 'other - photo.jpg'];
    if (names.join('|') !== expected.join('|')) throw new Error(`unexpected root entries: ${names.join(', ')}`);
    return { ok: result.ok, summary: `${result.processed} files → path-prefixed names, no numbers` };
  }),
});

cases.push({
  id: 'flatten-folder',
  label: 'flatten, folders first',
  run: withFixture(buildFlattenFixture, async (dir) => {
    const { pre, result, contents } = await flatten(dir, {});
    if (!pre.variants.tree.folders[0].numbered) throw new Error('expected numbered names');
    if (contents.join('|') !== '3|2|1|A|B') throw new Error(`order broken: ${contents.join('|')}`);
    return { ok: result.ok, summary: `${result.processed} files → numbered, subfolders first` };
  }),
});

cases.push({
  id: 'flatten-folder',
  label: 'flatten, long names',
  run: withFixture(buildLongNamesFixture, async (dir) => {
    const { pre, result, names, contents } = await flatten(dir, {});
    if (pre.variants.tree.totalShortened < 1) throw new Error('preflight expected a shortened name');
    if (names.some((n) => path.join(dir, n).length > 259)) throw new Error('a path is longer than 259 characters');
    if (contents.join('|') !== 'a|deep|e') throw new Error(`order broken: ${contents.join('|')}`);
    return { ok: result.ok, summary: `${result.processed} files, ${pre.variants.tree.totalShortened} name shortened, order kept` };
  }),
});

(async function main() {
  let failures = 0;
  for (const c of cases) {
    if (onlyPlugin && c.id !== onlyPlugin) continue;
    process.stdout.write(`${(c.label || c.id).padEnd(28)} `);
    try {
      const r = await c.run();
      if (r.ok) console.log(`✓ ${r.summary}`);
      else {
        console.log(`✗ ${r.summary || 'failed'}`);
        failures++;
      }
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failures++;
    }
  }
  process.exit(failures === 0 ? 0 : 1);
})();
