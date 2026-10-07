const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(`
  let currentFilePath = 'song-a.epic';
  const editor = { value: '', addEventListener() {} };
  const document = { addEventListener() {}, removeEventListener() {} };
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

run(`
  function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }
  function replaceEditorText(value) { editor.value = value; }
  function refreshEditorView() {}
  editor.value = '[Chorus {{swell--strong, arc-lift}}]';
  emotiveSessionRecipes = [['energetic']];
  emotiveState = {
    lineIndex: 0, sectionName: 'Chorus', recipes: getEmotiveRecipeLibrary(),
    selectedKey: emotiveRecipeKey(getSectionRecipeItems(0)), textValue: '', textError: '',
    overlay: { innerHTML: '', contains: () => true, remove() {} }
  };
  renderEmotiveDialog();
`);
let markup = run('emotiveState.overlay.innerHTML');
assert.ok(markup.includes('aria-current="true"'), 'Assigned recipe is highlighted immediately');
assert.ok(!markup.includes('Current recipe') && !markup.includes('New recipe') && !markup.includes('emo-drawer-toggle'));
assert.ok(markup.includes('data-action="remove-section-recipe"'));
assert.ok(markup.includes('data-action="delete-recipe"'), 'Unused recipe has a trash button');
assert.ok(!/data-action="delete-recipe"[^>]*disabled/.test(markup), 'Trash button is enabled');
assert.ok(!markup.includes('emo-pill'), 'Recipes use plain text within a single row');
assert.ok(!markup.includes('class="emo-recipe is-selected'), 'Selection belongs to the row, not a nested box');
run(`handleEmotiveDialogClick({ target: { closest: () => ({ dataset: { action: 'remove-section-recipe' } }) } });`);
assert.equal(run('editor.value'), '[Chorus]');
assert.ok(recipes().some(items => items.includes('swell--strong') && items.includes('arc-lift')), 'Unassign preserves the entire recipe');
assert.ok(!run('emotiveState.overlay.innerHTML').includes('data-action="remove-section-recipe"'), 'Unassigned recipes no longer show the unassign control');
console.log('Emotive popup assignment and flat-row tests passed.');

run(`handleEmotiveDialogClick({ target: { closest: () => ({ dataset: { action: 'delete-recipe', recipeKey: 'arc-lift|swell--strong' } }) } });`);
assert.deepEqual(recipes(), [['energetic']], 'Trash deletes an unassigned recipe');
run(`editor.value = '[Chorus]\\n[Verse {{open}}]'; emotiveState.recipes = getEmotiveRecipeLibrary(); renderEmotiveDialog();`);
markup = run('emotiveState.overlay.innerHTML');
assert.ok(!/data-action="delete-recipe" data-recipe-key="open"/.test(markup), 'Recipe used elsewhere has no trash button');
assert.ok(/data-action="delete-recipe" data-recipe-key="energetic"/.test(markup), 'Unused recipe still has a trash button');
run(`switchEmotiveRecipeSong('other.epic'); currentFilePath = 'other.epic';
     switchEmotiveRecipeSong('song-b-renamed.epic'); currentFilePath = 'song-b-renamed.epic'; editor.value = '';`);
assert.deepEqual(recipes(), [['energetic']], 'Deleted recipe stays deleted after switching songs');
console.log('Unused recipe deletion tests passed.');

run(`
  function getOffsetForLine() { return 0; }
  editor.focus = () => {};
  editor.setSelectionRange = () => {};
  function setupPopup() {
    editor.value = '[Verse {{choral chant, open}}]';
    emotiveSessionRecipes = [['energetic'], ['swell--strong', 'arc-lift']];
    emotiveState = {
      lineIndex: 0, sectionName: 'Verse', recipes: getEmotiveRecipeLibrary(),
      originalText: editor.value, originalRecipes: emotiveSessionRecipes.map(items => [...items]),
      textValue: '', textError: '',
      overlay: { innerHTML: '', contains: () => true, remove() {}, querySelector: () => null }
    };
    renderEmotiveDialog();
  }
  function clickRecipe(key) {
    handleEmotiveDialogClick({ target: { closest: () => ({ dataset: { recipeKey: key } }) } });
  }
  function clickAction(action) {
    handleEmotiveDialogClick({ target: { closest: () => ({ dataset: { action } }) } });
  }
  setupPopup();
  clickRecipe('energetic');
`);
assert.equal(run('editor.value'), '[Verse {{choral chant, energetic}}]', 'Row click applies immediately');
assert.ok(run('emotiveState !== null'), 'Popup stays open after applying');
markup = run('emotiveState.overlay.innerHTML');
assert.ok(markup.includes('>Applied</span>') && markup.includes('>Done</button>'));
assert.ok(!markup.includes('is-selected') && !markup.includes('>Apply recipe'));
assert.ok(markup.includes('>Use</span>'));
run(`clickRecipe('arc-lift|swell--strong');`);
assert.equal(run('editor.value'), '[Verse {{choral chant, swell--strong, arc-lift}}]');
run(`clickAction('cancel');`);
assert.equal(run('editor.value'), '[Verse {{choral chant, open}}]', 'Cancel restores exact original value after multiple applications');
assert.equal(run('emotiveState'), null);
run(`setupPopup(); clickRecipe('energetic'); clickAction('close');`);
assert.equal(run('editor.value'), '[Verse {{choral chant, energetic}}]', 'Done keeps the applied recipe');
assert.equal(run('emotiveState'), null);
run(`setupPopup(); clickAction('remove-section-recipe'); clickAction('cancel');`);
assert.equal(run('editor.value'), '[Verse {{choral chant, open}}]', 'Cancel also restores an unassigned recipe');
console.log('Immediate apply, Done, and Cancel tests passed.');
