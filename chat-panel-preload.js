const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__msgrPanel', {
  openMain: () => ipcRenderer.send('chat-panel-open-main'),
});

const HEADER_CSS = `
  [role="banner"] { visibility: hidden !important; }
  #__msgr_app_header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 56px;
    background: linear-gradient(135deg, #0084ff 0%, #44bec7 60%, #a06cd5 100%);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-left: 76px;
    padding-right: 16px;
    font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    letter-spacing: 0.2px;
    z-index: 2147483647;
    cursor: pointer;
    user-select: none;
    box-sizing: border-box;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
    transition: filter 0.12s ease;
  }
  #__msgr_app_header:hover { filter: brightness(1.08); }
  #__msgr_app_header:active { filter: brightness(0.95); }
`;

function injectStyle() {
  const root = document.documentElement;
  if (!root) return;
  if (document.getElementById('__msgr_app_header_style')) return;
  const style = document.createElement('style');
  style.id = '__msgr_app_header_style';
  style.textContent = HEADER_CSS;
  root.appendChild(style);
}

function injectHeader() {
  if (!document.documentElement) return;
  if (document.getElementById('__msgr_app_header')) return;
  const h = document.createElement('div');
  h.id = '__msgr_app_header';
  h.title = 'Open full Messenger window';
  h.textContent = 'Messenger';
  h.addEventListener('click', () => ipcRenderer.send('chat-panel-open-main'));
  document.documentElement.appendChild(h);
}

function run() {
  injectStyle();
  injectHeader();
}

run();
document.addEventListener('DOMContentLoaded', run);
window.addEventListener('load', run);
