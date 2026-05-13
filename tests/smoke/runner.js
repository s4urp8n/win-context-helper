const fs = require('node:fs');
const path = require('node:path');
const { buildFlattenFixture } = require('./fixtures');

const args = process.argv.slice(2);
const onlyPlugin = (args.find((a) => a.startsWith('--plugin=')) || '').slice('--plugin='.length);

const cases = [];

cases.push({
  id: 'flatten-folder',
  async run() {
    const FlattenFolder = require('../../plugins/flatten-folder/plugin');
    const instance = new FlattenFolder();
    const dir = buildFlattenFixture();
    try {
      const pre = await instance.preflight({ targets: [dir] });
      if (typeof pre.totalFiles !== 'number') throw new Error('preflight returned no totalFiles');
      const result = await instance.run({ targets: [dir], options: {}, onProgress: () => {} });
      const rootFiles = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name).sort();
      const subdirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).length;
      if (subdirs !== 0) throw new Error(`expected 0 subdirs, got ${subdirs}`);
      if (rootFiles.length !== 5) throw new Error(`expected 5 root files, got ${rootFiles.length}`);
      return { ok: result.ok, summary: `${result.processed} files → ${rootFiles.length} in root` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
});

(async function main() {
  let failures = 0;
  for (const c of cases) {
    if (onlyPlugin && c.id !== onlyPlugin) continue;
    process.stdout.write(`${c.id.padEnd(28)} `);
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
