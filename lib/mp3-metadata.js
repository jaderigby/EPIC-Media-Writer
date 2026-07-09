const fs = require("fs/promises");

const EPIC_TXXX_DESCRIPTION = "EPIC";
const LEGACY_EPIC_TXXX_DESCRIPTION = "EPICX";

const ID3_FRAME_LABELS = {
  WOAF: "Official Audio File URL",
  WOAR: "Official Artist URL",
  WOAS: "Official Audio Source",
  WORS: "Official Radio Station URL",
  WPAY: "Payment URL",
  WPUB: "Publisher URL"
};

const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge",
  "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B",
  "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska",
  "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop",
  "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental",
  "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "AlternRock",
  "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
  "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial",
  "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy",
  "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
  "Native American", "Cabaret", "New Wave", "Psychadelic", "Rave",
  "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz",
  "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock"
];

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
  if (majorVersion === 2) {
    return (
      (buffer[offset] << 16) |
      (buffer[offset + 1] << 8) |
      buffer[offset + 2]
    );
  }

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

function decodeUrlFrame(data) {
  if (!data || data.length === 0) return "";

  return data.toString("latin1").replace(/\0+$/, "");
}

function encodeUrlFrame(value) {
  return Buffer.from(String(value || ""), "latin1");
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

function splitTextFrameParts(data) {
  if (!data || data.length === 0) return [];

  const encoding = data[0];
  const body = data.subarray(1);

  if (encoding === 0x01 || encoding === 0x02) {
    return body
      .toString("utf16le")
      .replace(/\0+$/, "")
      .split("\0");
  }

  const textEncoding = encoding === 0x00 ? "latin1" : "utf8";

  return body
    .toString(textEncoding)
    .replace(/\0+$/, "")
    .split("\0");
}

function decodeCommentFrame(data) {
  if (!data || data.length < 4) {
    return { language: "", description: "", text: "" };
  }

  const encoding = data[0];
  const language = data.toString("ascii", 1, 4);
  const body = data.subarray(4);
  const isUtf16 = encoding === 0x01 || encoding === 0x02;
  const textEncoding = encoding === 0x00 ? "latin1" : isUtf16 ? "utf16le" : "utf8";
  let separator = -1;
  let separatorLength = 1;

  if (isUtf16) {
    separatorLength = 2;

    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0x00 && body[i + 1] === 0x00) {
        separator = i;
        break;
      }
    }
  } else {
    separator = body.indexOf(0x00);
  }

  if (separator === -1) {
    return {
      language,
      description: "",
      text: body.toString(textEncoding).replace(/\0+$/, "")
    };
  }

  return {
    language,
    description: body.subarray(0, separator).toString(textEncoding).replace(/\0+$/, ""),
    text: body.subarray(separator + separatorLength).toString(textEncoding).replace(/\0+$/, "")
  };
}

function decodeLanguageTextFrame(data) {
  if (!data || data.length < 4) {
    return { language: "", description: "", text: "" };
  }

  const encoding = data[0];
  const language = data.toString("ascii", 1, 4);
  const body = data.subarray(4);
  const isUtf16 = encoding === 0x01 || encoding === 0x02;
  const textEncoding = encoding === 0x00 ? "latin1" : isUtf16 ? "utf16le" : "utf8";
  let separator = -1;
  let separatorLength = 1;

  if (isUtf16) {
    separatorLength = 2;

    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0x00 && body[i + 1] === 0x00) {
        separator = i;
        break;
      }
    }
  } else {
    separator = body.indexOf(0x00);
  }

  if (separator === -1) {
    return {
      language,
      description: "",
      text: body.toString(textEncoding).replace(/\0+$/, "")
    };
  }

  return {
    language,
    description: body.subarray(0, separator).toString(textEncoding).replace(/\0+$/, ""),
    text: body.subarray(separator + separatorLength).toString(textEncoding).replace(/\0+$/, "")
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

function encodeLanguageTextFrame({ language = "eng", description = "", value = "" }) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(String(language || "eng").slice(0, 3).padEnd(3, " "), "ascii"),
    Buffer.from(String(description || ""), "utf8"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "utf8")
  ]);
}

function decodeWxxxFrame(data) {
  const parts = splitTextFrameParts(data);

  return {
    description: parts[0] || "",
    value: parts.slice(1).join(" ")
  };
}

function encodeWxxxFrame(description, value) {
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(description, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(String(value || ""), "latin1")
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
  const flags = buffer[5];
  const tagSize = readSyncSafeInt(buffer, 6);
  const tagStart = 10;
  const tagEnd = Math.min(buffer.length, 10 + tagSize);
  const frames = [];

  let offset = tagStart;

  if ((flags & 0x40) !== 0 && offset + 4 <= tagEnd) {
    const extendedHeaderSize = majorVersion === 4
      ? readSyncSafeInt(buffer, offset)
      : buffer.readUInt32BE(offset);
    const skipSize = majorVersion === 4
      ? extendedHeaderSize
      : extendedHeaderSize + 4;

    if (skipSize > 0 && offset + skipSize <= tagEnd) {
      offset += skipSize;
    }
  }

  const frameHeaderSize = majorVersion === 2 ? 6 : 10;

  while (offset + frameHeaderSize <= tagEnd) {
    const idLength = majorVersion === 2 ? 3 : 4;
    const id = buffer.toString("ascii", offset, offset + idLength);

    if (!/^[A-Z0-9]{3,4}$/.test(id)) {
      break;
    }

    const size = readFrameSize(buffer, offset + idLength, majorVersion);
    const frameFlags = majorVersion === 2
      ? Buffer.alloc(2)
      : buffer.subarray(offset + 8, offset + 10);
    const dataStart = offset + frameHeaderSize;
    const dataEnd = dataStart + size;

    if (size <= 0 || dataEnd > tagEnd) {
      break;
    }

    frames.push({
      id,
      size,
      flags: frameFlags,
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

function decodeId3v1Text(buffer, start, end) {
  return buffer
    .toString("latin1", start, end)
    .replace(/\0+$/, "")
    .trim();
}

function parseId3v1(buffer) {
  if (!buffer || buffer.length < 128) return null;

  const start = buffer.length - 128;

  if (buffer.toString("ascii", start, start + 3) !== "TAG") return null;

  const track = buffer[start + 125] === 0 && buffer[start + 126] !== 0
    ? String(buffer[start + 126])
    : "";
  const genreIndex = buffer[start + 127];

  return {
    title: decodeId3v1Text(buffer, start + 3, start + 33),
    artist: decodeId3v1Text(buffer, start + 33, start + 63),
    album: decodeId3v1Text(buffer, start + 63, start + 93),
    year: decodeId3v1Text(buffer, start + 93, start + 97),
    comment: decodeId3v1Text(buffer, start + 97, start + (track ? 125 : 127)),
    track,
    genre: ID3V1_GENRES[genreIndex] || (genreIndex === 255 ? "" : String(genreIndex))
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

function getFrameAuditKey(frame, index) {
  if (!frame?.id) return `frame:${index}`;

  if (frame.id === "TXXX" || frame.id === "TXX") {
    const txxx = decodeTxxxFrame(frame.data);
    return `${frame.id}:${txxx.description}`;
  }

  if (frame.id === "WXXX") {
    const wxxx = decodeWxxxFrame(frame.data);
    return `${frame.id}:${wxxx.description}`;
  }

  if (frame.id === "COMM" || frame.id === "COM") {
    const comment = decodeCommentFrame(frame.data);
    return `${frame.id}:${comment.language}:${comment.description}`;
  }

  if (frame.id === "USLT" || frame.id === "ULT") {
    const lyrics = decodeLanguageTextFrame(frame.data);
    return `${frame.id}:${lyrics.language}:${lyrics.description}`;
  }

  return frame.id;
}

function countId3Frames(frames, shouldIgnoreFrame) {
  const counts = new Map();

  frames.forEach((frame, index) => {
    if (shouldIgnoreFrame(frame, index)) return;

    const flags = frame.flags
      ? frame.flags.toString("base64")
      : "";
    const key = [
      getFrameAuditKey(frame, index),
      flags,
      frame.data.toString("base64")
    ].join(":");

    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return counts;
}

function assertUnrelatedId3FramesPreserved(beforeFrames, afterFrames, shouldIgnoreFrame) {
  const beforeCounts = countId3Frames(beforeFrames, shouldIgnoreFrame);
  const afterCounts = countId3Frames(afterFrames, shouldIgnoreFrame);

  if (beforeCounts.size !== afterCounts.size) {
    throw new Error("MP3 metadata preservation check failed: unrelated ID3 frame set changed.");
  }

  for (const [key, count] of beforeCounts.entries()) {
    if (afterCounts.get(key) !== count) {
      throw new Error("MP3 metadata preservation check failed: unrelated ID3 frame data changed.");
    }
  }
}

function getEditableId3FrameKey(frame, index) {
  if (!frame?.id) return "";

  if (frame.id === "TXXX" || frame.id === "TXX") {
    const txxx = decodeTxxxFrame(frame.data);

    return `${index}:${frame.id}:${txxx.description}`;
  }

  if (frame.id === "WXXX") {
    const wxxx = decodeWxxxFrame(frame.data);

    return `${index}:${frame.id}:${wxxx.description}`;
  }

  if (frame.id === "USLT" || frame.id === "ULT") {
    const lyrics = decodeLanguageTextFrame(frame.data);

    return `${index}:${frame.id}:${lyrics.language}:${lyrics.description}`;
  }

  if (/^W[A-Z0-9]{3}$/.test(frame.id)) {
    return `${index}:${frame.id}`;
  }

  return "";
}

function getEditableId3FrameAuditKey(frame) {
  if (!frame?.id) return "";

  if (frame.id === "TXXX" || frame.id === "TXX") {
    const txxx = decodeTxxxFrame(frame.data);
    return `${frame.id}:${txxx.description}`;
  }

  if (frame.id === "WXXX") {
    const wxxx = decodeWxxxFrame(frame.data);
    return `${frame.id}:${wxxx.description}`;
  }

  if (frame.id === "USLT" || frame.id === "ULT") {
    const lyrics = decodeLanguageTextFrame(frame.data);
    return `${frame.id}:${lyrics.language}:${lyrics.description}`;
  }

  if (/^W[A-Z0-9]{3}$/.test(frame.id)) {
    return frame.id;
  }

  return "";
}

function getEditableUpdateAuditKey(update) {
  const id = String(update?.id || "").trim();
  const type = String(update?.type || "").trim();
  const description = String(update?.description || "");
  const language = String(update?.language || "eng");

  if (type === "txxx") return `TXXX:${description}`;
  if (type === "wxxx") return `WXXX:${description}`;
  if (type === "lyrics") return `USLT:${language}:${description}`;
  if (type === "url" && /^W[A-Z0-9]{3}$/.test(id)) return id;

  return "";
}

function readStandardTags(frames) {
  const tags = {};

  for (const frame of frames) {
    if (frame.id === "TIT2" || frame.id === "TT2") tags.title = decodeTextFrame(frame.data);
    if (frame.id === "TPE1" || frame.id === "TP1") tags.artist = decodeTextFrame(frame.data);
    if (frame.id === "TALB" || frame.id === "TAL") tags.album = decodeTextFrame(frame.data);
    if (frame.id === "TRCK" || frame.id === "TRK") tags.track = decodeTextFrame(frame.data);
    if (frame.id === "TDRC") tags.year = decodeTextFrame(frame.data);
    if (frame.id === "TYER" || frame.id === "TYE") tags.year = decodeTextFrame(frame.data);
    if (frame.id === "TCON" || frame.id === "TCO") tags.genre = decodeTextFrame(frame.data);
    if (frame.id === "COMM" || frame.id === "COM") {
      const comment = decodeCommentFrame(frame.data);

      if (!String(comment.description || "").trim()) {
        tags.comment = comment.text;
      }
    }
  }

  return tags;
}

function mergeFallbackTags(primary, fallback) {
  const merged = { ...(primary || {}) };

  for (const [key, value] of Object.entries(fallback || {})) {
    if (!String(merged[key] || "").trim() && String(value || "").trim()) {
      merged[key] = value;
    }
  }

  return merged;
}

function truncateFrameValue(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength - 3)}...`;
}

function summarizeId3Frame(frame) {
  if (!frame?.id) return null;

  if (frame.id === "APIC") {
    const art = decodeApicFrame(frame.data);

    return {
      id: frame.id,
      label: "Picture",
      value: art
        ? `${art.mimeType || "image"} (${art.data.length} base64 chars)`
        : `${frame.size} bytes`
    };
  }

  if (frame.id === "COMM" || frame.id === "COM") {
    const comment = decodeCommentFrame(frame.data);
    const labelParts = [
      "Comment",
      comment.language,
      comment.description
    ].filter(Boolean);

    return {
      id: frame.id,
      label: labelParts.join(": "),
      value: truncateFrameValue(comment.text)
    };
  }

  if (frame.id === "TXXX" || frame.id === "TXX") {
    const txxx = decodeTxxxFrame(frame.data);

    return {
      id: frame.id,
      label: txxx.description ? `Custom Text: ${txxx.description}` : "Custom Text",
      value: truncateFrameValue(txxx.value)
    };
  }

  if (frame.id === "USLT" || frame.id === "ULT") {
    const lyrics = decodeLanguageTextFrame(frame.data);
    const labelParts = [
      "Lyrics",
      lyrics.language,
      lyrics.description
    ].filter(Boolean);

    return {
      id: frame.id,
      label: labelParts.join(": "),
      value: truncateFrameValue(lyrics.text)
    };
  }

  if (/^T[A-Z0-9]{2,3}$/.test(frame.id)) {
    return {
      id: frame.id,
      label: frame.id,
      value: truncateFrameValue(decodeTextFrame(frame.data))
    };
  }

  if (frame.id === "WXXX") {
    const wxxx = decodeWxxxFrame(frame.data);

    return {
      id: frame.id,
      label: wxxx.description ? `Custom URL: ${wxxx.description}` : "Custom URL",
      value: truncateFrameValue(wxxx.value)
    };
  }

  if (/^W[A-Z0-9]{3}$/.test(frame.id)) {
    return {
      id: frame.id,
      label: ID3_FRAME_LABELS[frame.id] || frame.id,
      value: truncateFrameValue(decodeUrlFrame(frame.data))
    };
  }

  if (frame.id === "PRIV" || frame.id === "UFID") {
    const nul = frame.data.indexOf(0x00);
    const owner = nul === -1
      ? ""
      : frame.data.subarray(0, nul).toString("latin1");

    return {
      id: frame.id,
      label: owner ? `${frame.id}: ${owner}` : frame.id,
      value: `${frame.size} bytes`
    };
  }

  return {
    id: frame.id,
    label: frame.id,
    value: `${frame.size} bytes`
  };
}

function makeAdditionalDataItem({
  id,
  label,
  value = "",
  children = [],
  size = 0,
  editable = false,
  removable = false,
  key = ""
}) {
  return {
    id,
    label,
    value,
    children,
    size,
    editable,
    removable,
    key
  };
}

function isStandardMp3Frame(frame) {
  if (!frame?.id) return false;

  const standardTextFrames = new Set([
    "TIT2", "TT2",
    "TPE1", "TP1",
    "TALB", "TAL",
    "TRCK", "TRK",
    "TDRC", "TYER", "TYE",
    "TCON", "TCO"
  ]);

  if (standardTextFrames.has(frame.id)) return true;

  if (frame.id === "COMM" || frame.id === "COM") {
    const comment = decodeCommentFrame(frame.data);

    return !String(comment.description || "").trim();
  }

  return false;
}

function isProjectPayloadFrame(frame) {
  if (!frame || (frame.id !== "TXXX" && frame.id !== "TXX")) return false;

  const txxx = decodeTxxxFrame(frame.data);

  return (
    txxx.description === EPIC_TXXX_DESCRIPTION ||
    txxx.description === LEGACY_EPIC_TXXX_DESCRIPTION
  );
}

function buildMp3AdditionalData(frames, id3v1) {
  const items = [];

  frames.forEach((frame, index) => {
    if (!frame?.id) return;
    if (isStandardMp3Frame(frame)) return;
    if (frame.id === "APIC") return;
    if (isProjectPayloadFrame(frame)) return;

    const summary = summarizeId3Frame(frame);
    if (!summary) return;

    const editableKey = getEditableId3FrameKey(frame, index);

    items.push(makeAdditionalDataItem({
      id: `mp3:id3:${index}:${frame.id}`,
      label: summary.label || frame.id,
      value: summary.value || "",
      size: frame.size,
      editable: Boolean(editableKey),
      removable: Boolean(editableKey),
      key: editableKey
    }));
  });

  const id3v1Children = Object.entries(id3v1 || {})
    .filter(([, value]) => String(value || "").trim())
    .map(([key, value]) => makeAdditionalDataItem({
      id: `mp3:id3v1:${key}`,
      label: key,
      value: truncateFrameValue(value)
    }));

  if (id3v1Children.length) {
    items.push(makeAdditionalDataItem({
      id: "mp3:id3v1",
      label: "ID3v1",
      value: `${id3v1Children.length} field${id3v1Children.length === 1 ? "" : "s"}`,
      children: id3v1Children
    }));
  }

  return items;
}

function getEditableId3Frames(frames) {
  const editable = [];

  frames.forEach((frame, index) => {
    if (frame.id === "TXXX" || frame.id === "TXX") {
      const txxx = decodeTxxxFrame(frame.data);

      if (
        txxx.description === EPIC_TXXX_DESCRIPTION ||
        txxx.description === LEGACY_EPIC_TXXX_DESCRIPTION
      ) return;

      editable.push({
        key: getEditableId3FrameKey(frame, index),
        id: "TXXX",
        type: "txxx",
        label: txxx.description ? `Custom Text: ${txxx.description}` : "Custom Text",
        description: txxx.description || "",
        value: txxx.value || ""
      });
      return;
    }

    if (frame.id === "WXXX") {
      const wxxx = decodeWxxxFrame(frame.data);

      editable.push({
        key: getEditableId3FrameKey(frame, index),
        id: "WXXX",
        type: "wxxx",
        label: wxxx.description ? `Custom URL: ${wxxx.description}` : "Custom URL",
        description: wxxx.description || "",
        value: wxxx.value || ""
      });
      return;
    }

    if (frame.id === "USLT" || frame.id === "ULT") {
      const lyrics = decodeLanguageTextFrame(frame.data);

      editable.push({
        key: getEditableId3FrameKey(frame, index),
        id: "USLT",
        type: "lyrics",
        label: lyrics.language ? `Lyrics: ${lyrics.language}` : "Lyrics",
        description: lyrics.description || "",
        language: lyrics.language || "eng",
        value: lyrics.text || ""
      });
      return;
    }

    if (/^W[A-Z0-9]{3}$/.test(frame.id)) {
      editable.push({
        key: getEditableId3FrameKey(frame, index),
        id: frame.id,
        type: "url",
        label: ID3_FRAME_LABELS[frame.id] || frame.id,
        description: "",
        value: decodeUrlFrame(frame.data)
      });
    }
  });

  return editable;
}

function buildEditableId3Frame(update) {
  const id = String(update?.id || "").trim();
  const type = String(update?.type || "").trim();
  const description = String(update?.description || "");
  const value = String(update?.value || "");

  if (!id || !value.trim()) return null;

  if (type === "txxx") {
    return {
      id: "TXXX",
      flags: Buffer.alloc(2),
      data: encodeTxxxFrame(description, value)
    };
  }

  if (type === "wxxx") {
    return {
      id: "WXXX",
      flags: Buffer.alloc(2),
      data: encodeWxxxFrame(description, value)
    };
  }

  if (type === "lyrics") {
    return {
      id: "USLT",
      flags: Buffer.alloc(2),
      data: encodeLanguageTextFrame({
        language: update?.language || "eng",
        description,
        value
      })
    };
  }

  if (type === "url" && /^W[A-Z0-9]{3}$/.test(id)) {
    return {
      id,
      flags: Buffer.alloc(2),
      data: encodeUrlFrame(value)
    };
  }

  return null;
}

function encodeApicFrame({
  mimeType,
  data,
  pictureType = 3,
  description = ""
}) {
  const imageData = Buffer.from(String(data || ""), "base64");

  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(String(mimeType || "image/jpeg"), "latin1"),
    Buffer.from([0x00]),
    Buffer.from([pictureType]),
    Buffer.from(String(description), "utf8"),
    Buffer.from([0x00]),
    imageData
  ]);
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
  const id3v1 = parseId3v1(buffer);

  let epicx = "";
  const txxxFrames = [];
  let albumArtInfo = null;

  for (const frame of id3.frames) {
    if (frame.id === "TXXX" || frame.id === "TXX") {
      const txxx = decodeTxxxFrame(frame.data);
      txxxFrames.push(txxx);

      if (
        txxx.description === EPIC_TXXX_DESCRIPTION ||
        (
          !epicx &&
          txxx.description === LEGACY_EPIC_TXXX_DESCRIPTION
        )
      ) {
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
      frameCount: id3.frames.length,
      v1Present: Boolean(id3v1)
    },
    mp3Tags: mergeFallbackTags(readStandardTags(id3.frames), id3v1),
    id3Frames: id3.frames
      .map(summarizeId3Frame)
      .filter(Boolean)
      .concat(id3v1
        ? Object.entries(id3v1)
          .filter(([, value]) => String(value || "").trim())
          .map(([key, value]) => ({
            id: "ID3v1",
            label: `ID3v1 ${key}`,
            value: truncateFrameValue(value)
          }))
        : []),
    additionalData: buildMp3AdditionalData(id3.frames, id3v1),
    editableId3Frames: getEditableId3Frames(id3.frames),
    id3v1,
    txxxFrames,
    epicx,
    epicxFrame: epicx ? "TXXX:EPIC" : "",
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

  const majorVersion = id3.hasId3 && id3.majorVersion >= 3
    ? id3.majorVersion
    : 4;

  const audioData = id3.hasId3
    ? buffer.subarray(id3.tagEnd)
    : buffer;

  const shouldConsiderEpic = Object.prototype.hasOwnProperty.call(metadata || {}, "epicx");
  const epicx = String(metadata?.epicx || "");
  const shouldWriteEpic = epicx.trim().length > 0;
  const albumArt = metadata?.albumArt;
  const shouldWriteArt = Boolean(
    albumArt?.data &&
    String(albumArt?.mimeType || "").startsWith("image/")
  );

  const keptFrames = id3.frames.filter((frame) => {
    if (frame.id === "TXXX" || frame.id === "TXX") {
      const txxx = decodeTxxxFrame(frame.data);

      if (
        txxx.description === EPIC_TXXX_DESCRIPTION ||
        txxx.description === LEGACY_EPIC_TXXX_DESCRIPTION
      ) {
        return !shouldConsiderEpic;
      }

      return true;
    }

    if (frame.id === "APIC" && (shouldWriteArt || metadata?.removeAlbumArt)) {
      return false;
    }

    return true;
  });

  if (shouldWriteArt) {
    keptFrames.push({
      id: "APIC",
      flags: Buffer.alloc(2),
      data: encodeApicFrame({
        mimeType: albumArt.mimeType,
        data: albumArt.data,
        pictureType: 3
      })
    });
  }

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

  const outputBuffer = Buffer.concat([header, frameBytes, audioData]);
  const outputId3 = parseId3(outputBuffer);

  assertUnrelatedId3FramesPreserved(
    id3.frames,
    outputId3.frames,
    frame => {
      if (frame.id === "APIC" && (shouldWriteArt || metadata?.removeAlbumArt)) {
        return true;
      }

      if (frame.id === "TXXX" || frame.id === "TXX") {
        const txxx = decodeTxxxFrame(frame.data);
        return (
          (
            txxx.description === EPIC_TXXX_DESCRIPTION ||
            txxx.description === LEGACY_EPIC_TXXX_DESCRIPTION
          ) &&
          shouldConsiderEpic
        );
      }

      return false;
    }
  );

  await fs.writeFile(
    outputPath,
    outputBuffer
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

  const majorVersion = id3.hasId3 && id3.majorVersion >= 3 ? id3.majorVersion : 4;
  const audioData = id3.hasId3 ? buffer.subarray(id3.tagEnd) : buffer;

  const editableUpdates = Array.isArray(fields?.id3Frames)
    ? fields.id3Frames
    : [];
  const editableKeys = new Set(
    editableUpdates
      .map(update => String(update?.key || ""))
      .filter(Boolean)
  );
  const editableAuditKeys = new Set(
    editableUpdates
      .map(getEditableUpdateAuditKey)
      .filter(Boolean)
  );

  const keptFrames = id3.frames.filter((frame, index) => {
    if (isStandardMp3Frame(frame)) return false;

    const editableKey = getEditableId3FrameKey(frame, index);

    return !editableKeys.has(editableKey);
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

  for (const update of editableUpdates) {
    const frame = buildEditableId3Frame(update);

    if (frame) {
      keptFrames.push(frame);
    }
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

  const outputBuffer = Buffer.concat([header, frameBytes, audioData]);
  const outputId3 = parseId3(outputBuffer);

  assertUnrelatedId3FramesPreserved(
    id3.frames,
    outputId3.frames,
    (frame, index) => {
      if (isStandardMp3Frame(frame)) return true;

      const editableKey = getEditableId3FrameKey(frame, index);

      return (
        editableKeys.has(editableKey) ||
        editableAuditKeys.has(getEditableId3FrameAuditKey(frame))
      );
    }
  );

  await fs.writeFile(
    outputPath,
    outputBuffer
  );
}

module.exports = {
  readMp3Metadata,
  writeMp3WithMetadata,
  writeMp3StandardMetadata
};
