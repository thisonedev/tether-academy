// @ts-check
'use strict';

import type {
  Capability,
  DynamicCapabilityFile,
  ProductName,
  WrapOptions,
  WrapResult,
} from '@academy/sandbox-types';

export type {
  Capability,
  DynamicCapabilityFile,
  ProductName,
  WrapOptions,
  WrapResult,
};

/**
 * Wrap a child spawn with a platform-specific sandbox.
 *
 * @example
 *   const r = wrapSpawn(process.execPath, ['-e', '...'], {}, 'qvac');
 *   spawn(r.command, r.args, { env: { ...process.env, ...r.env } });
 */
export function wrapSpawn(
  command: string,
  args: string[],
  options: WrapOptions,
  capabilities: ProductName | Capability,
): WrapResult;

export function listProductNames(): string[];

/** Filtered env: only passThrough names pass; block always wins. */
export function buildEnv(
  parentEnv: NodeJS.ProcessEnv,
  capEnv: Capability['env'],
): NodeJS.ProcessEnv;

/** Default path for the dynamic capability JSON. Lives outside the
 * child's write allowlist so it can't tamper with it. */
export function defaultDynamicPath(): string;
