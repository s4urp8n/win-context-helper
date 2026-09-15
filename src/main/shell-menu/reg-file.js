// Reads and writes the .reg format used by `reg export` / `reg import`.
const HEADER = 'Windows Registry Editor Version 5.00';
const BOM = Buffer.from([0xff, 0xfe]);

const SECTION = /^\[(.+)\]$/;
const VALUE = /^(@|"((?:[^"\\]|\\.)*)")=(.*)$/;
const STRING = /^"((?:[^"\\]|\\.)*)"$/;

const escape = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const unescape = (text) => text.replace(/\\(.)/g, '$1');
const nameToken = (name) => (name === '' ? '@' : `"${escape(name)}"`);

// sets: Map<key, Map<valueName, data>> ('' is the default value; an empty Map only creates the key).
function serialize({ sets = new Map(), deleteValues = new Map(), deleteKeys = [] }) {
  const lines = [HEADER, ''];
  for (const key of deleteKeys) lines.push(`[-${key}]`, '');
  for (const key of new Set([...deleteValues.keys(), ...sets.keys()])) {
    lines.push(`[${key}]`);
    for (const name of deleteValues.get(key) || []) lines.push(`${nameToken(name)}=-`);
    for (const [name, data] of sets.get(key) || []) lines.push(`${nameToken(name)}="${escape(data)}"`);
    lines.push('');
  }
  return lines.join('\r\n');
}

// String data is unescaped; other types (dword:, hex:) are kept as written so they never match a string.
function parse(text) {
  const tree = new Map();
  let values = null;
  // Binary values wrap with a trailing backslash; join them back into one line.
  for (const raw of text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const section = SECTION.exec(line);
    if (section) {
      values = new Map();
      tree.set(section[1], values);
      continue;
    }
    const value = values && VALUE.exec(line);
    if (!value) continue;
    const string = STRING.exec(value[3]);
    values.set(value[1] === '@' ? '' : unescape(value[2]), string ? unescape(string[1]) : value[3]);
  }
  return tree;
}

const encode = (text) => Buffer.concat([BOM, Buffer.from(text, 'utf16le')]);
const decode = (buffer) => buffer.toString('utf16le').replace(/^﻿/, '');

module.exports = { serialize, parse, encode, decode };
