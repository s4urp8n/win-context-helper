// Explorer sorts file names with StrCmpLogicalW: case-insensitive, digit runs by value, and
// its own order of punctuation ("X.mp4" before "X_en.vtt"). The function is called through
// koffi; where that is impossible, an ICU comparison with hyphens and apostrophes removed
// comes close but differs for some punctuation and emoji.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const withoutHyphens = (name) => name.replace(/['’-]/g, '');
const approximateCompare = (a, b) => collator.compare(withoutHyphens(a), withoutHyphens(b));

function loadWindowsCompare(loadKoffi = () => require('koffi'), platform = process.platform) {
  if (platform !== 'win32') return null;
  try {
    const shlwapi = loadKoffi().load('shlwapi.dll');
    return shlwapi.func('__stdcall', 'StrCmpLogicalW', 'int', ['str16', 'str16']);
  } catch {
    return null;
  }
}

const pickCompare = (windowsCompare) => windowsCompare || approximateCompare;

module.exports = {
  explorerCompare: pickCompare(loadWindowsCompare()),
  approximateCompare,
  loadWindowsCompare,
  pickCompare,
};
