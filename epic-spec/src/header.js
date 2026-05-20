import { parseDecimalPercent } from "./decimal.js";
import { parseTimestamp } from "./time.js";
import { makeIssue } from "./utils.js";

const FIELD_RE = /^([A-Za-z]+):\s*(.*)$/;
const AUTHORSHIP_KEYS = new Set(["Creator", "Author", "Artist"]);

export function deriveAuthorship(header) {
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

export function parseHeader(cursor) {
  const issues = [];
  const firstLineNumber = cursor.lineNumber();
  const first = cursor.next();

  if (first === null || first.trim() !== "---") {
    issues.push(makeIssue("MISSING_HEADER_START", "Expected '---' to start header.", firstLineNumber));
    return { header: null, issues };
  }

  const rawOrder = [];
  const fields = {};
  let generation = null;
  let collectingProduction = false;
  let productionLines = [];
  let lastTrimmed = null;

  while (!cursor.eof()) {
    const lineNumber = cursor.lineNumber();
    const line = cursor.next();
    if (line === null) break;

    const trimmed = line.trim();
    const previousTrimmed = lastTrimmed;
    lastTrimmed = trimmed;

    if (trimmed === "---") {
      finalizeProduction();
      return { header: { type: "EpicHeader", rawOrder, fields, generation }, issues };
    }

    if (trimmed === "[Generation]") {
      if (previousTrimmed !== "") {
        issues.push(
          makeIssue(
            "MISSING_GENERATION_SEPARATOR",
            "[Generation] must be preceded by a single empty line.",
            lineNumber,
            "error"
          )
        );
      }

      finalizeProduction();
      rawOrder.push("Generation");

      const parsedGeneration = parseGenerationBlock(cursor);
      generation = parsedGeneration.block;
      issues.push(...parsedGeneration.issues);

      continue;
    }

    const match = line.match(FIELD_RE);

    if (match) {
      finalizeProduction();
      const [, key, value] = match;
      rawOrder.push(key);

      const trimmedValue = value.trim();
      const OPTIONAL_EMPTY_HEADER_FIELDS = new Set(["Production"]);

      if (!OPTIONAL_EMPTY_HEADER_FIELDS.has(key) && trimmedValue === "") {
        issues.push(
          makeIssue(
            "EMPTY_HEADER_VALUE",
            `Header field [ ${key} ] should not be empty.`,
            lineNumber,
            "warning",
            { field: key }
          ),
        );
        fields[key] = value;
        continue;
      }

      if (fields[key] !== undefined) {
        issues.push(makeIssue("DUPLICATE_FIELD", `Duplicate header field [ ${key} ].`, lineNumber));
      }

      if (fields[key] !== undefined) {
        issues.push(
          makeIssue(
            AUTHORSHIP_KEYS.has(key)
              ? "DUPLICATE_AUTHORSHIP_FIELD"
              : "DUPLICATE_FIELD",
            AUTHORSHIP_KEYS.has(key)
              ? `Authorship field [${key}] may not appear more than once.`
              : `Header field [${key}] may not appear more than once.`,
            lineNumber,
            "error",
            { field: key }
          )
        );
      }

      if (AUTHORSHIP_KEYS.has(key) && trimmedValue === "") {
        issues.push(
          makeIssue(
            "EMPTY_AUTHORSHIP_VALUE",
            `Authorship field [${key}] should not be empty.`,
            lineNumber,
            "error",
            { field: key }
          )
        );

        fields[key] = value;
        continue;
      }

      switch (key) {
        case "BPM": {
          const trimmedValue = value.trim();

          if (!/^\d+$/.test(trimmedValue)) {
            issues.push(
              makeIssue(
                "INVALID_BPM",
                `BPM must be an integer. Got [ ${value} ].`,
                lineNumber,
              ),
            );
            fields.BPM = null;
          } else {
            const bpm = Number.parseInt(trimmedValue, 10);

            if (bpm <= 0) {
              issues.push(
                makeIssue(
                  "INVALID_BPM",
                  `BPM must be greater than 0. Got [ ${value} ].`,
                  lineNumber,
                ),
              );
            }

            fields.BPM = bpm;
          }
          break;
        }

        case "Tags":
          fields.Tags = String(value)
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
          break;

        case "Offset": {
          const parsedOffset = parseTimestamp(value, lineNumber);
          fields.Offset = parsedOffset.timestamp;
          issues.push(...parsedOffset.issues);
          break;
        }

        case "Production":
          collectingProduction = true;
          productionLines = value ? [value] : [];
          break;

        default:
          fields[key] = value;
          break;
      }

      continue;
    }

    if (collectingProduction) {
      productionLines.push(line);
      continue;
    }

    if (trimmed !== "") {
      issues.push(makeIssue("UNKNOWN_HEADER_CONTENT", `Unexpected header content [ ${line} ].`, lineNumber));
    }
  }

  finalizeProduction();
  issues.push(makeIssue("MISSING_HEADER_END", "Expected closing '---' for header.", cursor.lineNumber()));
  return { header: { type: "EpicHeader", rawOrder, fields, generation }, issues };

  function finalizeProduction() {
    if (!collectingProduction) return;
    fields.Production = { lines: productionLines, normalized: productionLines.join("\n") };
    collectingProduction = false;
    productionLines = [];
  }
}

function parseGenerationBlock(cursor) {
  const issues = [];
  const rawOrder = [];
  const fields = {};

  while (!cursor.eof()) {
    const lineNumber = cursor.lineNumber();
    const line = cursor.peek();
    if (line === null) break;

    const trimmed = line.trim();
    if (trimmed === "---") break;
    if (trimmed.startsWith("[") && trimmed !== "[Generation]") break;

    cursor.next();
    if (trimmed === "") continue;

    const match = line.match(FIELD_RE);
    if (!match) {
      issues.push(makeIssue("INVALID_GENERATION_FIELD", `Invalid generation field [ ${line} ].`, lineNumber));
      continue;
    }

    const [, key, value] = match;
    rawOrder.push(key);

    const trimmedValue = value.trim();
    const OPTIONAL_EMPTY_GENERATION_FIELDS = new Set(["Styles"]);

    if (!OPTIONAL_EMPTY_GENERATION_FIELDS.has(key) && trimmedValue === "") {
      issues.push(
        makeIssue(
          "EMPTY_GENERATION_VALUE",
          `Generation field [ ${key} ] should not be empty.`,
          lineNumber,
          "warning",
          { field: key }
        ),
      );
      fields[key] = value;
      continue;
    }

    switch (key) {
      case "Styles": {
        const parsedStyles = parseStyles(cursor, value, lineNumber);
        fields.Styles = parsedStyles.styles;
        issues.push(...parsedStyles.issues);
        break;
      }
      case "UseStyle":
        fields.UseStyle = Number.parseInt(value.trim(), 10);
        break;
      case "Persona":
        fields.Persona = value;
        break;
      case "Cover":
        fields.Cover = value;
        break;
      case "VocalGender":
        fields.VocalGender = value;
        break;
      case "Weirdness": {
        const parsed = parseDecimalPercent(value, lineNumber);
        fields.Weirdness = parsed.value;
        issues.push(...parsed.issues);
        break;
      }
      case "StyleInfluence": {
        const parsed = parseDecimalPercent(value, lineNumber);
        fields.StyleInfluence = parsed.value;
        issues.push(...parsed.issues);
        break;
      }
      case "Energy": {
        const parsed = parseDecimalPercent(value, lineNumber);
        fields.Energy = parsed.value;
        issues.push(...parsed.issues);
        break;
      }
      case "TempoHint":
        fields.TempoHint = value;
        break;
      default:
        fields[key] = value;
        issues.push(makeIssue("UNKNOWN_GENERATION_FIELD", `Unknown generation field [ ${key} ].`, lineNumber, "warning"));
        break;
    }
  }

  return { block: { type: "EpicGenerationBlock", rawOrder, fields }, issues };
}

function parseStyles(cursor, firstValue, lineNumber) {
  const issues = [];
  const initial = String(firstValue ?? "");
  const lines = [];

  if (initial.trim() !== "") {
    lines.push(initial);
  }

  const firstNext = cursor.peek();

  // numbered mode only when there is no inline value
  if (lines.length === 0 && firstNext && /^\s*\d+\.\s+/.test(firstNext)) {
    const options = [];

    while (!cursor.eof()) {
      const startLine = cursor.peek();
      if (startLine === null) break;

      const startTrimmed = startLine.trim();
      const startMatch = startTrimmed.match(/^(\d+)\.\s+(.*)$/);
      if (!startMatch) break;

      cursor.next();

      const optionIndex = Number.parseInt(startMatch[1], 10);
      const optionLines = [startMatch[2]];

      while (!cursor.eof()) {
        const nextLine = cursor.peek();
        if (nextLine === null) break;

        const nextTrimmed = nextLine.trim();

        if (nextTrimmed === "---") break;
        if (nextTrimmed.startsWith("[") && nextTrimmed !== "[Generation]") break;
        if (/^[A-Za-z]+:\s*/.test(nextLine)) break;

        if (nextTrimmed === "") {
          cursor.next();

          const afterBlank = cursor.peek();
          if (afterBlank === null) break;

          const afterBlankTrimmed = afterBlank.trim();

          if (/^\d+\.\s+/.test(afterBlankTrimmed)) {
            break;
          }

          optionLines.push("");
          continue;
        }

        optionLines.push(cursor.next());
      }

      options.push({
        index: optionIndex,
        value: optionLines.join("\n"),
        lines: optionLines,
      });
    }

    if (options.length === 0) {
      issues.push(
        makeIssue(
          "EMPTY_STYLES",
          "Styles must not be empty.",
          lineNumber,
        ),
      );
    }

    return {
      styles: {
        mode: "multiple",
        options,
      },
      issues,
    };
  }

  // freeform multiline (with or without inline first value)
  while (!cursor.eof()) {
    const line = cursor.peek();
    if (line === null) break;

    const trimmed = line.trim();

    if (trimmed === "---") break;
    if (trimmed.startsWith("[") && trimmed !== "[Generation]") break;
    if (/^[A-Za-z]+:\s*/.test(line)) break;

    lines.push(cursor.next());
  }

  const value = lines.join("\n");

  if (value.trim() === "") {
    issues.push(
      makeIssue(
        "EMPTY_STYLES",
        "Styles must not be empty.",
        lineNumber,
      ),
    );
  }

  return {
    styles: {
      mode: "single",
      lines,
      value,
    },
    issues,
  };
}

export function stringifyHeader(header) {
  if (!header || !header.fields) return "---\n---";
  const lines = ["---"];

  const push = (key, value) => lines.push(`${key}: ${value}`);

  if (header.fields.Title !== undefined) push("Title", header.fields.Title);

  if (header.fields.Creator !== undefined) push("Creator", header.fields.Creator);
  if (header.fields.Author !== undefined) push("Author", header.fields.Author);
  if (header.fields.Artist !== undefined) push("Artist", header.fields.Artist);

  if (header.fields.BPM !== undefined) push("BPM", header.fields.BPM);
  if (header.fields.Key !== undefined) push("Key", header.fields.Key);
  if (header.fields.TimeSignature !== undefined) push("TimeSignature", header.fields.TimeSignature);
  if (header.fields.Language !== undefined) push("Language", header.fields.Language);
  if (header.fields.Tags !== undefined) push("Tags", Array.isArray(header.fields.Tags) ? header.fields.Tags.join(", ") : header.fields.Tags);
  if (header.fields.Offset !== undefined) push("Offset", header.fields.Offset.raw ?? header.fields.Offset);

  if (header.fields.Production) {
    const prod = header.fields.Production;
    if (prod.lines.length > 0) {
      lines.push(`Production: ${prod.lines[0] ?? ""}`);
      for (let i = 1; i < prod.lines.length; i += 1) lines.push(prod.lines[i]);
    } else {
      lines.push("Production:");
    }
  }

  if (header.fields.Version !== undefined) push("Version", header.fields.Version);
  if (header.fields.EPICVersion !== undefined) push("EPICVersion", header.fields.EPICVersion);

  const g = header.generation?.fields;
  if (g) {
    lines.push("");
    lines.push("[Generation]");
    if (g.Styles) {
      if (g.Styles.mode === "single") {
        lines.push(`Styles: ${g.Styles.value}`);
      } else {
        lines.push("Styles:");
        for (const option of g.Styles.options) lines.push(`${option.index}. ${option.value}`);
      }
    }
    if (g.UseStyle !== undefined) push("UseStyle", g.UseStyle);
    if (g.Persona !== undefined) push("Persona", g.Persona);
    if (g.Cover !== undefined) push("Cover", g.Cover);
    if (g.VocalGender !== undefined) push("VocalGender", g.VocalGender);
    if (g.Weirdness !== undefined) push("Weirdness", g.Weirdness.raw);
    if (g.StyleInfluence !== undefined) push("StyleInfluence", g.StyleInfluence.raw);
    if (g.Energy !== undefined) push("Energy", g.Energy.raw);
    if (g.TempoHint !== undefined) push("TempoHint", g.TempoHint);
  }

  lines.push("---");
  return lines.join("\n");
}
