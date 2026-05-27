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
            position: relative;
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
          
          .split-actions {
            justify-content: space-between;
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

          .modal-close {
            position: absolute;
            top: 14px;
            right: 14px;

            width: 32px;
            height: 32px;

            border: 1px solid #3a4a5a;
            border-radius: 8px;

            background: #17202b;
            color: #dbe7f3;

            font-size: 20px;
            line-height: 1;
            cursor: pointer;
          }

          .modal-close:hover {
            background: #223041;
          }
          
          .icon {
            width: 18px;
            height: 18px;
            fill: currentColor;
            pointer-events: none;
          }

          .close-icon {
            position: absolute;
            top: 6px;
            left: 6px;
          }
        </style>
      </head>
      <body>
        <button
          class="modal-close"
          onclick="window.close()"
          aria-label="Close"
        >
           <svg
            class="icon close-icon"
            viewBox="0 0 628 628"
            aria-hidden="true"
          >
            <path d="M235.961,313.85L85.782,163.67L163.621,85.831L313.8,236.011L463.979,85.831L541.818,163.67L391.639,313.85L541.818,464.029L463.979,541.868L313.8,391.689L163.621,541.868L85.782,464.029L235.961,313.85Z"/>
          </svg>
        </button>
        <h1>This audio file already contains different EPICX data.</h1>
        <p>RChoose which EPICX content to use for this audio file.</p>

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

        <div class="actions split-actions">
          <button
            class="primary"
            onclick="location.href='epic-confirm://replace-current'"
          >
            Replace with Current Project
          </button>

          <button
            class="primary"
            onclick="location.href='epic-confirm://keep-existing'"
          >
            Keep Existing Content
          </button>
        </div>
      </body>
      </html>
    `;

    modal.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html)
    );

    modal.webContents.on("will-navigate", (event, url) => {
      if (url === "epic-confirm://replace-current") {
        event.preventDefault();
        resolve("replace-current");
        modal.close();
        return;
      }

      if (url === "epic-confirm://keep-existing") {
        event.preventDefault();
        resolve("keep-existing");
        modal.close();
      }
    });

    modal.on("closed", () => {
      resolve(null);
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
  const { filePath, fields, albumArt } = payload;

  // Read original to preserve EPICX if present
  const original = await readMediaMetadata(filePath);

  await writeStandardMetadata(filePath, fields);

  if (albumArt !== undefined) {
    const epicx = String(original.epicx || "");
    const outputPath = getEpicAudioOutputPath(filePath);

    await writeMediaArtworkToOutput({
      sourceAudioPath: filePath,
      outputPath,
      albumArt,
      epicx
    });

    const metadata = await readMediaMetadata(outputPath);

    return {
      metadata,
      epicx: metadata.epicx || ""
    };
  }

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

    const choice =
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

    if (choice === null) {
      return null;
    }

    if (choice === "keep-existing") {
      return {
        filePath: targetPath,
        metadata: existingMetadata,
        epicx: existingEpicx,
        verified: true,
        expectedLength: existingEpicx.length,
        actualLength: existingEpicx.length,
        useExistingEpicx: true
      };
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

function detectImageMimeType(buffer) {
  if (!buffer || buffer.length < 8) return "application/octet-stream";

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  if (
    buffer[0] === 0x42 &&
    buffer[1] === 0x4d
  ) {
    return "image/bmp";
  }

  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return "application/octet-stream";
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

async function writeMediaArtworkToOutput({
  sourceAudioPath,
  outputPath,
  albumArt,
  epicx
}) {
  const kind = getMediaKind(sourceAudioPath);

  if (kind === "wav") {
    await writeWavWithMetadata({
      sourceAudioPath,
      outputPath,
      metadata: {
        epicx,
        albumArt,
        removeAlbumArt: albumArt === null,
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
        albumArt,
        removeAlbumArt: albumArt === null,
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

ipcMain.handle("add-album-art", async (_event, payload) => {
  const audioPath = payload?.audioPath;

  if (!audioPath || !/\.(wav|mp3)$/i.test(audioPath)) {
    throw new Error("No audio file available for album art.");
  }

  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "Image Files",
        extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"]
      }
    ]
  });

  if (result.canceled) return null;

  const imagePath = result.filePaths[0];
  const imageBuffer = await fs.readFile(imagePath);
  const mimeType = detectImageMimeType(imageBuffer);

  if (!mimeType.startsWith("image/")) {
    throw new Error("Selected file is not a supported image.");
  }

  const metadata = await readMediaMetadata(audioPath);
  const epicx = String(metadata.epicx || "");
  const outputPath = getEpicAudioOutputPath(audioPath);

  await writeMediaArtworkToOutput({
    sourceAudioPath: audioPath,
    outputPath,
    albumArt: {
      mimeType,
      data: imageBuffer.toString("base64")
    },
    epicx
  });

  const newMetadata = await readMediaMetadata(outputPath);

  return {
    filePath: outputPath,
    metadata: newMetadata
  };
});