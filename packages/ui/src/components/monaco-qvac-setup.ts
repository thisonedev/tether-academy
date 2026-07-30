'use client';

// Wires the @qvac SDK type graph into Monaco's TypeScript worker.
//
// Instead of bundling the SDK's d.ts into one string, the build
// script (extract-sdk-types.mjs) walks the SDK's import graph
// from index.d.ts, skips the 1.3 MB model registry that lessons
// don't need, and writes each reachable file as a JSON map with
// portable URIs (qvac-sdk/<relative-path>). At runtime we
// register each file as an extraLib at that URI; TypeScript's
// own module resolver handles the rest. The result: zero
// maintenance — when the SDK ships a new type, the next build
// picks it up automatically.

import sdkFiles from '../generated/sdk-types-files.json';
import { QVAC_DARK_TOKEN_RULES, QVAC_DARK_COLORS, QVAC_THEME_NAME } from './qvac-theme.js';
import type { Monaco } from '@monaco-editor/react';

type SdkFile = { path: string; content: string };

const SDK_ENTRY_URI = 'qvac-sdk/index.d.ts';
const SDK_MODULE_SPECIFIER = '@qvac/sdk';
const SDK_FILES: SdkFile[] = sdkFiles as SdkFile[];

let installed = false;

export function setupQvacMonaco(monaco: Monaco): void {
  if (installed) return;
  installed = true;

  const ts = monaco.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    esModuleInterop: true,
    strict: false,
    skipLibCheck: true,
    noEmit: true,
    isolatedModules: true,
    baseUrl: '',
    paths: {
      'zod': ['qvac-zod/v4/index.d.ts'],
      '@qvac/sdk': ['qvac-sdk/index.d.ts'],
    },
  });
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });

  // The SDK's own d.ts uses Node module resolution. Our virtual
  // files live under the `qvac-sdk/` and `qvac-zod/` URI schemes;
  // TypeScript's own resolver follows the relative imports to
  // (qvac-sdk/schemas/index.d.ts, qvac-sdk/client/api/index.d.ts, …).
  ts.typescriptDefaults.setExtraLibs(
    SDK_FILES.map((f) => ({ content: f.content, filePath: f.path })),
  );

  monaco.editor.defineTheme(QVAC_THEME_NAME, {
    base: 'vs-dark',
    inherit: true,
    rules: QVAC_DARK_TOKEN_RULES,
    colors: QVAC_DARK_COLORS,
  });
}

export const QVAC_THEME = QVAC_THEME_NAME;
export const QVAC_SDK_MODULE = SDK_MODULE_SPECIFIER;
export const QVAC_SDK_ENTRY = SDK_ENTRY_URI;
