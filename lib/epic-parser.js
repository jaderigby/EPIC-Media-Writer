const path = require("path");
const { pathToFileURL } = require("url");

let parserPromise = null;

function getParser() {
  if (!parserPromise) {
    const parserPath = path.resolve(
      __dirname,
      "../epic-spec/src/index.js"
    );

    parserPromise = import(pathToFileURL(parserPath).href);
  }

  return parserPromise;
}

async function parseEpicText(source) {
  const text = String(source || "");

  if (!text.trim()) {
    return {
      ok: false,
      empty: true,
      issues: ["No EPIC/EPICX text to parse."],
      errors: ["No EPIC/EPICX text to parse."],
      document: null,
      roundtrip: ""
    };
  }

  try {
    const { parseDocument, stringifyDocument } = await getParser();

    const result = parseDocument(text);
    const roundtrip = stringifyDocument(result.document);

    const issues =
      result.issues ||
      result.errors ||
      [];

    return {
      ok: issues.length === 0,
      issues,
      errors: issues,
      document: result.document || null,
      roundtrip
    };
  } catch (err) {
    const issue = err.message || String(err);

    return {
      ok: false,
      issues: [issue],
      errors: [issue],
      document: null,
      roundtrip: ""
    };
  }
}

module.exports = {
  parseEpicText
};