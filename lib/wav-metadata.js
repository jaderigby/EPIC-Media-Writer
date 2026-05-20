const fs = require("fs/promises");

const EPIC_CHUNK_ID = "EPIC";

function padEven(buffer) {
  return buffer.length % 2 === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(1)]);
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

    if (chunkEnd <= offset) break;
    offset = chunkEnd;
  }

  return {
    ...epicMetadata,
    listInfo,
    wavChunks
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