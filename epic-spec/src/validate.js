import { isValidDecimalPercent } from "./decimal.js";
import { makeIssue } from "./utils.js";

export function validateDocument(document) {
  const issues = [];
  if (!document) return [makeIssue("NO_DOCUMENT", "No document to validate.", 0)];

  issues.push(...validateHeader(document.header));

  if (document.format === "epicx") {
    issues.push(...validateEpicxBody(document.body));
  }

  return issues;
}

function validateHeader(header) {
  const issues = [];
  const authorshipKeys = ["Creator", "Author", "Artist"];

  const candidates = authorshipKeys
    .filter((key) => header.fields[key] !== undefined && String(header.fields[key]).trim() !== "")
    .map((key) => ({ role: key, value: header.fields[key] }));

  if (candidates.length === 0) {
    issues.push(
      makeIssue(
        "MISSING_AUTHORSHIP",
        "Header must include at least one authorship field [Creator | Author | Artist].",
        0,
        "error",
        { requiredAnyOf: authorshipKeys }
      )
    );
  }
  
  if (!header) {
    issues.push(makeIssue("MISSING_HEADER", "Document header is missing.", 0));
    return issues;
  }

  const fields = header.fields || {};
  const rawOrder = header.rawOrder || [];

  if (!fields.Title) issues.push(makeIssue("MISSING_TITLE", "Header must include Title.", 0));
  if (rawOrder[0] !== "Title") issues.push(makeIssue("TITLE_NOT_FIRST", "Title must be the first header field.", 0));

  if (rawOrder.includes("Generation") && rawOrder[rawOrder.length - 1] !== "Generation") {
    issues.push(makeIssue("GENERATION_NOT_LAST", "[Generation] must be the last header subsection.", 0));
  }

  const g = header.generation?.fields;
  if (g) {
    for (const key of ["Weirdness", "StyleInfluence", "Energy"]) {
      if (g[key] && !isValidDecimalPercent(g[key].raw)) {
        issues.push(makeIssue("INVALID_DECIMAL", `${key} is not in a valid lexical form.`, 0));
      }
    }

    if (g.UseStyle !== undefined) {
      if (!g.Styles || g.Styles.mode !== "multiple") {
        issues.push(makeIssue("USESTYLE_WITHOUT_MULTIPLE_STYLES", "UseStyle requires multiple Styles options.", 0));
      } else {
        const valid = g.Styles.options.some((option) => option.index === g.UseStyle);
        if (!valid) issues.push(makeIssue("INVALID_USESTYLE_INDEX", "UseStyle references a missing Styles option.", 0));
      }
    }
  }

  return issues;
}

function validateEpicxBody(body) {
  const issues = [];
  const entries = body?.entries || [];
  const seen = new Set();

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const expected = i + 1;

    if (entry.index !== expected) {
      issues.push(makeIssue("NON_SEQUENTIAL_ENTRY_INDEX", `Entry numbering must start at 1 and increase sequentially. Expected ${expected}, got ${entry.index}.`, entry.loc?.startLine ?? 0));
    }

    if (seen.has(entry.index)) {
      issues.push(makeIssue("DUPLICATE_ENTRY_INDEX", `Duplicate entry index ${entry.index}.`, entry.loc?.startLine ?? 0));
    }
    seen.add(entry.index);

    if (i > 0 && entry.separatorBefore !== 1) {
      issues.push(makeIssue("INVALID_ENTRY_SEPARATOR", "Each .epicx entry must be separated by exactly one empty line.", entry.loc?.startLine ?? 0));
    }

    issues.push(...validateMicroEvents(entry));
  }

  return issues;
}

function validateMicroEvents(entry) {
  const issues = [];
  let lastExplicit = null;
  const rangeStart = entry.anchor.start.seconds;
  const rangeEnd = entry.anchor.kind === "range" ? entry.anchor.end.seconds : null;

  for (const micro of entry.microEvents || []) {
    if (!micro.implicit) {
      if (lastExplicit !== null && micro.time < lastExplicit) {
        issues.push(makeIssue("MICROEVENT_OUT_OF_ORDER", "Explicit micro-event timestamps must be chronological within an entry.", micro.loc?.startLine ?? 0));
      }
      lastExplicit = micro.time;
    }

    if (rangeEnd !== null && (micro.time < rangeStart || micro.time > rangeEnd)) {
      issues.push(makeIssue("MICROEVENT_OUT_OF_RANGE", "Micro-event timestamp must fall within the containing entry range.", micro.loc?.startLine ?? 0));
    }
  }

  return issues;
}
