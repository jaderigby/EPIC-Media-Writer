import { makeIssue } from "./utils.js";

const SHORT_TIMESTAMP_RE = /^\d{2}:\d{2}\.\d{3}$/;
const LONG_TIMESTAMP_RE = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;

export function parseTimestamp(raw, line = 0) {
  const text = String(raw).trim();
  const issues = [];

  if (SHORT_TIMESTAMP_RE.test(text)) {
    return { timestamp: { raw: text, seconds: toSeconds(text), format: "mm:ss.mmm" }, issues };
  }
  if (LONG_TIMESTAMP_RE.test(text)) {
    return { timestamp: { raw: text, seconds: toSeconds(text), format: "hh:mm:ss.mmm" }, issues };
  }

  issues.push(makeIssue("INVALID_TIMESTAMP", `Invalid timestamp "${raw}". Expected MM:SS.mmm or HH:MM:SS.mmm.`, line));
  return { timestamp: { raw: text, seconds: 0, format: "mm:ss.mmm" }, issues };
}

export function parseAnchor(raw, line = 0) {
  const text = String(raw).trim();
  if (text.includes("-->")) {
    const parts = text.split("-->");
    if (parts.length !== 2) {
      return {
        anchor: { kind: "point", start: { raw: "00:00.000", seconds: 0, format: "mm:ss.mmm" } },
        issues: [makeIssue("INVALID_TIME_RANGE", `Invalid time range "${raw}".`, line)],
      };
    }
    const start = parseTimestamp(parts[0].trim(), line);
    const end = parseTimestamp(parts[1].trim(), line);
    return {
      anchor: { kind: "range", start: start.timestamp, end: end.timestamp },
      issues: [...start.issues, ...end.issues],
    };
  }

  const parsed = parseTimestamp(text, line);
  return { anchor: { kind: "point", start: parsed.timestamp }, issues: parsed.issues };
}

function toSeconds(raw) {
  const parts = raw.split(":");
  if (parts.length === 2) {
    const [mm, rest] = parts;
    const [ss, ms] = rest.split(".");
    return Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
  }
  const [hh, mm, rest] = parts;
  const [ss, ms] = rest.split(".");
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

export function secondsToTimestamp(seconds, forceLong = false) {
  const whole = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(whole / 3600);
  const remAfterH = whole - h * 3600;
  const m = Math.floor(remAfterH / 60);
  const sFloat = remAfterH - m * 60;
  const s = Math.floor(sFloat);
  const ms = Math.round((sFloat - s) * 1000);
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  if (forceLong || h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
  return `${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}
