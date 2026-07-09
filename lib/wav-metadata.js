const fs = require("fs/promises");

const EPIC_CHUNK_ID = "EPIC";
const ARTW_CHUNK_ID = "ARTW";

function padEven(buffer) {
  return buffer.length % 2 === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(1)]);
}

function detectImageMimeType(buffer) {
  if (!buffer || buffer.length < 8) return "application/octet-stream";

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  if (
    buffer[0] === 0x42 &&
    buffer[1] === 0x4d
  ) {
    return "image/bmp";
  }

  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return "application/octet-stream";
}

function parseArtwChunk(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const asText = buffer.toString("utf8").trim();

  // Data URL wrapper
  const dataUrlMatch = asText.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    const data = Buffer.from(dataUrlMatch[2].replace(/\s+/g, ""), "base64");
    const mimeType = dataUrlMatch[1].toLowerCase();
    if (detectImageMimeType(data).startsWith("image/")) {
      return { mimeType, data };
    }
  }

  // JSON wrapper
  if (asText.startsWith("{") && asText.endsWith("}")) {
    try {
      const parsed = JSON.parse(asText);
      if (parsed && typeof parsed === "object") {
        if (parsed.mimeType && parsed.data) {
          const inner = Buffer.from(String(parsed.data || ""), "base64");
          if (inner.length > 0 && detectImageMimeType(inner).startsWith("image/")) {
            return { mimeType: String(parsed.mimeType), data: inner };
          }
        }
        if (parsed.albumArtMime && parsed.albumArt) {
          const inner = Buffer.from(String(parsed.albumArt || ""), "base64");
          if (inner.length > 0 && detectImageMimeType(inner).startsWith("image/")) {
            return { mimeType: String(parsed.albumArtMime), data: inner };
          }
        }
        if (parsed.dataUrl && typeof parsed.dataUrl === "string") {
          const match = parsed.dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
          if (match) {
            const inner = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
            return { mimeType: match[1].toLowerCase(), data: inner };
          }
        }
      }
    } catch {
      // ignore JSON parse failures
    }
  }

  // MIME label prefix + raw image bytes
  const nulIndex = buffer.indexOf(0);
  if (nulIndex > 0 && nulIndex < 128) {
    const header = buffer.toString("ascii", 0, nulIndex).trim();
    const rest = buffer.subarray(nulIndex + 1);

    if (/^image\/[a-z0-9.+-]+$/i.test(header)) {
      if (detectImageMimeType(rest).startsWith("image/")) {
        return { mimeType: header, data: rest };
      }
    }
  }

  // Base64 string chunk
  const base64Only = asText.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64Only)) {
    const decoded = Buffer.from(base64Only, "base64");
    const detected = detectImageMimeType(decoded);
    if (detected.startsWith("image/")) {
      return { mimeType: detected, data: decoded };
    }
  }

  // Raw image bytes
  const mimeType = detectImageMimeType(buffer);
  if (mimeType.startsWith("image/")) {
    return { mimeType, data: buffer };
  }

  return null;
}

function readRiffChunkRecords(buffer) {
  const records = [];
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataEnd = offset + 8 + size;
    const chunkEnd = dataEnd + (size % 2);

    if (dataEnd > buffer.length || chunkEnd > buffer.length) break;

    records.push({
      id,
      size,
      dataStart: offset + 8,
      bytes: Buffer.from(buffer.subarray(offset, chunkEnd))
    });

    if (chunkEnd <= offset) break;
    offset = chunkEnd;
  }

  return records;
}

function countChunkRecords(buffer, shouldIgnoreRecord) {
  const counts = new Map();

  for (const record of readRiffChunkRecords(buffer)) {
    if (shouldIgnoreRecord(record)) continue;

    const key = `${record.id}:${record.bytes.toString("base64")}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

function assertUnrelatedChunksPreserved(before, after, shouldIgnoreRecord) {
  const beforeCounts = countChunkRecords(before, shouldIgnoreRecord);
  const afterCounts = countChunkRecords(after, shouldIgnoreRecord);

  if (beforeCounts.size !== afterCounts.size) {
    throw new Error("WAV metadata preservation check failed: unrelated chunk set changed.");
  }

  for (const [key, count] of beforeCounts.entries()) {
    if (afterCounts.get(key) !== count) {
      throw new Error("WAV metadata preservation check failed: unrelated chunk data changed.");
    }
  }
}

function isListInfoRecord(record) {
  return (
    record.id === "LIST" &&
    record.bytes.toString("ascii", 8, 12) === "INFO"
  );
}

function parseListInfoChunk(buffer, start, size) {
  const result = {};
  const listType = buffer.toString("ascii", start, start + 4);
  result._type = listType;

  if (listType !== "INFO") return result;

  let offset = start + 4;
  const end = start + size;

  while (offset + 8 <= end) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const fieldSize = buffer.readUInt32LE(offset + 4);

    const valueStart = offset + 8;
    const valueEnd = valueStart + fieldSize;

    if (valueEnd > end) break;

    result[id] = buffer
      .toString("utf8", valueStart, valueEnd)
      .replace(/\0+$/, "");

    offset = valueEnd + (fieldSize % 2);
  }

  return result;
}

function truncateMetadataValue(value, maxLength = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength - 3)}...`;
}

function readNullTerminatedText(buffer, start, end) {
  return buffer
    .toString("utf8", start, end)
    .replace(/\0+$/, "")
    .trim();
}

function isMostlyText(buffer) {
  if (!buffer || buffer.length === 0) return false;

  let printable = 0;
  const sampleLength = Math.min(buffer.length, 512);

  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];

    if (
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e) ||
      byte >= 0x80
    ) {
      printable++;
    }
  }

  return printable / sampleLength > 0.85;
}

function parseBextChunk(data) {
  if (!data || data.length < 602) return null;

  return {
    description: readNullTerminatedText(data, 0, 256),
    originator: readNullTerminatedText(data, 256, 288),
    originatorReference: readNullTerminatedText(data, 288, 320),
    originationDate: readNullTerminatedText(data, 320, 330),
    originationTime: readNullTerminatedText(data, 330, 338),
    codingHistory: readNullTerminatedText(data, 602, data.length)
  };
}

function summarizeListChunk(buffer, dataStart, size) {
  const parsed = parseListInfoChunk(buffer, dataStart, size);
  const listType = parsed._type || "";

  if (listType !== "INFO") {
    return {
      label: `LIST/${listType || "unknown"}`,
      value: `${size} bytes`
    };
  }

  const entries = Object.entries(parsed)
    .filter(([key, value]) => key !== "_type" && String(value || "").trim())
    .map(([key, value]) => `${key}: ${truncateMetadataValue(value)}`);

  return {
    label: "LIST/INFO",
    value: entries.length ? entries.join("\n") : `${size} bytes`
  };
}

function summarizeWavChunk(buffer, chunk) {
  const dataStart = chunk.offset + 8;
  const dataEnd = dataStart + chunk.size;
  const data = buffer.subarray(dataStart, dataEnd);

  if (chunk.id === "LIST") {
    return summarizeListChunk(buffer, dataStart, chunk.size);
  }

  if (chunk.id === "bext") {
    const bext = parseBextChunk(data);

    if (bext) {
      const entries = Object.entries(bext)
        .filter(([, value]) => String(value || "").trim())
        .map(([key, value]) => `${key}: ${truncateMetadataValue(value)}`);

      return {
        label: "Broadcast WAV (bext)",
        value: entries.length ? entries.join("\n") : `${chunk.size} bytes`
      };
    }
  }

  if (chunk.id === "iXML" || chunk.id === "XMP ") {
    return {
      label: chunk.id.trim(),
      value: truncateMetadataValue(data.toString("utf8"))
    };
  }

  if (chunk.id === EPIC_CHUNK_ID) {
    return {
      label: "EPIC",
      value: truncateMetadataValue(data.toString("utf8"))
    };
  }

  if (chunk.id === ARTW_CHUNK_ID) {
    const art = parseArtwChunk(data);

    return {
      label: "Album Art",
      value: art
        ? `${art.mimeType} (${art.data.length} bytes)`
        : `${chunk.size} bytes`
    };
  }

  if (chunk.id === "ID3 " || chunk.id === "id3 ") {
    return {
      label: "ID3",
      value: `${chunk.size} bytes`
    };
  }

  if (isMostlyText(data)) {
    return {
      label: chunk.id.trim() || chunk.id,
      value: truncateMetadataValue(data.toString("utf8"))
    };
  }

  return {
    label: chunk.id.trim() || chunk.id,
    value: `${chunk.size} bytes`
  };
}

async function readWavMetadata({ path }) {
  const buffer = await fs.readFile(path);

  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF file.");
  }

  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }

  let offset = 12;
  const wavChunks = [];
  let epicMetadata = {};
  let listInfo = null;
  const listInfoChunks = [];
  let albumArtInfo = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size % 2);

    wavChunks.push({ id, size, offset });

    if (id === "LIST") {
      const parsedList = parseListInfoChunk(buffer, dataStart, size);

      if (parsedList._type === "INFO") {
        listInfo = {
          ...(listInfo || {}),
          ...parsedList
        };
        listInfoChunks.push(parsedList);
      }
    }

    if (id === EPIC_CHUNK_ID) {
      const raw = buffer.toString("utf8", dataStart, dataEnd);

      try {
        epicMetadata = JSON.parse(raw);
      } catch (err) {
        epicMetadata = {
          epicx: raw,
          epicChunkParseError: err.message || String(err)
        };
      }

      epicMetadata.rawEpicChunk = raw;
      epicMetadata.epicxChunkSize = size;
    }

    if (id === ARTW_CHUNK_ID && !albumArtInfo) {
      const chunkData = buffer.subarray(dataStart, dataEnd);
      const art = parseArtwChunk(chunkData);

      if (art) {
        albumArtInfo = {
          mimeType: art.mimeType,
          data: art.data.toString("base64"),
          size
        };
      }
    }

    if (chunkEnd <= offset) break;
    offset = chunkEnd;
  }

  return {
    format: "wav",
    ...epicMetadata,
    listInfo,
    listInfoChunks,
    wavChunks,
    wavMetadataDetails: wavChunks.map(chunk => summarizeWavChunk(buffer, chunk)),
    albumArtInfo,
    albumArtMime: albumArtInfo?.mimeType || "",
    albumArt: albumArtInfo?.data || ""
  };
}

async function writeWavWithMetadata({
  sourceAudioPath,
  outputPath,
  metadata
}) {
  const buffer = await fs.readFile(sourceAudioPath);

  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF file.");
  }

  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }

  const shouldConsiderEpic = Object.prototype.hasOwnProperty.call(metadata || {}, "epicx");
  const epicx = String(metadata?.epicx || "");
  const shouldWriteEpic = epicx.trim().length > 0;
  const albumArt = metadata?.albumArt;
  const albumArtBytes = albumArt?.data
    ? Buffer.from(albumArt.data, "base64")
    : null;
  const shouldWriteArt = Boolean(
    albumArtBytes &&
    String(albumArt?.mimeType || "").startsWith("image/")
  );

  const epicObject = {
    epicx,
    timestamp: metadata?.timestamp || new Date().toISOString()
  };

  const epicData = Buffer.from(
    JSON.stringify(epicObject, null, 2),
    "utf8"
  );

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write(EPIC_CHUNK_ID, 0, 4, "ascii");
  chunkHeader.writeUInt32LE(epicData.length, 4);

  const epicChunk = padEven(Buffer.concat([chunkHeader, epicData]));

  let artChunk = null;

  if (shouldWriteArt) {
    const artPayload = Buffer.from(
      JSON.stringify({
        albumArtMime: albumArt.mimeType,
        albumArt: albumArt.data
      }),
      "utf8"
    );

    const artHeader = Buffer.alloc(8);
    artHeader.write(ARTW_CHUNK_ID, 0, 4, "ascii");
    artHeader.writeUInt32LE(artPayload.length, 4);

    artChunk = padEven(Buffer.concat([artHeader, artPayload]));
  }

  const chunks = [];

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size % 2);

    if (id === EPIC_CHUNK_ID && shouldConsiderEpic && shouldWriteEpic) {
      offset = chunkEnd;
      continue;
    }

    if (id === ARTW_CHUNK_ID && (shouldWriteArt || metadata?.removeAlbumArt)) {
      offset = chunkEnd;
      continue;
    }

    chunks.push(buffer.subarray(offset, chunkEnd));

    if (chunkEnd <= offset) break;
    offset = chunkEnd;
  }

  const body = Buffer.concat([
    ...chunks,
    ...(shouldWriteEpic ? [epicChunk] : []),
    ...(shouldWriteArt ? [artChunk] : [])
  ]);

  const out = Buffer.alloc(12);
  out.write("RIFF", 0, 4, "ascii");
  out.writeUInt32LE(body.length + 4, 4);
  out.write("WAVE", 8, 4, "ascii");

  const outputBuffer = Buffer.concat([out, body]);
  const changedChunkIds = [];

  if (shouldConsiderEpic && shouldWriteEpic) {
    changedChunkIds.push(EPIC_CHUNK_ID);
  }

  if (shouldWriteArt || metadata?.removeAlbumArt) {
    changedChunkIds.push(ARTW_CHUNK_ID);
  }

  const changedChunkIdSet = new Set(changedChunkIds);

  assertUnrelatedChunksPreserved(
    buffer,
    outputBuffer,
    record => changedChunkIdSet.has(record.id)
  );

  await fs.writeFile(outputPath, outputBuffer);
}

const WAV_INFO_MAP = {
  title: "INAM",
  artist: "IART",
  album: "IPRD",
  track: "ITRK",
  year: "ICRD",
  genre: "IGNR",
  comment: "ICMT"
};

function createInfoSubchunk(id, value) {
  const text = Buffer.from(String(value || ""), "utf8");
  const nul = Buffer.from([0x00]);

  const data = padEven(Buffer.concat([text, nul]));

  const header = Buffer.alloc(8);

  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(text.length + 1, 4);

  return Buffer.concat([header, data]);
}

function readInfoSubchunks(buffer, start, size) {
  const listType = buffer.toString("ascii", start, start + 4);
  const subchunks = [];

  if (listType !== "INFO") return subchunks;

  let offset = start + 4;
  const end = start + size;

  while (offset + 8 <= end) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const fieldSize = buffer.readUInt32LE(offset + 4);
    const valueStart = offset + 8;
    const valueEnd = valueStart + fieldSize;
    const chunkEnd = valueEnd + (fieldSize % 2);

    if (valueEnd > end || chunkEnd > end) break;

    subchunks.push({
      id,
      data: Buffer.from(buffer.subarray(valueStart, valueEnd))
    });

    offset = chunkEnd;
  }

  return subchunks;
}

function createInfoSubchunkFromData(id, data) {
  const payload = Buffer.from(data || Buffer.alloc(0));
  const header = Buffer.alloc(8);

  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);

  return Buffer.concat([
    header,
    padEven(payload)
  ]);
}

function createListInfoChunkFromSubchunks(subchunks) {
  if (!subchunks.length) return null;

  const infoBody = Buffer.concat([
    Buffer.from("INFO", "ascii"),
    ...subchunks.map(subchunk => {
      if (subchunk.data) {
        return createInfoSubchunkFromData(subchunk.id, subchunk.data);
      }

      return createInfoSubchunk(subchunk.id, subchunk.value);
    })
  ]);

  const header = Buffer.alloc(8);

  header.write("LIST", 0, 4, "ascii");
  header.writeUInt32LE(infoBody.length, 4);

  return padEven(
    Buffer.concat([header, infoBody])
  );
}

function createListInfoChunk(fields) {
  const subchunks = [];

  for (const [field, chunkId] of Object.entries(WAV_INFO_MAP)) {
    const value = String(fields?.[field] || "");

    if (!value.trim()) continue;

    subchunks.push({
      id: chunkId,
      value
    });
  }

  return createListInfoChunkFromSubchunks(subchunks);
}

async function writeWavStandardMetadata({
  sourceAudioPath,
  outputPath,
  fields
}) {
  const buffer = await fs.readFile(sourceAudioPath);

  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF file.");
  }

  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }

  const chunks = [];
  const standardChunkIds = new Set(Object.values(WAV_INFO_MAP));
  const preservedInfoSubchunks = [];

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size % 2);

    if (id === "LIST") {
      const listType = buffer.toString(
        "ascii",
        dataStart,
        dataStart + 4
      );

      if (listType === "INFO") {
        preservedInfoSubchunks.push(
          ...readInfoSubchunks(buffer, dataStart, size)
            .filter(subchunk => !standardChunkIds.has(subchunk.id))
        );
        offset = chunkEnd;
        continue;
      }
    }

    chunks.push(
      buffer.subarray(offset, chunkEnd)
    );

    if (chunkEnd <= offset) break;
    offset = chunkEnd;
  }

  const standardListChunk = createListInfoChunk(fields);
  const standardSubchunks = standardListChunk
    ? readInfoSubchunks(standardListChunk, 8, standardListChunk.readUInt32LE(4))
    : [];
  const listChunk = createListInfoChunkFromSubchunks([
    ...preservedInfoSubchunks,
    ...standardSubchunks
  ]);

  const body = Buffer.concat([
    ...chunks,
    ...(listChunk ? [listChunk] : [])
  ]);

  const out = Buffer.alloc(12);

  out.write("RIFF", 0, 4, "ascii");
  out.writeUInt32LE(body.length + 4, 4);
  out.write("WAVE", 8, 4, "ascii");

  const outputBuffer = Buffer.concat([out, body]);

  assertUnrelatedChunksPreserved(
    buffer,
    outputBuffer,
    isListInfoRecord
  );

  await fs.writeFile(
    outputPath,
    outputBuffer
  );
}

module.exports = {
  readWavMetadata,
  writeWavWithMetadata,
  writeWavStandardMetadata
};
