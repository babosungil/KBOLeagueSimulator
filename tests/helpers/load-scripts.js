const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.resolve(__dirname, '..', '..');

function createElementStub() {
  return {
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    prepend() {},
    querySelector() { return createElementStub(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 0 }; },
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
  };
}

function loadKboScripts() {
  const context = {
    console,
    URL,
    Math,
    JSON,
    Date,
    setTimeout,
    clearTimeout,
    Promise,
    location: { href: 'http://localhost/' },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    document: {
      currentScript: { src: 'http://localhost/js/engine.js' },
      getElementById() { return createElementStub(); },
      createElement() { return createElementStub(); },
      querySelectorAll() { return []; },
    },
    window: {},
    alert() {},
    confirm() { return true; },
  };
  context.globalThis = context;
  context.window = context;

  vm.createContext(context);

  for (const scriptPath of ['js/engine.js', 'js/season.js']) {
    const code = fs.readFileSync(path.join(rootDir, scriptPath), 'utf8');
    vm.runInContext(code, context, { filename: scriptPath });
  }

  return context.__KBO_TEST__;
}

module.exports = { loadKboScripts };
