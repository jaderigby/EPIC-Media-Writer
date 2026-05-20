import { LineCursor } from "./cursor.js";
import { parseEpicBody } from "./epic.js";
import { parseEpicxBody } from "./epicx.js";
import { parseHeader } from "./header.js";
import { splitLines } from "./utils.js";
import { validateDocument } from "./validate.js";

export function parseDocument(text, options = {}) {
  const cursor = new LineCursor(splitLines(text));
  const issues = [];

  const headerResult = parseHeader(cursor);
  issues.push(...headerResult.issues);

  const format = options.format || detectFormat(cursor);
  const bodyResult = format === "epicx" ? parseEpicxBody(cursor) : parseEpicBody(cursor);
  issues.push(...bodyResult.issues);

  const authorship = deriveAuthorship(headerResult.header);

  const document = {
    type: "EpicDocument",
    format,
    header: headerResult.header,
    authorship,
    body: bodyResult.body,
  };

  if (options.validate !== false) {
    issues.push(...validateDocument(document));
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    document,
    issues,
  };
}

function detectFormat(cursor) {
  let offset = 0;
  while (true) {
    const line = cursor.peek(offset);
    if (line === null) break;

    const trimmed = line.trim();
    if (trimmed === "") {
      offset += 1;
      continue;
    }

    return /^\d+$/.test(trimmed) ? "epicx" : "epic";
  }

  return "epic";
}

function deriveAuthorship(header) {
  if (!header) {
    return {
      candidates: [],
      primary: null,
    };
  }

  const authorshipKeys = new Set(["Creator", "Author", "Artist"]);
  const candidates = [];

  for (const key of header.rawOrder || []) {
    if (!authorshipKeys.has(key)) continue;

    const value = header.fields?.[key];
    if (value === undefined || String(value).trim() === "") continue;

    candidates.push({
      role: key,
      value,
    });
  }

  return {
    candidates,
    primary: candidates.length > 0 ? candidates[0] : null,
  };
}