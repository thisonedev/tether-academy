'use client';

// Wires the @qvac SDK type graph into Monaco's TypeScript worker. The build
// script (extract-sdk-types.mjs) walks the SDK's d.ts import graph, skips the
// 1.3 MB model registry lessons don't need, and writes each file as a JSON map
// registered as an extraLib at runtime, so new SDK types need no manual sync.

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

  // Virtual files live under the `qvac-sdk/` and `qvac-zod/` URI schemes; TypeScript's resolver follows the relative imports from there.
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
