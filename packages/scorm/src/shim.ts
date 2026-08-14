// Bundled standalone (esbuild --bundle --format=iife), injected into every
// exported lesson page. Implements window.academy.state over SCORM 1.2 so
// academy-storage.ts's existing fallback picks it up with no app changes.

type ScormAPI = {
  LMSInitialize: (param: string) => string;
  LMSFinish: (param: string) => string;
  LMSGetValue: (name: string) => string;
  LMSSetValue: (name: string, value: string) => string;
  LMSCommit: (param: string) => string;
  LMSGetLastError: () => string;
};

declare global {
  interface Window {
    API?: ScormAPI;
    __SCORM_LESSON_KEY__?: string;
    academy?: {
      state: {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string) => Promise<void>;
        remove: (key: string) => Promise<void>;
        list: () => Promise<Array<{ key: string; value: string }>>;
      };
    };
  }
}

const USER_STORE_KEY = 'tether-academy-user';

function findAPI(startWin: Window): ScormAPI | null {
  let win: Window | null = startWin;
  let tries = 0;
  while (win && !win.API && win.parent && win.parent !== win) {
    tries++;
    if (tries > 500) return null;
    win = win.parent;
  }
  return win?.API ?? null;
}

function getAPI(): ScormAPI | null {
  const direct = findAPI(window);
  if (direct) return direct;
  if (window.opener) return findAPI(window.opener);
  return null;
}

function studentName(api: ScormAPI): string {
  const raw = api.LMSGetValue('cmi.core.student_name') || '';
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length === 2 && parts[0] && parts[1]) return `${parts[1]} ${parts[0]}`;
  return raw || 'Learner';
}

function init(): void {
  const api = getAPI();
  if (!api) return;

  const initialized = api.LMSInitialize('') === 'true';
  if (!initialized) return;

  let store: Record<string, string> = {};
  const rawSuspend = api.LMSGetValue('cmi.suspend_data') || '';
  if (rawSuspend) {
    try {
      store = JSON.parse(rawSuspend);
    } catch {
      store = {};
    }
  }

  function persist(): void {
    api!.LMSSetValue('cmi.suspend_data', JSON.stringify(store));
    api!.LMSCommit('');
  }

  if (!store[USER_STORE_KEY]) {
    store[USER_STORE_KEY] = JSON.stringify({
      state: { username: studentName(api), points: 0, completedChapters: [], completedLessons: [] },
      version: 0,
    });
  }

  function syncGradebook(): void {
    const lessonKey = window.__SCORM_LESSON_KEY__;
    if (!lessonKey) return;
    const raw = store[USER_STORE_KEY];
    if (!raw) return;
    let parsed: { state?: { completedLessons?: string[] } };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const done = (parsed.state?.completedLessons ?? []).includes(lessonKey);
    api!.LMSSetValue('cmi.core.score.raw', done ? '100' : '0');
    api!.LMSSetValue('cmi.core.score.min', '0');
    api!.LMSSetValue('cmi.core.score.max', '100');
    api!.LMSSetValue('cmi.core.lesson_status', done ? 'completed' : 'incomplete');
  }

  syncGradebook();
  persist();

  window.academy = {
    state: {
      async get(key) {
        return store[key] ?? null;
      },
      async set(key, value) {
        store[key] = value;
        if (key === USER_STORE_KEY) syncGradebook();
        persist();
      },
      async remove(key) {
        delete store[key];
        persist();
      },
      async list() {
        return Object.entries(store).map(([key, value]) => ({ key, value }));
      },
    },
  };

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    persist();
    api!.LMSFinish('');
  };
  window.addEventListener('pagehide', finish);
  window.addEventListener('beforeunload', finish);
}

function suppressChunkLoadErrors(): void {
  const isChunkLoadError = (err: unknown) =>
    err instanceof Error && (err.name === 'ChunkLoadError' || /loading chunk .* failed/i.test(err.message));
  window.addEventListener(
    'error',
    (e) => {
      if (isChunkLoadError(e.error)) e.preventDefault();
    },
    true,
  );
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkLoadError(e.reason)) e.preventDefault();
  });
}

function interceptInternalLinks(): void {
  document.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (anchor.target === '_blank' || href.startsWith('#') || href.startsWith('mailto:')) return;
      if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(href)) return;
      e.stopPropagation();
    },
    true,
  );
}

suppressChunkLoadErrors();
init();
interceptInternalLinks();
