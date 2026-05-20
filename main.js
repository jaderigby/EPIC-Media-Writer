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

ipcMain.handle("store-in-audio", async (_event, payload) => {
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

  const outputPath = getEpicAudioOutputPath(targetPath);

  await writeMediaMetadataToOutput({
    sourceAudioPath: targetPath,
    outputPath,
    epicx
  });

  const metadata = await readMediaMetadata(outputPath);
  const verified =
    String(metadata.epicx || "") === String(epicx || "");

  return {
    filePath: outputPath,
    metadata,
    verified,
    expectedLength: epicx.length,
    actualLength: String(metadata.epicx || "").length
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