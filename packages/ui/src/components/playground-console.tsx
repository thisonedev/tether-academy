'use client';

import { ChatInputBar, type ConsoleEntry, LessonConsole, RailHiddenContext, TableExportContext } from './lesson-console.js';

export interface PlaygroundConsoleProps {
  entries: ConsoleEntry[];
  setEntries: React.Dispatch<React.SetStateAction<ConsoleEntry[]>>;
  onExportTable: (markdown: string) => void;
}

/** The same timeline used in lessons, not a lookalike: run output and chat share one
 *  feed there, so they share one here too, with no lesson context to ground the chat. */
export function PlaygroundConsole({ entries, setEntries, onExportTable }: PlaygroundConsoleProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TableExportContext.Provider value={onExportTable}>
        <RailHiddenContext.Provider value={true}>
          <LessonConsole
            entries={entries}
            onStopCheck={() => {}}
            emptyStateText="Run a workflow or ask a question. It all shows up here."
          />
        </RailHiddenContext.Provider>
      </TableExportContext.Provider>
      <ChatInputBar entries={entries} setEntries={setEntries} lessonContext={null} />
    </div>
  );
}
