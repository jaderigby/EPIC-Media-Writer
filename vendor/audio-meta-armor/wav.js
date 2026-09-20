'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function records(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 ||
      buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Invalid RIFF/WAVE file');
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('Invalid WAV size; refusing to rewrite this file');
  const result = [];
  for (let offset = 12; offset < buffer.length;) {
    if (offset + 8 > buffer.length) throw new Error('Truncated WAV chunk');
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const next = dataStart + size + size % 2;
    if (next > buffer.length) throw new Error('Truncated WAV chunk');
    result.push({ id: buffer.toString('latin1', offset, offset + 4), size, offset, dataStart,
      data: buffer.subarray(dataStart, dataStart + size), bytes: buffer.subarray(offset, next) });
    offset = next;
  }
  return result;
}

// Permission applies to both original and resulting records. Default: change nothing.
function assertUnrelatedChunksPreserved(before, after, allowed = () => false) {
  const permitted = allowed instanceof Set ? record => allowed.has(record.id) : allowed;
  if (typeof permitted !== 'function') throw new TypeError('Expected a chunk predicate or Set of IDs');
  const retained = buffer => records(buffer).filter(record => !permitted(record));
  const original = retained(before);
  const output = retained(after);
  if (original.length !== output.length || original.some((record, i) => !record.bytes.equals(output[i].bytes))) {
    throw new Error('WAV metadata preservation check failed; refusing to save');
  }
}

// Output construction stays with the caller; this boundary enforces its permissions.
async function writeVerified({ sourceAudioPath, outputPath, before, after, allowed }) {
  assertUnrelatedChunksPreserved(before, after, allowed);
  const sourceStat = await fs.stat(sourceAudioPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temp = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temp, 'wx', sourceStat.mode & 0o777);
    created = true;
    try {
      await handle.writeFile(after);
      await handle.chmod(sourceStat.mode & 0o777);
      await handle.sync();
    } finally { await handle.close(); }
    if (!(await fs.readFile(temp)).equals(after)) throw new Error('WAV write verification failed');
    if (!(await fs.readFile(sourceAudioPath)).equals(before)) {
      throw new Error('Source WAV changed during save; refusing to overwrite newer data');
    }
    await fs.rename(temp, outputPath);
  } finally {
    if (created) await fs.rm(temp, { force: true });
  }
}

module.exports = { records, assertUnrelatedChunksPreserved, writeVerified };
