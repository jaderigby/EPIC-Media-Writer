'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { records, assertUnrelatedChunksPreserved: verify, writeVerified } = require('./wav');
function chunk(id, text, padding = 0) {
  const data = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'latin1'); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2, padding)]);
}
function wav(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.from('RIFF\0\0\0\0WAVE', 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}
assert.equal(require('./').wav, require('./wav'));
const chunks = [chunk('fmt ', 'format'), chunk('data', 'audio'), chunk('JUNK', 'a', 0xa5),
  chunk('JUNK', 'b'), chunk('bext', 'broadcast'), chunk('LIST', 'INFOopaque'),
  chunk('iXML', '<xml/>'), chunk('\xc5PIC', 'opaque'), chunk('TEST', 'old')];
const before = wav(chunks);
const after = wav([...chunks.slice(0, -1), chunk('TEST', 'new')]);
const allowed = new Set(['TEST']);
verify(before, before);
verify(before, after, allowed);
assert.throws(() => verify(before, after), /preservation/);
for (const changed of [chunks.slice(1), [...chunks, chunks[0]], chunks.slice().reverse(),
  chunks.map((c, i) => i === 2 ? chunk('JUNK', 'a', 0) : c)]) {
  assert.throws(() => verify(before, wav(changed), allowed), /preservation/);
}
assert.equal(records(before)[7].id, '\xc5PIC');
const malformed = Buffer.from(before); malformed.writeUInt32LE(0xffffffff, 16);
for (const invalid of [Buffer.alloc(0), before.subarray(0, -1), malformed, wav([Buffer.alloc(3)])]) {
  assert.throws(() => records(invalid), /Invalid|Truncated/);
}
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-meta-armor-'));
  const file = path.join(dir, 'test.wav');
  try {
    await fs.writeFile(file, before, { mode: 0o640 });
    await assert.rejects(writeVerified({ sourceAudioPath: file, outputPath: file, before, after }), /preservation/);
    assert.deepEqual(await fs.readFile(file), before);
    await writeVerified({ sourceAudioPath: file, outputPath: file, before, after, allowed });
    assert.deepEqual(await fs.readFile(file), after);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
    await assert.rejects(writeVerified({ sourceAudioPath: file, outputPath: file, before, after, allowed }), /changed during save/);
    assert.deepEqual(await fs.readFile(file), after);
    assert.deepEqual(await fs.readdir(dir), ['test.wav']);
    // Rename failure must leave the source intact and remove its temporary file.
    const destination = path.join(dir, 'directory'); await fs.mkdir(destination);
    await assert.rejects(writeVerified({ sourceAudioPath: file, outputPath: destination, before: after, after, allowed }));
    assert.deepEqual(await fs.readFile(file), after);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['directory', 'test.wav']);
    console.log('WAV integrity checks passed: opaque chunks, permissions, corruption, stale source, atomic write and cleanup.');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
