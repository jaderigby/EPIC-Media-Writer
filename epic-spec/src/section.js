import { parseInstructionBlock, stringifyInstructionBlock } from "./instruction.js";
import { makeIssue } from "./utils.js";

const KNOWN_SECTION_NAMES = new Set([
  "Verse",
  "Chorus",
  "Pre-Chorus",
  "Bridge",
  "Intro",
  "Outro",
  "Final Chorus",
  "Spoken",
]);

export function parseSectionLine(rawLine, line = 0) {
  const raw = String(rawLine).trim();
  const issues = [];

  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    issues.push(makeIssue("INVALID_SECTION_LABEL", `Invalid section label "${rawLine}".`, line));
    return { section: null, issues };
  }

  const inner = raw.slice(1, -1).trim();
  const instructionIndex = inner.indexOf("{{");

  let sectionText = inner;
  let instruction = null;

  if (instructionIndex >= 0) {
    sectionText = inner.slice(0, instructionIndex).trim();
    const instructionRaw = inner.slice(instructionIndex).trim();
    const parsedInstruction = parseInstructionBlock(instructionRaw, line);
    instruction = parsedInstruction.block;
    issues.push(...parsedInstruction.issues);
  }

  const parsedName = parseSectionName(sectionText);

  return {
    section: {
      raw,
      name: parsedName.name,
      known: KNOWN_SECTION_NAMES.has(parsedName.name),
      index: parsedName.index,
      instruction,
    },
    issues,
  };
}

export function stringifySection(section) {
  let label = section?.name || "";
  if (section?.index !== null && section?.index !== undefined) label += ` ${section.index}`;
  if (section?.instruction) label += ` ${stringifyInstructionBlock(section.instruction)}`;
  return `[${label}]`;
}

function parseSectionName(text) {
  const match = String(text).match(/^(.*?)(?:\s+(\d+))?$/);
  if (!match) return { name: String(text).trim(), index: null };
  return {
    name: (match[1] || "").trim(),
    index: match[2] ? Number.parseInt(match[2], 10) : null,
  };
}
