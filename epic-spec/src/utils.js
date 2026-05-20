export function splitLines(text) {
  return stripBom(String(text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function makeIssue(
  code,
  message,
  line = 0,
  severity = "error",
  extra = {},
) {
  return { code, message, line, severity, ...extra };
}
