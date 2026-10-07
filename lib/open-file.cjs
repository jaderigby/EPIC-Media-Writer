const fs = require('node:fs/promises');
const path = require('node:path');
const SUPPORTED_EXTENSIONS = ['epic', 'epicx', 'txt', 'md', 'wav', 'mp3'];

async function readOpenFile(filePath, readMediaMetadata) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A local file path is required.');
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new Error('Unsupported file type.');
  if (!(await fs.stat(filePath)).isFile()) throw new Error('Drop files, not folders.');
  if (!['wav', 'mp3'].includes(extension)) {
    const text = await fs.readFile(filePath, 'utf8');
    return { kind: 'text', filePath, text, metadata: null, epicx: text };
  }
  const metadata = await readMediaMetadata(filePath);
  return { kind: extension, filePath, metadata, epicx: metadata.epicx || '' };
}
module.exports = { readOpenFile, SUPPORTED_EXTENSIONS };
