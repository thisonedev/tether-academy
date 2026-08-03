'use client';

import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import type * as monacoTypes from 'monaco-editor';
import { useCallback, useRef } from 'react';
import { QVAC_THEME, setupQvacMonaco } from './monaco-qvac-setup.js';

// Pin the loader to the app-bundled Monaco. Without this, @monaco-editor/react
// fetches the AMD loader from cdn.jsdelivr.net at runtime, which the renderer
// CSP cannot allow without trusting a third-party origin to deliver executable
// code into the same origin that holds window.academy. The path is the public
// asset copy produced by apps/web's prebuild step.
loader.config({ paths: { vs: '/monaco/vs' } });

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


