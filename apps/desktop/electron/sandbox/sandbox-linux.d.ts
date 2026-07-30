// @ts-check
'use strict';

import type { Capability, LinuxWrap } from '@academy/sandbox-types';

export type { LinuxWrap };

export const DEFAULT_BWRAP: string;

/** Look up bwrap on PATH. Returns the absolute path or null. */
export function findBwrap(): string | null;

/** Build the bwrap argv (without the bwrap binary itself). */
export function buildBwrapArgs(
  cap: Capability,
  options?: { bwrapPath?: string; warnings?: string[] },
): string[];

/** Build the full wrap. Returns a passthrough with a warning if
 * bwrap is not on PATH. */
export function buildWrap(
  cap: Capability,
  command: string,
  childArgs?: string[],
  options?: { bwrapPath?: string },
): LinuxWrap;
