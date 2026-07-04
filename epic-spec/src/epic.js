import { findTrailingInstruction, parseInstructionBlock, stringifyInstructionBlock } from "./instruction.js";
import { parseSectionLine, stringifySection } from "./section.js";

export function parseEpicBody(cursor) {
  const issues = [];
  const preamble = [];
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

    const parsedLine = parseEpicLine(cursor.next(), lineNumber);
    issues.push(...parsedLine.issues);

    if (currentSection) {
      currentSection.lines.push(parsedLine.node);
    } else {
      preamble.push(parsedLine.node);
    }
  }

  return { body: { type: "EpicBody", preamble, sections }, issues };
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

  for (const line of body.preamble || []) {
    lines.push(stringifyEpicLine(line));
  }

  if ((body.preamble || []).length > 0 && (body.sections || []).length > 0) {
    lines.push("");
  }

  for (const section of body.sections || []) {
    lines.push(stringifySection(section.section));
    for (const line of section.lines || []) {
      lines.push(stringifyEpicLine(line));
    }
    lines.push("");
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function stringifyEpicLine(line) {
  if (line.type === "EpicInstructionLine") {
    return stringifyInstructionBlock(line.instruction);
  }

  let text = line.text || "";
  if (line.instruction) text += (text ? " " : "") + stringifyInstructionBlock(line.instruction);
  return text;
}
