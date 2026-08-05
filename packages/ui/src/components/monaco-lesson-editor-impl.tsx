'use client';

import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import type * as monacoTypes from 'monaco-editor';
import { useCallback, useRef } from 'react';
import { QVAC_THEME, setupQvacMonaco } from './monaco-qvac-setup.js';

// Pin the loader to the app-bundled Monaco; otherwise @monaco-editor/react fetches the AMD
// loader from cdn.jsdelivr.net, which the renderer CSP can't allow into the window.academy origin.
// Resolve relative to the Next basePath so the loader works when the web build is served under
// a sub-path (GitHub Pages project pages, the Electron academy://app origin).
const __academyBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
loader.config({ paths: { vs: `${__academyBasePath}/monaco/vs` } });

const COMMON_EDITOR_OPTIONS: monacoTypes.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: 'on',
  renderLineHighlight: 'all',
  roundedSelection: false,
  smoothScrolling: true,
  suggestOnTriggerCharacters: true,
  quickSuggestions: { other: true, comments: false, strings: false },
  parameterHints: { enabled: true },
  formatOnPaste: false,
  formatOnType: false,
};

export interface MonacoLessonEditorImplProps {
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}

export function MonacoLessonEditorImpl({
  value,
  readOnly = false,
  onChange,
}: MonacoLessonEditorImplProps) {
  const editorRef = useRef<monacoTypes.editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    setTimeout(() => editor.layout(), 0);
  }, []);

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    setupQvacMonaco(monaco);
  }, []);

  return (
    <Editor
      height="100%"
      defaultLanguage="typescript"
      language="typescript"
      theme={QVAC_THEME}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      beforeMount={handleBeforeMount}
      options={{
        ...COMMON_EDITOR_OPTIONS,
        readOnly,
      }}
    />
  );
}


