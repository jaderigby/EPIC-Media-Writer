import { findTrailingInstruction, parseInstructionBlock, stringifyInstructionBlock } from "./instruction.js";
import { parseSectionLine, stringifySection } from "./section.js";
import { makeIssue } from "./utils.js";

export function parseEpicBody(cursor) {
  const issues = [];
  const sections = [];
  let currentSection = null;

  while (!cursor.eof()) {
    const lineNumber = cursor.lineNumber();
    const line = cursor.peek();
    if (line === null) break;

    const trimmed = line.trim();

    if (trimmed === "") {
      cursor.next();
      continue;
    }

    if (trimmed.startsWith("[")) {
      const parsedSection = parseSectionLine(cursor.next(), lineNumber);
      issues.push(...parsedSection.issues);
      if (!parsedSection.section) continue;
      currentSection = { type: "EpicSection", section: parsedSection.section, lines: [] };
      sections.push(currentSection);
      continue;
    }

    if (!currentSection) {
      issues.push(makeIssue("LYRIC_OUTSIDE_SECTION", "Lyric or instruction line found before any section.", lineNumber));
      cursor.next();
      continue;
    }

    const parsedLine = parseEpicLine(cursor.next(), lineNumber);
    issues.push(...parsedLine.issues);
    currentSection.lines.push(parsedLine.node);
  }

  return { body: { type: "EpicBody", sections }, issues };
}

function parseEpicLine(raw, line) {
  const issues = [];
  const trimmed = raw.trim();

  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    const parsedInstruction = parseInstructionBlock(trimmed, line);
    issues.push(...parsedInstruction.issues);
    return {
      node: { type: "EpicInstructionLine", instruction: parsedInstruction.block, loc: { startLine: line, endLine: line } },
      issues,
    };
  }

  const trailingInstructionIndex = findTrailingInstruction(raw);
  if (trailingInstructionIndex >= 0) {
    const textPart = raw.slice(0, trailingInstructionIndex).trim();
    const instructionRaw = raw.slice(trailingInstructionIndex).trim();
    const parsedInstruction = parseInstructionBlock(instructionRaw, line);
    issues.push(...parsedInstruction.issues);

    return {
      node: {
        type: "EpicLyricLine",
        text: textPart,
        instruction: parsedInstruction.block,
        loc: { startLine: line, endLine: line },
      },
      issues,
    };
  }

  return {
    node: { type: "EpicLyricLine", text: trimmed, instruction: null, loc: { startLine: line, endLine: line } },
    issues,
  };
}

export function stringifyEpicBody(body) {
  const lines = [];
  for (const section of body.sections || []) {
    lines.push(stringifySection(section.section));
    for (const line of section.lines || []) {
      if (line.type === "EpicInstructionLine") {
        lines.push(stringifyInstructionBlock(line.instruction));
      } else {
        let text = line.text || "";
        if (line.instruction) text += (text ? " " : "") + stringifyInstructionBlock(line.instruction);
        lines.push(text);
      }
    }
    lines.push("");
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
