const titleEl = document.getElementById('title');
const frameEl = document.getElementById('pdf-frame');
const docEl = document.getElementById('doc');
const msgEl = document.getElementById('message');

document.getElementById('btn-save')
  .addEventListener('click', () => window.__msgrViewer.saveCopy());
document.getElementById('btn-external')
  .addEventListener('click', () => window.__msgrViewer.openExternal());

window.__msgrViewer.onData((data) => {
  if (data.filename) {
    titleEl.textContent = data.filename;
    document.title = data.filename;
  }

  if (data.kind === 'pdf') {
    frameEl.src = data.fileUrl;
    frameEl.classList.remove('hidden');
  } else if (data.kind === 'html') {
    docEl.innerHTML = data.html || '<p>(Empty document)</p>';
    docEl.classList.remove('hidden');
  } else {
    msgEl.textContent = data.message || 'This attachment can’t be previewed.';
    msgEl.classList.remove('hidden');
  }
});
