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

    result[id] = buffer
      .toString("utf8", valueStart, valueEnd)
      .replace(/\0+$/, "");

    offset = valueEnd + (fieldSize % 2);
  }

  return result;
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
  let albumArtInfo = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size % 2);

    wavChunks.push({ id, size, offset });

    if (id === "LIST") {
      listInfo = parseListInfoChunk(buffer, dataStart, size);
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
    ...epicMetadata,
    listInfo,
    wavChunks,
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

  const epicx = String(metadata?.epicx || "");
  const shouldWriteEpic = epicx.trim().length > 0;

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
  const chunks = [];

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size % 2);

    if (id !== EPIC_CHUNK_ID) {
      chunks.push(buffer.subarray(offset, chunkEnd));
    }

    if (chunkEnd <= offset) break;
    offset = chunkEnd;
  }

  const body = Buffer.concat(
    shouldWriteEpic
      ? [...chunks, epicChunk]
      : chunks
  );

  const out = Buffer.alloc(12);
  out.write("RIFF", 0, 4, "ascii");
  out.writeUInt32LE(body.length + 4, 4);
  out.write("WAVE", 8, 4, "ascii");

  await fs.writeFile(outputPath, Buffer.concat([out, body]));
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

function createListInfoChunk(fields) {
  const subchunks = [];

  for (const [field, chunkId] of Object.entries(WAV_INFO_MAP)) {
    const value = String(fields?.[field] || "");

    if (!value.trim()) continue;

    subchunks.push(
      createInfoSubchunk(chunkId, value)
    );
  }

  const infoBody = Buffer.concat([
    Buffer.from("INFO", "ascii"),
    ...subchunks
  ]);

  const header = Buffer.alloc(8);

  header.write("LIST", 0, 4, "ascii");
  header.writeUInt32LE(infoBody.length, 4);

  return padEven(
    Buffer.concat([header, infoBody])
  );
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

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size % 2);

    // remove existing LIST/INFO only
    if (id === "LIST") {
      const listType = buffer.toString(
        "ascii",
        dataStart,
        dataStart + 4
      );

      if (listType === "INFO") {
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

  const listChunk = createListInfoChunk(fields);

  const body = Buffer.concat([
    ...chunks,
    listChunk
  ]);

  const out = Buffer.alloc(12);

  out.write("RIFF", 0, 4, "ascii");
  out.writeUInt32LE(body.length + 4, 4);
  out.write("WAVE", 8, 4, "ascii");

  await fs.writeFile(
    outputPath,
    Buffer.concat([out, body])
  );
}

module.exports = {
  readWavMetadata,
  writeWavWithMetadata,
  writeWavStandardMetadata
};