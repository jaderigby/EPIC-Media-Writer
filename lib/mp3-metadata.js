const fs = require("fs/promises");

const EPIC_TXXX_DESCRIPTION = "EPICX";

function readSyncSafeInt(buffer, offset) {
  return (
    (buffer[offset] << 21) |
    (buffer[offset + 1] << 14) |
    (buffer[offset + 2] << 7) |
    buffer[offset + 3]
  );
}

function writeSyncSafeInt(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ]);
}

function readFrameSize(buffer, offset, majorVersion) {
  if (majorVersion === 4) {
    return readSyncSafeInt(buffer, offset);
  }

  return buffer.readUInt32BE(offset);
}

function writeFrameSize(size, majorVersion) {
  if (majorVersion === 4) {
    return writeSyncSafeInt(size);
  }

  const out = Buffer.alloc(4);
  out.writeUInt32BE(size, 0);
  return out;
}

function decodeTextFrame(data) {
  if (!data || data.length === 0) return "";

  const encoding = data[0];
  const body = data.subarray(1);

  if (encoding === 0x03) {
    return body.toString("utf8").replace(/\0+$/, "");
  }

  if (encoding === 0x00) {
    return body.toString("latin1").replace(/\0+$/, "");
  }

  if (encoding === 0x01 || encoding === 0x02) {
    return body.toString("utf16le").replace(/\0+$/, "");
  }

  return body.toString("utf8").replace(/\0+$/, "");
}

function encodeTextFrame(value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function decodeTxxxFrame(data) {
  if (!data || data.length === 0) {
    return { description: "", value: "" };
  }

  const encoding = data[0];
  const body = data.subarray(1);

  if (encoding !== 0x03) {
    const text = decodeTextFrame(data);
    const parts = text.split("\0");
    return {
      description: parts[0] || "",
      value: parts.slice(1).join("\0")
    };
  }

  const nul = body.indexOf(0x00);

  if (nul === -1) {
    return {
      description: body.toString("utf8"),
      value: ""
    };
  }

  return {
    description: body.subarray(0, nul).toString("utf8"),
    value: body.subarray(nul + 1).toString("utf8")
  };
}

function encodeTxxxFrame(description, value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(description, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function parseId3(buffer) {
  if (buffer.toString("ascii", 0, 3) !== "ID3") {
    return {
      hasId3: false,
      majorVersion: 4,
      tagStart: 0,
      tagEnd: 0,
      frames: []
    };
  }

  const majorVersion = buffer[3];
  const tagSize = readSyncSafeInt(buffer, 6);
  const tagStart = 10;
  const tagEnd = 10 + tagSize;
  const frames = [];

  let offset = tagStart;

  while (offset + 10 <= tagEnd) {
    const id = buffer.toString("ascii", offset, offset + 4);

    if (!/^[A-Z0-9]{4}$/.test(id)) {
      break;
    }

    const size = readFrameSize(buffer, offset + 4, majorVersion);
    const flags = buffer.subarray(offset + 8, offset + 10);
    const dataStart = offset + 10;
    const dataEnd = dataStart + size;

    if (size <= 0 || dataEnd > tagEnd) {
      break;
    }

    frames.push({
      id,
      size,
      flags,
      data: buffer.subarray(dataStart, dataEnd)
    });

    offset = dataEnd;
  }

  return {
    hasId3: true,
    majorVersion,
    tagStart,
    tagEnd,
    frames
  };
}

function buildFrame(frame, majorVersion) {
  const header = Buffer.alloc(10);

  header.write(frame.id, 0, 4, "ascii");
  writeFrameSize(frame.data.length, majorVersion).copy(header, 4);

  if (frame.flags) {
    frame.flags.copy(header, 8, 0, 2);
  }

  return Buffer.concat([header, frame.data]);
}

function readStandardTags(frames) {
  const tags = {};

  for (const frame of frames) {
    if (frame.id === "TIT2") tags.title = decodeTextFrame(frame.data);
    if (frame.id === "TPE1") tags.artist = decodeTextFrame(frame.data);
    if (frame.id === "TALB") tags.album = decodeTextFrame(frame.data);
    if (frame.id === "TRCK") tags.track = decodeTextFrame(frame.data);
    if (frame.id === "TDRC") tags.year = decodeTextFrame(frame.data);
    if (frame.id === "TYER") tags.year = decodeTextFrame(frame.data);
    if (frame.id === "TCON") tags.genre = decodeTextFrame(frame.data);
  }

  return tags;
}

function decodeApicFrame(data) {
  if (!data || data.length < 2) return null;

  const encoding = data[0];
  let offset = 1;

  // Read MIME type (null-terminated string in latin1)
  let mimeEnd = offset;
  while (mimeEnd < data.length && data[mimeEnd] !== 0) {
    mimeEnd++;
  }
  const mimeType = data.toString("latin1", offset, mimeEnd);
  offset = mimeEnd + 1;

  if (offset >= data.length) return null;

  // Picture type
  const pictureType = data[offset];
  offset++;

  if (offset >= data.length) return null;

  // Description (null-terminated string, encoding depends on encoding byte)
  let descEnd = offset;
  if (encoding === 0) {
    while (descEnd < data.length && data[descEnd] !== 0) {
      descEnd++;
    }
    descEnd++;
  } else if (encoding === 1 || encoding === 2) {
    while (descEnd + 1 < data.length && (data[descEnd] !== 0 || data[descEnd + 1] !== 0)) {
      descEnd += 2;
    }
    descEnd += 2;
  } else {
    while (descEnd < data.length && data[descEnd] !== 0) {
      descEnd++;
    }
    descEnd++;
  }

  // Picture data
  const pictureData = data.subarray(descEnd);

  if (pictureData.length === 0) return null;

  return {
    mimeType,
    pictureType,
    data: Buffer.from(pictureData).toString("base64")
  };
}

async function readMp3Metadata({ path }) {
  const buffer = await fs.readFile(path);
  const id3 = parseId3(buffer);

  let epicx = "";
  const txxxFrames = [];
  let albumArtInfo = null;

  for (const frame of id3.frames) {
    if (frame.id === "TXXX") {
      const txxx = decodeTxxxFrame(frame.data);
      txxxFrames.push(txxx);

      if (txxx.description === EPIC_TXXX_DESCRIPTION) {
        epicx = txxx.value;
      }
    }

    if (frame.id === "APIC" && !albumArtInfo) {
      albumArtInfo = decodeApicFrame(frame.data);
    }
  }

  return {
    format: "mp3",
    id3: {
      present: id3.hasId3,
      version: id3.hasId3 ? `2.${id3.majorVersion}` : "none",
      frameCount: id3.frames.length
    },
    mp3Tags: readStandardTags(id3.frames),
    txxxFrames,
    epicx,
    epicxFrame: epicx ? "TXXX:EPICX" : "",
    albumArtInfo,
    albumArtMime: albumArtInfo?.mimeType || "",
    albumArt: albumArtInfo?.data || ""
  };
}

async function writeMp3WithMetadata({
  sourceAudioPath,
  outputPath,
  metadata
}) {
  const buffer = await fs.readFile(sourceAudioPath);
  const id3 = parseId3(buffer);

  const majorVersion = id3.hasId3
    ? id3.majorVersion
    : 4;

  const audioData = id3.hasId3
    ? buffer.subarray(id3.tagEnd)
    : buffer;

  const epicx = String(metadata?.epicx || "");
  const shouldWriteEpic = epicx.trim().length > 0;

  const keptFrames = id3.frames.filter((frame) => {
    if (frame.id !== "TXXX") return true;

    const txxx = decodeTxxxFrame(frame.data);
    return txxx.description !== EPIC_TXXX_DESCRIPTION;
  });

  if (shouldWriteEpic) {
    keptFrames.push({
      id: "TXXX",
      flags: Buffer.alloc(2),
      data: encodeTxxxFrame(
        EPIC_TXXX_DESCRIPTION,
        epicx
      )
    });
  }

  const frameBytes = Buffer.concat(
    keptFrames.map(frame => buildFrame(frame, majorVersion))
  );

  const header = Buffer.alloc(10);
  header.write("ID3", 0, 3, "ascii");
  header[3] = majorVersion;
  header[4] = 0;
  header[5] = 0;
  writeSyncSafeInt(frameBytes.length).copy(header, 6);

  await fs.writeFile(
    outputPath,
    Buffer.concat([header, frameBytes, audioData])
  );
}

const STANDARD_FRAME_MAP = {
  title: "TIT2",
  artist: "TPE1",
  album: "TALB",
  track: "TRCK",
  year: "TDRC",
  genre: "TCON",
  comment: "COMM"
};

function encodeCommentFrame(value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from("eng", "ascii"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

async function writeMp3StandardMetadata({
  sourceAudioPath,
  outputPath,
  fields
}) {
  const buffer = await fs.readFile(sourceAudioPath);
  const id3 = parseId3(buffer);

  const majorVersion = id3.hasId3 ? id3.majorVersion : 4;
  const audioData = id3.hasId3 ? buffer.subarray(id3.tagEnd) : buffer;

  const standardFrameIds = new Set(Object.values(STANDARD_FRAME_MAP));

  const keptFrames = id3.frames.filter(frame => {
    return !standardFrameIds.has(frame.id);
  });

  for (const [field, frameId] of Object.entries(STANDARD_FRAME_MAP)) {
    const value = String(fields?.[field] || "");

    if (!value.trim()) continue;

    keptFrames.push({
      id: frameId,
      flags: Buffer.alloc(2),
      data: frameId === "COMM"
        ? encodeCommentFrame(value)
        : encodeTextFrame(value)
    });
  }

  const frameBytes = Buffer.concat(
    keptFrames.map(frame => buildFrame(frame, majorVersion))
  );

  const header = Buffer.alloc(10);
  header.write("ID3", 0, 3, "ascii");
  header[3] = majorVersion;
  header[4] = 0;
  header[5] = 0;
  writeSyncSafeInt(frameBytes.length).copy(header, 6);

  await fs.writeFile(
    outputPath,
    Buffer.concat([header, frameBytes, audioData])
  );
}

module.exports = {
  readMp3Metadata,
  writeMp3WithMetadata,
  writeMp3StandardMetadata
};