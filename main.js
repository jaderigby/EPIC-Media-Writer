const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { parseEpicText } = require("./lib/epic-parser");
const path = require("path");

const fs = require("fs/promises");

const {
  readMp3Metadata,
  writeMp3WithMetadata,
  writeMp3StandardMetadata
} = require("./lib/mp3-metadata");

const {
  readWavMetadata,
  writeWavWithMetadata,
  writeWavStandardMetadata
} = require("./lib/wav-metadata");

function getEpicAudioOutputPath(filePath) {
  const parsed = path.parse(filePath);

  if (parsed.name.endsWith(".epic")) {
    return filePath;
  }

  return path.join(
    parsed.dir,
    `${parsed.name}.epic${parsed.ext}`
  );
}

async function writeStandardMetadata(filePath, fields) {
  const kind = getMediaKind(filePath);

  if (kind === "wav") {
    await writeWavStandardMetadata({
      sourceAudioPath: filePath,
      outputPath: filePath,
      fields
    });
    return;
  }

  if (kind === "mp3") {
    await writeMp3StandardMetadata({
      sourceAudioPath: filePath,
      outputPath: filePath,
      fields
    });
    return;
  }

  throw new Error(`Unsupported media type: ${kind}`);
}

function previewEpicLines(value, maxLines = 10) {
  const lines = String(value || "")
    .trim()
    .split(/\r?\n/)
    .slice(0, maxLines);

  if (!lines.length || !lines.join("").trim()) {
    return "(No EPICX data)";
  }

  return lines.join("\n");
}

async function confirmReplaceEmbeddedEpic({
  parentWindow,
  projectText,
  embeddedText,
  projectLabel,
  audioLabel
}) {
  return await new Promise((resolve) => {
    const modal = new BrowserWindow({
      width: 860,
      height: 520,
      parent: parentWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Replace embedded EPICX?",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    });

    const projectPreview = previewEpicLines(projectText);
    const embeddedPreview = previewEpicLines(embeddedText);

    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            padding: 22px;
            background: #10151d;
            color: #eef3f8;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          }

          h1 {
            font-size: 18px;
            margin: 0 0 8px;
          }

          p {
            margin: 0 0 18px;
            color: #b8c3cf;
          }

          .compare {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
            margin-bottom: 18px;
          }

          .panel {
            border: 1px solid #2c3a48;
            border-radius: 10px;
            overflow: hidden;
            background: #0b0f15;
          }

          .label {
            padding: 10px 12px;
            border-bottom: 1px solid #2c3a48;
            color: #d8e2ec;
            font-size: 13px;
            font-weight: 600;
          }

          pre {
            margin: 0;
            padding: 12px;
            min-height: 150px;
            max-height: 220px;
            overflow: auto;
            white-space: pre-wrap;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 12px;
            line-height: 1.45;
            color: #edf5ff;
          }

          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
          }

          button {
            padding: 8px 14px;
            border-radius: 8px;
            border: 1px solid #3a4a5a;
            background: #17202b;
            color: #eef3f8;
            cursor: pointer;
          }

          button.primary {
            background: #7b3f32;
            border-color: #a75b49;
          }
        </style>
      </head>
      <body>
        <h1>This audio file already contains different EPICX data.</h1>
        <p>Replace the embedded EPICX with the current project text?</p>

        <div class="compare">
          <div class="panel">
            <div class="label">Current Project: ${escapeHtml(projectLabel)}</div>
            <pre>${escapeHtml(projectPreview)}</pre>
          </div>

          <div class="panel">
            <div class="label">Embedded Audio: ${escapeHtml(audioLabel)}</div>
            <pre>${escapeHtml(embeddedPreview)}</pre>
          </div>
        </div>

        <div class="actions">
          <button onclick="window.close()">Cancel</button>
          <button class="primary" onclick="location.href='epic-confirm://replace'">Replace</button>
        </div>
      </body>
      </html>
    `;

    modal.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html)
    );

    modal.webContents.on("will-navigate", (event, url) => {
      if (url === "epic-confirm://replace") {
        event.preventDefault();
        resolve(true);
        modal.close();
      }
    });

    modal.on("closed", () => {
      resolve(false);
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

ipcMain.handle("parse-epic", async (_event, payload) => {
  return parseEpicText(payload?.source || "");
});

ipcMain.handle("save-metadata", async (_event, payload) => {
  const { filePath, fields } = payload;

  await writeStandardMetadata(filePath, fields);

  const metadata = await readMediaMetadata(filePath);

  return {
    metadata,
    epicx: metadata.epicx || ""
  };
});

app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication");

ipcMain.handle("store-in-audio", async (event, payload) => {
  let targetPath = payload?.targetPath || "";
  const epicx = String(payload?.epicx || "");

  if (!targetPath || !/\.(wav|mp3)$/i.test(targetPath)) {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3"]
        }
      ]
    });

    if (result.canceled) return null;

    targetPath = result.filePaths[0];
  }

  const existingMetadata =
    await readMediaMetadata(targetPath);

  const existingEpicx =
    String(existingMetadata?.epicx || "");

  const hasDifferentEmbeddedEpicx =
    existingEpicx.trim() &&
    existingEpicx !== epicx;

  if (hasDifferentEmbeddedEpicx) {
    const parentWindow =
      BrowserWindow.fromWebContents(event.sender);

    const shouldReplace =
      await confirmReplaceEmbeddedEpic({
        parentWindow,
        projectText: epicx,
        embeddedText: existingEpicx,
        projectLabel:
          payload?.projectLabel ||
          "Current project",
        audioLabel:
          path.basename(targetPath)
      });

    if (!shouldReplace) {
      return null;
    }
  }

  const outputPath =
    getEpicAudioOutputPath(targetPath);

  await writeMediaMetadataToOutput({
    sourceAudioPath: targetPath,
    outputPath,
    epicx
  });

  const metadata =
    await readMediaMetadata(outputPath);

  const verified =
    String(metadata.epicx || "") ===
    String(epicx || "");

  return {
    filePath: outputPath,
    metadata,
    verified,
    expectedLength: epicx.length,
    actualLength:
      String(metadata.epicx || "").length
  };
});

ipcMain.handle("save-text-as", async (_event, payload) => {
  const result = await dialog.showSaveDialog({
    title: "Save EPIC File",
    defaultPath: "Untitled.epic",
    filters: [
      { name: "EPIC", extensions: ["epic"] },
      { name: "EPICX", extensions: ["epicx"] }
    ]
  });

  if (result.canceled) return null;

  await fs.writeFile(result.filePath, String(payload?.text || ""), "utf8");

  return {
    filePath: result.filePath,
    saved: true
  };
});

ipcMain.handle("save-text", async (_event, payload) => {
  const { filePath, text } = payload;

  if (!filePath) {
    throw new Error("No text file path provided.");
  }

  await fs.writeFile(filePath, String(text || ""), "utf8");

  return {
    filePath,
    saved: true
  };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    title: "EPIC Media Writer",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[main] preload-error:", preloadPath);
    console.error(error);
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

function getMediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".wav") return "wav";
  if (ext === ".mp3") return "mp3";

  throw new Error(`Unsupported media type: ${ext}`);
}

async function readMediaMetadata(filePath) {
  const kind = getMediaKind(filePath);

  if (kind === "wav") {
    return await readWavMetadata({ path: filePath }) || {};
  }

  if (kind === "mp3") {
    return await readMp3Metadata({ path: filePath }) || {};
  }

  return {};
}

app.whenReady().then(createWindow);

async function writeMediaMetadataToOutput({
  sourceAudioPath,
  outputPath,
  epicx
}) {
  const kind = getMediaKind(sourceAudioPath);

  if (kind === "wav") {
    await writeWavWithMetadata({
      sourceAudioPath,
      outputPath,
      metadata: {
        epicx,
        timestamp: new Date().toISOString()
      }
    });
    return;
  }

  if (kind === "mp3") {
    await writeMp3WithMetadata({
      sourceAudioPath,
      outputPath,
      metadata: {
        epicx,
        timestamp: new Date().toISOString()
      }
    });
    return;
  }

  throw new Error(`Unsupported media type: ${kind}`);
}

ipcMain.handle("open-media", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "EPIC Files",
        extensions: ["epic", "epicx", "wav", "mp3"]
      }
    ]
  });

  if (result.canceled) return null;

  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".epic" || ext === ".epicx") {
    const text = await fs.readFile(filePath, "utf8");

    return {
      kind: "text",
      filePath,
      text,
      metadata: null,
      epicx: text
    };
  }

  const metadata = await readMediaMetadata(filePath);
  const kind = getMediaKind(filePath);

  return {
    kind,
    filePath,
    metadata,
    epicx: metadata.epicx || ""
  };
});

ipcMain.handle("save-media", async (_event, payload) => {
  const { filePath, epicx } = payload;

  const outputPath = getEpicAudioOutputPath(filePath);

  await writeMediaMetadataToOutput({
    sourceAudioPath: filePath,
    outputPath,
    epicx
  });

  const reread = await readMediaMetadata(outputPath);
  const verified = String(reread.epicx || "") === String(epicx || "");

  return {
    filePath: outputPath,
    verified,
    expectedLength: String(epicx || "").length,
    actualLength: String(reread.epicx || "").length,
    reread
  };
});