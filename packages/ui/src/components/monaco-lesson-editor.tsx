'use client';

import dynamic from 'next/dynamic';

// ssr:false because monaco-editor touches `window` at module load.
export const MonacoLessonEditor = dynamic(
  () => import('./monaco-lesson-editor-impl.js').then((m) => m.MonacoLessonEditorImpl),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#9ca3af',
          fontSize: 13,
        }}
      >
        Loading editor...
      </div>
    ),
  },
);

export interface MonacoLessonEditorProps {
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}
