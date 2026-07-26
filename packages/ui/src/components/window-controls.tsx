'use client';

import type { MouseEvent } from 'react';
import type { AcademyAPI, AcademyWindowAPI } from '@academy/academy-bridge';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

function readAPI(): AcademyWindowAPI | null {
  if (typeof window === 'undefined') return null;
  return window.academy?.window ?? null;
}

export function WindowControls() {
  const api = readAPI();
  const stop = (e: MouseEvent) => e.stopPropagation();

  // Reserve the same width whether the desktop bridge is present or not so the
  // header doesn't reflow when the traffic lights show up. The aria-hidden
  // placeholder keeps the layout stable on the web (and during the first paint
  // in the desktop app, before the academy bridge is consulted).
  return (
    <div
      aria-label="Window controls"
      className="flex items-center gap-2"
      onMouseDown={stop}
      onClick={stop}
    >
      {api ? (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => api.close()}
            className="size-3 rounded-full bg-red-500 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
          />
          <button
            type="button"
            aria-label="Minimize"
            onClick={() => api.minimize()}
            className="size-3 rounded-full bg-yellow-500 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/50"
          />
          <button
            type="button"
            aria-label="Maximize"
            onClick={() => api.maximize()}
            className="size-3 rounded-full bg-green-500 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50"
          />
        </>
      ) : (
        <>
          <span aria-hidden className="size-3 rounded-full" />
          <span aria-hidden className="size-3 rounded-full" />
          <span aria-hidden className="size-3 rounded-full" />
        </>
      )}
    </div>
  );
}
