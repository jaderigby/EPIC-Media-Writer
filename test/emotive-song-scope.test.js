const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(`
  let currentFilePath = 'song-a.epic';
  const editor = { value: '' };
  function splitInstructionItems(text) { return text.split(',').map(s => s.trim()); }
  ${source.slice(source.indexOf('const EMOTIVE_LAYERS ='), source.lastIndexOf('installEmotiveRecipeStyles();'))}
`, context);
const run = code => vm.runInContext(code, context);
const recipes = () => JSON.parse(run('JSON.stringify(getEmotiveRecipeLibrary().map(r => r.items))'));

run(`emotiveSessionRecipes.push(['energetic']);`);
assert.deepEqual(recipes(), [['energetic']]);
run(`switchEmotiveRecipeSong('song-b.epic'); currentFilePath = 'song-b.epic';
     editor.value = '[Chorus {{swell}}]';`);
assert.deepEqual(recipes(), [['swell']], 'Song B must not show Song A recipes');
run(`emotiveSessionRecipes.push(['open']);
     switchEmotiveRecipeSong('song-a.epic'); currentFilePath = 'song-a.epic'; editor.value = '';`);
assert.deepEqual(recipes(), [['energetic']], 'Returning to A restores only its unused recipes');
run(`switchEmotiveRecipeSong(''); currentFilePath = ''; editor.value = '';
     emotiveSessionRecipes.push(['rise']);
     switchEmotiveRecipeSong('');
     switchEmotiveRecipeSong('song-b.epic'); currentFilePath = 'song-b.epic';
     editor.value = '[Chorus {{swell}}]';`);
assert.deepEqual(recipes(), [['swell'], ['open']], 'Discarded untitled recipes must not leak');
run(`currentFilePath = 'song-b-renamed.epic';
     switchEmotiveRecipeSong('song-a.epic'); currentFilePath = 'song-a.epic';
     switchEmotiveRecipeSong('song-b-renamed.epic'); currentFilePath = 'song-b-renamed.epic';`);
assert.deepEqual(recipes(), [['swell'], ['open']], 'Save As retains recipes for the saved song');
console.log('Emotive song isolation tests passed.');
