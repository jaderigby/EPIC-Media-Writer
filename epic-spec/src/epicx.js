import { findInstructionEnd, parseInstructionBlock, stringifyInstructionBlock } from "./instruction.js";
import { parseSectionLine, stringifySection } from "./section.js";
import { parseAnchor, parseTimestamp, secondsToTimestamp } from "./time.js";
import { makeIssue } from "./utils.js";

const ENTRY_INDEX_RE = /^\d+$/;
const MICRO_TIME_PREFIX_RE = /^(\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}:\d{2}\.\d{3})(?=\s)/;

export function parseEpicxBody(cursor) {
  const issues = [];
  const entries = [];
  let separatorCount = 0;

  while (!cursor.eof()) {
    const line = cursor.peek();
    if (line === null) break;

    if (line.trim() === "") {
      separatorCount += 1;
      cursor.next();
      continue;
    }

    const parsedEntry = parseEpicxEntry(cursor);
    parsedEntry.entry.separatorBefore = separatorCount;
    separatorCount = 0;
    entries.push(parsedEntry.entry);
    issues.push(...parsedEntry.issues);
  }

  return { body: { type: "EpicxBody", entries }, issues };
}

function parseEpicxEntry(cursor) {
  const issues = [];
  const startLine = cursor.lineNumber();

  const indexLineNumber = cursor.lineNumber();
  const indexLine = cursor.next();

  let index = 0;
  if (indexLine === null || !ENTRY_INDEX_RE.test(indexLine.trim())) {
    issues.push(makeIssue("INVALID_ENTRY_INDEX", `Expected numeric entry index, got "${indexLine ?? "EOF"}".`, indexLineNumber));
  } else {
    index = Number.parseInt(indexLine.trim(), 10);
  }

  const anchorLineNumber = cursor.lineNumber();
  const anchorLine = cursor.next();
  const anchorResult = parseAnchor(anchorLine ?? "", anchorLineNumber);
  issues.push(...anchorResult.issues);

  let section = null;
  const maybeSection = cursor.peek();
  if (maybeSection !== null && maybeSection.trim().startsWith("[")) {
    const parsedSection = parseSectionLine(cursor.next(), cursor.lineNumber() - 1);
    section = parsedSection.section;
    issues.push(...parsedSection.issues);
  }

  const payload = [];
  const microEvents = [];
  let currentTextLines = [];

  while (!cursor.eof()) {
    const lineNumber = cursor.lineNumber();
    const line = cursor.peek();
    if (line === null) break;

    const trimmed = line.trim();

    if (trimmed === "") {
      break;
    }

    if (ENTRY_INDEX_RE.test(trimmed)) break;

    if (trimmed.startsWith("@")) {
      flushTextBlock(payload, currentTextLines);
      currentTextLines = [];
      const parsedMicro = parseMicroEvent(cursor.next(), lineNumber, anchorResult.anchor.start.seconds);
      microEvents.push(parsedMicro.microEvent);
      issues.push(...parsedMicro.issues);
      continue;
    }

    const parsedPayload = parsePayloadLine(cursor.next(), lineNumber);
    issues.push(...parsedPayload.issues);

    if (parsedPayload.kind === "instruction") {
      flushTextBlock(payload, currentTextLines);
      currentTextLines = [];
      payload.push({
        type: "TimedPayloadInstruction",
        instruction: parsedPayload.instruction,
        loc: { startLine: lineNumber, endLine: lineNumber },
      });
    } else {
      currentTextLines.push(parsedPayload.line);
    }
  }

  flushTextBlock(payload, currentTextLines);

  if (payload.length === 0 && microEvents.length === 0) {
    issues.push(
      makeIssue(
        "EMPTY_TIMED_ENTRY",
        "Timed entry must contain at least one lyric line, instruction, or micro-event.",
        startLine,
        "error",
        { index }
      )
    );
  }

  return {
    entry: {
      type: "TimedEntry",
      index,
      anchor: anchorResult.anchor,
      section,
      payload,
      microEvents,
      separatorBefore: 0,
      loc: { startLine, endLine: Math.max(startLine, cursor.lineNumber() - 1) },
    },
    issues,
  };
}

function parsePayloadLine(raw, line) {
  const parsed = parseMixedContent(raw, line);

  if (parsed.items.length === 1 && parsed.items[0].type === "instruction") {
    return { kind: "instruction", instruction: parsed.items[0].instruction, issues: parsed.issues };
  }

  const normalized = parsed.items.filter((item) => item.type === "text").map((item) => item.text).join(" ").trim();

  return {
    kind: "text",
    line: {
      raw,
      items: parsed.items,
      normalized,
      loc: { startLine: line, endLine: line },
    },
    issues: parsed.issues,
  };
}

function parseMicroEvent(raw, line, entryStartSeconds) {
  const issues = [];
  const afterAt = raw.slice(1).trimStart();

  let rawTime = null;
  let remainder = afterAt;

  const match = afterAt.match(MICRO_TIME_PREFIX_RE);
  if (match) {
    rawTime = match[1];
    remainder = afterAt.slice(match[0].length).trimStart();
  }

  const parsedItems = parseMixedContent(remainder, line);
  issues.push(...parsedItems.issues);

  const items = parsedItems.items.map((item) =>
    item.type === "instruction"
      ? { type: "MicroEventInstruction", instruction: item.instruction }
      : { type: "MicroEventText", text: item.text }
  );

  let time = entryStartSeconds;
  let implicit = true;

  if (rawTime !== null) {
    const parsedTime = parseTimestamp(rawTime, line);
    issues.push(...parsedTime.issues);
    time = parsedTime.timestamp.seconds;
    implicit = false;
  }

  return {
    microEvent: {
      type: "MicroEvent",
      rawTime,
      time,
      implicit,
      items,
      loc: { startLine: line, endLine: line },
    },
    issues,
  };
}

function parseMixedContent(raw, line) {
  const items = [];
  const issues = [];
  let i = 0;

  while (i < raw.length) {
    if (raw.startsWith("{{", i)) {
      const end = findInstructionEnd(raw, i);
      if (end < 0) {
        issues.push(makeIssue("UNCLOSED_INSTRUCTION_BLOCK", "Instruction block was not closed with '}}'.", line));
        break;
      }
      const instructionRaw = raw.slice(i, end);
      const parsedInstruction = parseInstructionBlock(instructionRaw, line);
      items.push({ type: "instruction", instruction: parsedInstruction.block });
      issues.push(...parsedInstruction.issues);
      i = end;
      continue;
    }

    let j = i;
    while (j < raw.length && !raw.startsWith("{{", j)) j += 1;

    const text = raw.slice(i, j).trim();
    if (text) items.push({ type: "text", text });
    i = j;
  }

  return { items, issues };
}

function flushTextBlock(payload, lines) {
  if (lines.length === 0) return;
  payload.push({
    type: "TimedPayloadText",
    lines: [...lines],
    normalized: lines.map((line) => line.normalized).join(" "),
    loc: { startLine: lines[0].loc.startLine, endLine: lines[lines.length - 1].loc.endLine },
  });
}

export function stringifyEpicxBody(body) {
  const lines = [];

  for (const entry of body.entries || []) {
    if (lines.length > 0) lines.push("");

    lines.push(String(entry.index));
    if (entry.anchor.kind === "range") {
      lines.push(`${entry.anchor.start.raw} --> ${entry.anchor.end.raw}`);
    } else {
      lines.push(entry.anchor.start.raw);
    }

    if (entry.section) lines.push(stringifySection(entry.section));

    for (const node of entry.payload || []) {
      if (node.type === "TimedPayloadInstruction") {
        lines.push(stringifyInstructionBlock(node.instruction));
      } else {
        for (const line of node.lines || []) {
          lines.push((line.items || []).map((item) => item.type === "instruction" ? stringifyInstructionBlock(item.instruction) : item.text).join(" ").trim());
        }
      }
    }

    for (const micro of entry.microEvents || []) {
      const prefix = micro.implicit ? "@" : `@${micro.rawTime ?? secondsToTimestamp(micro.time)}`;
      const content = (micro.items || []).map((item) => item.type === "MicroEventInstruction" ? stringifyInstructionBlock(item.instruction) : item.text).join(" ").trim();
      lines.push(content ? `${prefix} ${content}` : prefix);
    }
  }

  return lines.join("\n");
}
