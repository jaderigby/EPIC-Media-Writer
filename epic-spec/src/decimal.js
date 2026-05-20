import { makeIssue } from "./utils.js";

const DECIMAL_RE = /^(0|1|0\.\d{2}|1\.00)$/;

export function parseDecimalPercent(raw, line = 0) {
  const text = String(raw).trim();
  const issues = [];
  if (!DECIMAL_RE.test(text)) {
    issues.push(makeIssue("INVALID_DECIMAL", `Invalid decimal "${raw}". Must be 0, 1, 0.xx, or 1.00.`, line));
  }
  return {
    value: { raw: text, value: Number.parseFloat(text || "0") },
    issues,
  };
}

export function isValidDecimalPercent(raw) {
  return DECIMAL_RE.test(String(raw).trim());
}
