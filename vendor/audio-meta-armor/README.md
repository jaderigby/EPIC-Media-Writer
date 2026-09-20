# audio-meta-armor

An independently maintained, dependency-free Node.js library for verifying
audio metadata preservation and safely writing the verified result.

**Current support: RIFF/WAVE. MP3 support is planned and is not implemented.**
Format-specific APIs live under subpaths such as `audio-meta-armor/wav`; the
package root exposes the same API as `require('audio-meta-armor').wav`.

The WAV implementation treats RIFF chunks as
opaque bytes and has no application or metadata-format dependencies.

Use it when your application changes selected WAV chunks and must retain all
other chunks exactly, including their order, duplicate occurrences, and padding.
The caller constructs the edited WAV; this library checks the permitted changes
and manages verified file replacement.

## Requirements and installation

Node.js 18 or later. CommonJS. No runtime dependencies.

Install from a local package directory:

```sh
npm install /path/to/audio-meta-armor
```

This package is not currently published to a registry. It has its own source repository, version history, tests, and release lifecycle;
consumer applications install or vendor a specific release.

## Usage

```js
const fs = require('node:fs/promises');
const { records, writeVerified } = require('audio-meta-armor/wav');

async function removeCustomChunk(filePath) {
  const before = await fs.readFile(filePath);
  const retained = records(before).filter(record => record.id !== 'DEMO');
  const body = Buffer.concat(retained.map(record => record.bytes));
  const header = Buffer.from(before.subarray(0, 12));
  header.writeUInt32LE(body.length + 4, 4);
  const after = Buffer.concat([header, body]);

  await writeVerified({
    sourceAudioPath: filePath,
    outputPath: filePath,
    before,
    after,
    allowed: new Set(['DEMO'])
  });
}
```

Only `DEMO` chunks may change in this example. Any change to another chunk causes
verification to throw before the destination is replaced. The RIFF size field may
change to match the resulting file. For verification without filesystem access,
call `assertUnrelatedChunksPreserved(before, after, allowed)` directly.

## WAV contract

- `records(buffer)` strictly parses 32-bit RIFF/WAVE framing. IDs are lossless
  Latin-1 strings. Records include bytes, payload, offsets and size. Buffer views
  borrow the input; callers must not mutate the original snapshot.
- `assertUnrelatedChunksPreserved(before, after, allowed)` validates both files
  and compares all unpermitted records in order, byte for byte, including padding
  and duplicate occurrences. `allowed` is a Set of IDs or a predicate receiving
  a record. Omission permits no changes. The predicate applies to both files;
  prefer IDs or payload types rather than offsets, which can shift after edits.
- `writeVerified({sourceAudioPath, outputPath, before, after, allowed})` runs that
  check, writes a unique sibling, preserves POSIX permission bits, syncs and
  verifies the written bytes, checks the source still matches the snapshot, then
  renames over the destination. Failure before rename leaves the destination
  unchanged and cleans up the temporary file.

Callers own metadata interpretation and output construction. There are no
application-specific or metadata-format rules in this package. Authorizing a
container chunk authorizes its entire payload: callers must separately preserve
untargeted nested fields if editing within that container.

## WAV limitations

This validates RIFF framing, not codec semantics or metadata schemas. It rejects
RF64, RIFX, inconsistent lengths, missing padding, and trailing unframed bytes.
Nonzero padding is accepted and preserved. It holds files in memory.

It does not promise preservation of ACLs, extended attributes, ownership, file
timestamps, symlink identity, or hard-link relationships. Rename is atomic on
supported local filesystems; this is not a full power-loss durability guarantee.
The source comparison detects intervening changes but is not an OS file lock;
applications must serialize writes, and another process can race the final
comparison/rename. A distinct output path is overwritten as requested by caller.
No format conversion is performed.

## Development

Run `npm test` from the package directory to exercise preservation, malformed
input rejection, stale-source detection, atomic replacement, and cleanup.
Run `npm pack` to build a portable package archive. Consumers can install that
archive with `npm install /path/to/audio-meta-armor-1.0.0.tgz`.

Changes to the preservation contract should be versioned and accompanied by
regression tests. Application integration and release distribution belong in
consumer repositories, outside this package.
