const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  readMp3Metadata,
  writeMp3WithMetadata,
  writeMp3StandardMetadata
} = require("../lib/mp3-metadata");

const {
  readWavMetadata,
  writeWavWithMetadata,
  writeWavStandardMetadata
} = require("../lib/wav-metadata");

function padEven(buffer) {
  return buffer.length % 2 === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(1)]);
}

function syncSafeInt(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ]);
}

function mp3Frame(id, data) {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(10);

  header.write(id, 0, 4, "ascii");
  syncSafeInt(payload.length).copy(header, 4);

  return Buffer.concat([header, payload]);
}

function mp3TextFrame(value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function mp3TxxxFrame(description, value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(String(description || ""), "utf8"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function mp3CommentFrame(value, description = "") {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from("eng", "ascii"),
    Buffer.from(String(description || ""), "utf8"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function mp3LyricsFrame(value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from("eng", "ascii"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function mp3ApicFrame() {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from("image/png\0", "latin1"),
    Buffer.from([0x03, 0x00]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  ]);
}

function id3v1Tag() {
  const tag = Buffer.alloc(128);

  tag.write("TAG", 0, 3, "ascii");
  tag.write("V1 Title", 3, "latin1");
  tag.write("V1 Artist", 33, "latin1");
  tag.write("V1 Album", 63, "latin1");
  tag.write("1999", 93, "latin1");
  tag.write("V1 Comment", 97, "latin1");
  tag[125] = 0;
  tag[126] = 7;
  tag[127] = 13;

  return tag;
}

function mp3File(frames) {
  const frameBytes = Buffer.concat(frames);
  const header = Buffer.alloc(10);

  header.write("ID3", 0, 3, "ascii");
  header[3] = 4;
  syncSafeInt(frameBytes.length).copy(header, 6);

  return Buffer.concat([
    header,
    frameBytes,
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    id3v1Tag()
  ]);
}

function wavChunk(id, data) {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(8);

  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);

  return padEven(Buffer.concat([header, payload]));
}

function wavInfoSubchunk(id, value) {
  return wavChunk(
    id,
    Buffer.concat([
      Buffer.from(String(value || ""), "utf8"),
      Buffer.from([0x00])
    ])
  );
}

function wavListChunk(type, children) {
  return wavChunk(
    "LIST",
    Buffer.concat([
      Buffer.from(type, "ascii"),
      ...children
    ])
  );
}

function fixedText(text, length) {
  const out = Buffer.alloc(length);

  Buffer.from(String(text || ""), "utf8").copy(out);

  return out;
}

function bextChunkData() {
  return Buffer.concat([
    fixedText("Broadcast description", 256),
    fixedText("originator", 32),
    fixedText("ref-1", 32),
    fixedText("2026-07-08", 10),
    fixedText("12:34:56", 8),
    Buffer.alloc(8),
    Buffer.alloc(64),
    Buffer.alloc(190),
    Buffer.from("A=PCM,F=48000,W=16,M=stereo,T=test", "utf8")
  ]);
}

function wavFile(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);

  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WAVE", 8, 4, "ascii");

  return Buffer.concat([header, body]);
}

function getWavChunkData(buffer, chunkId) {
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;

    if (id === chunkId) {
      return buffer.subarray(dataStart, dataEnd);
    }

    offset = dataEnd + (size % 2);
  }

  return null;
}

function additionalLabels(metadata) {
  return (metadata.additionalData || []).map(item => item.label);
}

function requireLabels(metadata, labels, context) {
  const present = additionalLabels(metadata);

  for (const label of labels) {
    assert(
      present.includes(label),
      `${context} should include Additional Data label ${label}`
    );
  }
}

function rejectLabels(metadata, labels, context) {
  const present = additionalLabels(metadata);

  for (const label of labels) {
    assert(
      !present.includes(label),
      `${context} should not include Additional Data label ${label}`
    );
  }
}

async function testMp3AdditionalDataAndPreservation(tmpDir) {
  const source = path.join(tmpDir, "source.mp3");
  const removeArtOut = path.join(tmpDir, "remove-art.mp3");
  const standardOut = path.join(tmpDir, "standard.mp3");
  const removeAdditionalOut = path.join(tmpDir, "remove-additional.mp3");
  const removeEpicOut = path.join(tmpDir, "remove-epic.mp3");
  const writeEpicOut = path.join(tmpDir, "write-epic.mp3");

  await fs.writeFile(source, mp3File([
    mp3Frame("TIT2", mp3TextFrame("Avery")),
    mp3Frame("TPE1", mp3TextFrame("kozzality")),
    mp3Frame("COMM", mp3CommentFrame("made with suno")),
    mp3Frame("COMM", mp3CommentFrame("secondary comment", "vendor-note")),
    mp3Frame("WOAS", Buffer.from("https://suno.com/song/957c50cb-378f-460a-8387-0d87411f5f9c", "latin1")),
    mp3Frame("USLT", mp3LyricsFrame("lyrics payload")),
    mp3Frame("TXXX", mp3TxxxFrame("EPICX", "project payload")),
    mp3Frame("TXXX", mp3TxxxFrame("VendorField", "vendor payload")),
    mp3Frame("PRIV", Buffer.from("owner@example.com\0private payload", "utf8")),
    mp3Frame("APIC", mp3ApicFrame())
  ]));

  const sourceMetadata = await readMp3Metadata({ path: source });

  requireLabels(sourceMetadata, [
    "Comment: eng: vendor-note",
    "Official Audio Source",
    "Lyrics: eng",
    "Custom Text: VendorField",
    "PRIV: owner@example.com",
    "ID3v1"
  ], "MP3 source");
  rejectLabels(sourceMetadata, [
    "TIT2",
    "TPE1",
    "Comment: eng",
    "Picture",
    "Custom Text: EPIC",
    "Custom Text: EPICX"
  ], "MP3 source");

  const editableLabels = sourceMetadata.additionalData
    .filter(item => item.editable)
    .map(item => item.label);

  assert(editableLabels.includes("Official Audio Source"));
  assert(editableLabels.includes("Lyrics: eng"));
  assert(editableLabels.includes("Custom Text: VendorField"));

  const removableLabels = sourceMetadata.additionalData
    .filter(item => item.removable)
    .map(item => item.label);

  assert(removableLabels.includes("Official Audio Source"));
  assert(removableLabels.includes("Lyrics: eng"));
  assert(removableLabels.includes("Custom Text: VendorField"));

  await writeMp3WithMetadata({
    sourceAudioPath: source,
    outputPath: removeArtOut,
    metadata: { removeAlbumArt: true }
  });

  const removeArtMetadata = await readMp3Metadata({ path: removeArtOut });

  assert.strictEqual(Boolean(removeArtMetadata.albumArt), false);
  assert.strictEqual(removeArtMetadata.epicx, "project payload");
  requireLabels(removeArtMetadata, [
    "Comment: eng: vendor-note",
    "Official Audio Source",
    "Lyrics: eng",
    "Custom Text: VendorField",
    "PRIV: owner@example.com",
    "ID3v1"
  ], "MP3 artwork removal");

  await writeMp3StandardMetadata({
    sourceAudioPath: source,
    outputPath: standardOut,
    fields: {
      title: "New title",
      artist: "New artist",
      comment: "New comment"
    }
  });

  const standardMetadata = await readMp3Metadata({ path: standardOut });

  assert.strictEqual(Boolean(standardMetadata.albumArt), true);
  assert.strictEqual(standardMetadata.epicx, "project payload");
  assert.strictEqual(standardMetadata.mp3Tags.title, "New title");
  assert.strictEqual(standardMetadata.mp3Tags.comment, "New comment");
  requireLabels(standardMetadata, [
    "Comment: eng: vendor-note",
    "Official Audio Source",
    "Lyrics: eng",
    "Custom Text: VendorField",
    "PRIV: owner@example.com",
    "ID3v1"
  ], "MP3 standard write");

  const sourceUrlFrame = sourceMetadata.editableId3Frames
    .find(frame => frame.label === "Official Audio Source");

  await writeMp3StandardMetadata({
    sourceAudioPath: source,
    outputPath: removeAdditionalOut,
    fields: {
      title: "New title",
      artist: "New artist",
      comment: "New comment",
      id3Frames: [{
        ...sourceUrlFrame,
        value: ""
      }]
    }
  });

  const removeAdditionalMetadata = await readMp3Metadata({ path: removeAdditionalOut });

  rejectLabels(removeAdditionalMetadata, [
    "Official Audio Source"
  ], "MP3 additional data removal");
  requireLabels(removeAdditionalMetadata, [
    "Comment: eng: vendor-note",
    "Lyrics: eng",
    "Custom Text: VendorField",
    "PRIV: owner@example.com",
    "ID3v1"
  ], "MP3 additional data removal");
  assert.strictEqual(Boolean(removeAdditionalMetadata.albumArt), true);
  assert.strictEqual(removeAdditionalMetadata.epicx, "project payload");

  await writeMp3WithMetadata({
    sourceAudioPath: source,
    outputPath: removeEpicOut,
    metadata: { epicx: "" }
  });

  const removeEpicMetadata = await readMp3Metadata({ path: removeEpicOut });

  assert.strictEqual(String(removeEpicMetadata.epicx || ""), "");
  rejectLabels(removeEpicMetadata, [
    "Custom Text: EPIC",
    "Custom Text: EPICX"
  ], "MP3 EPIC removal");
  requireLabels(removeEpicMetadata, [
    "Comment: eng: vendor-note",
    "Official Audio Source",
    "Lyrics: eng",
    "Custom Text: VendorField",
    "PRIV: owner@example.com",
    "ID3v1"
  ], "MP3 EPIC removal");
  assert.strictEqual(Boolean(removeEpicMetadata.albumArt), true);

  await writeMp3WithMetadata({
    sourceAudioPath: source,
    outputPath: writeEpicOut,
    metadata: { epicx: "updated project payload" }
  });

  const writeEpicBuffer = await fs.readFile(writeEpicOut);
  const writeEpicMetadata = await readMp3Metadata({ path: writeEpicOut });

  assert.strictEqual(writeEpicMetadata.epicx, "updated project payload");
  assert(
    writeEpicBuffer.includes(Buffer.from("\x03EPIC\x00updated project payload", "utf8")),
    "MP3 should write project payload as TXXX:EPIC"
  );
  assert(
    !writeEpicBuffer.includes(Buffer.from("\x03EPICX\x00", "utf8")),
    "MP3 should not write the legacy TXXX:EPICX label"
  );
}

async function testWavAdditionalDataAndPreservation(tmpDir) {
  const source = path.join(tmpDir, "source.wav");
  const standardOut = path.join(tmpDir, "standard.wav");
  const artOut = path.join(tmpDir, "art.wav");
  const removeEpicOut = path.join(tmpDir, "remove-epic.wav");
  const writeEpicOut = path.join(tmpDir, "write-epic.wav");

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt32LE(176400, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);

  await fs.writeFile(source, wavFile([
    wavChunk("fmt ", fmt),
    wavListChunk("INFO", [
      wavInfoSubchunk("INAM", "Original title"),
      wavInfoSubchunk("ICMT", "Original comment"),
      wavInfoSubchunk("ISFT", "Lavf60.16.100"),
      wavInfoSubchunk("ZZZZ", "Vendor-specific field")
    ]),
    wavListChunk("adtl", [
      wavChunk("labl", Buffer.from("marker label\0", "utf8"))
    ]),
    wavChunk("bext", bextChunkData()),
    wavChunk("iXML", Buffer.from("<BWFXML><PROJECT>Demo</PROJECT></BWFXML>", "utf8")),
    wavChunk("XMP ", Buffer.from("<x:xmpmeta>demo</x:xmpmeta>", "utf8")),
    wavChunk("ID3 ", Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "binary")),
    wavChunk("ABCD", Buffer.from("Readable vendor blob", "utf8")),
    wavChunk("EPIC", Buffer.from(JSON.stringify({
      epicx: "project payload",
      timestamp: "fixed"
    }), "utf8")),
    wavChunk("ARTW", Buffer.from(JSON.stringify({
      albumArtMime: "image/png",
      albumArt: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    }), "utf8")),
    wavChunk("data", Buffer.alloc(16, 7))
  ]));

  const sourceMetadata = await readWavMetadata({ path: source });

  requireLabels(sourceMetadata, [
    "LIST/INFO",
    "LIST/adtl",
    "Broadcast WAV (bext)",
    "iXML",
    "XMP",
    "ID3-in-WAV",
    "ABCD"
  ], "WAV source");
  rejectLabels(sourceMetadata, [
    "Album Art",
    "EPIC",
    "fmt",
    "data"
  ], "WAV source");

  const info = sourceMetadata.additionalData.find(item => item.label === "LIST/INFO");
  const infoChildren = (info?.children || []).map(child => child.label);

  assert(infoChildren.includes("ZZZZ"));
  assert(!infoChildren.includes("INAM"));
  assert(!infoChildren.includes("ICMT"));
  assert(!infoChildren.includes("ISFT"));
  assert.strictEqual(sourceMetadata.listInfo.ISFT, "Lavf60.16.100");

  await writeWavStandardMetadata({
    sourceAudioPath: source,
    outputPath: standardOut,
    fields: {
      title: "New title",
      artist: "New artist",
      comment: "New comment"
    }
  });

  const standardMetadata = await readWavMetadata({ path: standardOut });
  const standardInfo = standardMetadata.additionalData.find(item => item.label === "LIST/INFO");

  assert(
    (standardInfo?.children || []).some(child => child.label === "ZZZZ"),
    "WAV standard write should preserve non-standard INFO fields"
  );
  assert.strictEqual(standardMetadata.listInfo.ISFT, "Lavf60.16.100");
  requireLabels(standardMetadata, [
    "LIST/adtl",
    "Broadcast WAV (bext)",
    "iXML",
    "XMP",
    "ID3-in-WAV",
    "ABCD"
  ], "WAV standard write");

  await writeWavWithMetadata({
    sourceAudioPath: source,
    outputPath: artOut,
    metadata: {
      albumArt: {
        mimeType: "image/png",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64")
      }
    }
  });

  const artMetadata = await readWavMetadata({ path: artOut });

  assert.strictEqual(artMetadata.epicx, "project payload");
  requireLabels(artMetadata, [
    "LIST/INFO",
    "LIST/adtl",
    "Broadcast WAV (bext)",
    "iXML",
    "XMP",
    "ID3-in-WAV",
    "ABCD"
  ], "WAV artwork write");

  await writeWavWithMetadata({
    sourceAudioPath: source,
    outputPath: removeEpicOut,
    metadata: { epicx: "" }
  });

  const removeEpicMetadata = await readWavMetadata({ path: removeEpicOut });

  assert.strictEqual(String(removeEpicMetadata.epicx || ""), "");
  requireLabels(removeEpicMetadata, [
    "LIST/INFO",
    "LIST/adtl",
    "Broadcast WAV (bext)",
    "iXML",
    "XMP",
    "ID3-in-WAV",
    "ABCD"
  ], "WAV EPIC removal");
  rejectLabels(removeEpicMetadata, [
    "EPIC",
    "Album Art",
    "fmt",
    "data"
  ], "WAV EPIC removal");
  assert.strictEqual(Boolean(removeEpicMetadata.albumArt), true);

  await writeWavWithMetadata({
    sourceAudioPath: source,
    outputPath: writeEpicOut,
    metadata: { epicx: "updated project payload" }
  });

  const writeEpicBuffer = await fs.readFile(writeEpicOut);
  const writeEpicChunk = getWavChunkData(writeEpicBuffer, "EPIC");
  const writeEpicMetadata = await readWavMetadata({ path: writeEpicOut });

  assert.strictEqual(writeEpicMetadata.epicx, "updated project payload");
  assert.strictEqual(writeEpicChunk.toString("utf8"), "updated project payload");
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "emw-metadata-"));

  await testMp3AdditionalDataAndPreservation(tmpDir);
  await testWavAdditionalDataAndPreservation(tmpDir);

  console.log("metadata preservation tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
