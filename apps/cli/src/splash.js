'use strict';

const GREEN = '\x1b[38;2;52;211;153m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const HEXAGON = [
  '     ▄▄▄▄     ',
  '   ▄██████▄   ',
  '  ██████████  ',
  '  ██████████  ',
  '  ██████████  ',
  '   ▀██████▀   ',
  '     ▀▀▀▀     ',
];

function printSplash(subtitle) {
  if (!process.stdout.isTTY) return;
  console.log();
  for (const line of HEXAGON) {
    console.log(GREEN + line + RESET);
  }
  console.log();
  console.log(`${BOLD}tether-academy${RESET}${subtitle ? ` — ${subtitle}` : ''}`);
  console.log();
}

function printBanner(text) {
  if (!process.stdout.isTTY) return;
  console.log();
  for (const line of HEXAGON) {
    console.log(GREEN + line + RESET);
  }
  console.log();
  console.log(`${BOLD}⬡ ${text}${RESET}`);
  console.log();
}

module.exports = { printSplash, printBanner };