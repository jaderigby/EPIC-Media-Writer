import { stringifyHeader } from "./header.js";
import { stringifyEpicBody } from "./epic.js";
import { stringifyEpicxBody } from "./epicx.js";

export function stringifyDocument(document) {
  const parts = [];
  parts.push(stringifyHeader(document.header));
  parts.push("");

  if (document.format === "epicx") {
    parts.push(stringifyEpicxBody(document.body));
  } else {
    parts.push(stringifyEpicBody(document.body));
  }

  return parts.join("\n");
}
