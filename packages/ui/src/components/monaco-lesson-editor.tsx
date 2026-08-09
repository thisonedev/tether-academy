'use client';

import dynamic from 'next/dynamic';

// ssr:false because monaco-editor touches `window` at module load.
export const MonacoLessonEditor = dynamic(
  () => import('./monaco-lesson-editor-impl.js').then((m) => m.MonacoLessonEditorImpl),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-canvas text-sm text-canvas-muted-foreground">
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
