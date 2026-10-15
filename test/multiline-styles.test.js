const assert = require('node:assert/strict');
const { parseEpicText } = require('../lib/epic-parser');
(async () => {
  for (const body of ['[Verse]\nLyrics', '1\n00:01.000\n[Verse]\nLyrics']) {
    const text = '---\nTitle: Test\nAuthor: Test\n\n[Generation]\nStyles:\n1. Ambient\n  Warm pads\n2. Keep this numbered instruction in the first style\n\n2. Techno\nDriving drums\n\nUseStyle: 2\n---\n\n' + body;
    const result = await parseEpicText(text);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const styles = result.document.header.generation.fields.Styles;
    assert.equal(styles.options.length, 2);
    assert.equal(styles.options[0].value, 'Ambient\n  Warm pads\n2. Keep this numbered instruction in the first style');
    assert.equal(styles.options[1].value, 'Techno\nDriving drums');
    const again = await parseEpicText(result.roundtrip);
    assert.equal(again.ok, true, JSON.stringify(again.issues));
    assert.deepEqual(again.document.header.generation.fields, result.document.header.generation.fields);
  }
  console.log('Writer multiline style validation and roundtrip checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
