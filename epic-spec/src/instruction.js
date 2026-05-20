import { makeIssue } from "./utils.js";

export function parseInstructionBlock(raw, line = 0) {
  const text = String(raw).trim();
  const issues = [];

  if (!text.startsWith("{{") || !text.endsWith("}}")) {
    issues.push(makeIssue("INVALID_INSTRUCTION_BLOCK", `Invalid instruction block "${raw}".`, line));
    return { block: { type: "InstructionBlock", raw: text, items: [] }, issues };
  }

  const inner = text.slice(2, -2);
  const items = [];
  for (const part of splitTopLevel(inner, ",")) {
    const item = part.trim();
    if (!item) {
      issues.push(makeIssue("EMPTY_INSTRUCTION_ITEM", "Empty instruction items are not allowed.", line));
      continue;
    }
    const colonIndex = findTopLevelColon(item);
    if (colonIndex >= 0) {
      const key = item.slice(0, colonIndex).trim();
      const value = item.slice(colonIndex + 1).trim();
      if (!key) {
        issues.push(makeIssue("EMPTY_INSTRUCTION_KEY", "Instruction key must not be empty.", line));
        continue;
      }
      if (!value) {
        issues.push(makeIssue("EMPTY_INSTRUCTION_VALUE", "Instruction value must not be empty.", line));
        continue;
      }
      items.push({ type: "kv", key, value: unwrapBackticks(value) });
    } else {
      items.push({ type: "text", value: unwrapBackticks(item) });
    }
  }

  return { block: { type: "InstructionBlock", raw: text, items }, issues };
}

export function stringifyInstructionBlock(block) {
  const rendered = (block?.items || []).map((item) => {
    if (item.type === "kv") return `${item.key}: ${renderValue(item.value)}`;
    return renderValue(item.value);
  });
  return `{{${rendered.join(", ")}}}`;
}

export function findInstructionEnd(line, startIndex) {
  let i = startIndex + 2;
  let inBackticks = false;
  while (i < line.length - 1) {
    const ch = line[i];
    if (ch === "`") {
      inBackticks = !inBackticks;
      i += 1;
      continue;
    }
    if (!inBackticks && line[i] === "}" && line[i + 1] === "}") return i + 2;
    i += 1;
  }
  return -1;
}

export function findTrailingInstruction(line) {
  const start = line.indexOf("{{");
  if (start < 0) return -1;
  const end = findInstructionEnd(line, start);
  if (end < 0) return -1;
  if (line.slice(end).trim() !== "") return -1;
  return start;
}

function splitTopLevel(text, delimiter) {
  const out = [];
  let current = "";
  let inBackticks = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "`") {
      inBackticks = !inBackticks;
      current += ch;
      continue;
    }
    if (!inBackticks && ch === delimiter) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function findTopLevelColon(text) {
  let inBackticks = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "`") {
      inBackticks = !inBackticks;
      continue;
    }
    if (!inBackticks && ch === ":") return i;
  }
  return -1;
}

function unwrapBackticks(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function renderValue(value) {
  const text = String(value ?? "");
  if (/[,:`\n\t]/.test(text)) return "`" + text.replace(/`/g, "") + "`";
  return text;
}
