// oneDark palette (atom-one-dark), ported from the previous CodeMirror setup. Colors are
// stored without the leading `#` so they work for both token rules and the colors map.

export const QVAC_THEME_NAME = 'qvac-dark';

const C = {
  // The app's own canvas, so the code well sits at the same temperature as the
  // chrome around it. One Dark's #282c34 is blue-grey and read cold here.
  bg: '090f0c',
  fg: 'abb2bf',
  cursor: '528bff',
  selection: '3e4451',
  lineHighlight: '0e1411',
  widgetBg: '050a07',
  widgetBorder: '181a1f',
  comment: '5c6370',
  keyword: 'c678dd',
  string: '98c379',
  number: 'd19a66',
  fn: '61afef',
  variable: 'e06c75',
  type: 'e5c07b',
  tag: 'e06c75',
  operator: '56b6c2',
  invalidBg: 'e05252',
  invalidFg: 'ffffff',
};

// The console paints itself with this so output shares the editor's surface
// instead of sitting in a differently coloured box below it. Derived, so the
// two cannot drift apart.
export const QVAC_EDITOR_BACKGROUND = `#${C.bg}`;

export const QVAC_DARK_TOKEN_RULES = [
  { token: '', foreground: C.fg },
  { token: 'comment', foreground: C.comment, fontStyle: 'italic' },
  { token: 'keyword', foreground: C.keyword },
  { token: 'keyword.control', foreground: C.keyword },
  { token: 'keyword.operator', foreground: C.operator },
  { token: 'storage', foreground: C.keyword },
  { token: 'storage.type', foreground: C.keyword },
  { token: 'storage.modifier', foreground: C.keyword },
  { token: 'string', foreground: C.string },
  { token: 'string.quoted', foreground: C.string },
  { token: 'string.regexp', foreground: C.operator },
  { token: 'constant.numeric', foreground: C.number },
  { token: 'constant.language', foreground: C.number },
  { token: 'constant.character.escape', foreground: C.operator },
  { token: 'variable', foreground: C.fg },
  { token: 'variable.parameter', foreground: C.variable },
  { token: 'variable.language', foreground: C.variable },
  { token: 'entity.name.function', foreground: C.fn },
  { token: 'entity.name.class', foreground: C.type },
  { token: 'entity.name.type', foreground: C.type },
  { token: 'entity.name.tag', foreground: C.tag },
  { token: 'entity.other.attribute-name', foreground: C.number },
  { token: 'type', foreground: C.type },
  { token: 'type.identifier', foreground: C.type },
  { token: 'number', foreground: C.number },
  { token: 'regexp', foreground: C.operator },
  { token: 'delimiter', foreground: C.fg },
  { token: 'delimiter.bracket', foreground: C.fg },
  { token: 'meta', foreground: C.fn },
  { token: 'meta.tag', foreground: C.fg },
  { token: 'meta.import', foreground: C.fg },
  { token: 'invalid', foreground: C.invalidFg, background: C.invalidBg },
] as const;

export const QVAC_DARK_COLORS = {
  'editor.background': `#${C.bg}`,
  'editor.foreground': `#${C.fg}`,
  'editorCursor.foreground': `#${C.cursor}`,
  'editor.lineHighlightBackground': `#${C.lineHighlight}`,
  'editor.selectionBackground': `#${C.selection}`,
  'editor.selectionHighlightBackground': `#${C.selection}80`,
  'editor.wordHighlightBackground': `#${C.selection}80`,
  'editor.findMatchBackground': `#${C.selection}`,
  'editor.findMatchHighlightBackground': `#${C.selection}80`,
  'editorBracketMatch.background': `#${C.selection}`,
  'editorIndentGuide.background1': `#${C.selection}`,
  'editorIndentGuide.activeBackground1': `#${C.comment}`,
  'editorGutter.background': `#${C.bg}`,
  'editorLineNumber.foreground': `#${C.comment}`,
  'editorLineNumber.activeForeground': `#${C.fg}`,
  'editorWidget.background': `#${C.widgetBg}`,
  'editorWidget.border': `#${C.widgetBorder}`,
  'editorSuggestWidget.background': `#${C.widgetBg}`,
  'editorSuggestWidget.border': `#${C.widgetBorder}`,
  'editorSuggestWidget.selectedBackground': `#${C.selection}`,
  'editorHoverWidget.background': `#${C.widgetBg}`,
  'editorHoverWidget.border': `#${C.widgetBorder}`,
  'editorMarkerNavigation.background': `#${C.widgetBg}`,
} as const;
