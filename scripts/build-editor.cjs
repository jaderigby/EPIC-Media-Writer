const path = require('node:path');
function buildEditor() {
  require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, '../editor/codemirror.mjs')],
    outfile: path.join(__dirname, '../dist/editor.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome136',
    sourcemap: true
  });
}

module.exports = buildEditor;
if (require.main === module) buildEditor();
