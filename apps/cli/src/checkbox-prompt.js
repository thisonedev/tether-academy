'use strict';

const readline = require('node:readline');

// Zero-dependency multi-select (arrow keys + space), matching the CLI's plain
// style rather than pulling in a prompt library for one screen.
//
// items: { label: string, size?: string, checked?: boolean }[]
// endColumn: absolute column each size right-aligns to, shared with whatever
// static text was printed above this prompt so the two sections' size
// columns line up. Omit to align only within this prompt.
function checkboxPrompt(items, { endColumn } = {}) {
  return new Promise((resolve, reject) => {
    const state = items.map((item) => ({ ...item, checked: !!item.checked }));
    let cursor = 0;

    const target =
      endColumn ??
      Math.max(...state.map((s) => 6 + s.label.length + (s.size ? s.size.length : 0))) + 4;

    function renderLine(item, isCursor) {
      const box = item.checked ? '●' : '○'; // ● / ○
      const pointer = isCursor ? '❯' : ' '; // ❯
      let line = `  ${pointer} ${box} ${item.label}`;
      if (item.size) {
        const pad = Math.max(target - line.length - item.size.length, 1);
        line += ' '.repeat(pad) + item.size;
      }
      return line;
    }

    function render(first) {
      if (!first) {
        readline.moveCursor(process.stdout, 0, -state.length);
        readline.cursorTo(process.stdout, 0);
      }
      for (let i = 0; i < state.length; i++) {
        readline.clearLine(process.stdout, 0);
        process.stdout.write(renderLine(state[i], i === cursor) + '\n');
      }
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKeypress);
    }

    function onKeypress(str, key) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('cancelled'));
        return;
      }
      if (key.name === 'up') cursor = (cursor - 1 + state.length) % state.length;
      else if (key.name === 'down') cursor = (cursor + 1) % state.length;
      else if (key.name === 'space' || str === ' ') state[cursor].checked = !state[cursor].checked;
      else if (key.name === 'return') {
        cleanup();
        resolve(state.map((s) => s.checked));
        return;
      } else {
        return;
      }
      render(false);
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);
    render(true);
  });
}

module.exports = { checkboxPrompt };
