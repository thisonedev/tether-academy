// @ts-check
'use strict';

import type { Capability, WindowsWrap } from '@academy/sandbox-types';

export type { WindowsWrap };

export function supportsAppContainer(): boolean;

/** Passthrough wrap (no sandbox). */
export function passthrough(command: string, childArgs: string[]): WindowsWrap;

/** Build the wrap. Always returns passthrough with documented
 * gap warnings until AppContainer is implemented. */
export function buildWrap(
  cap: Capability,
  command: string,
  childArgs?: string[],
): WindowsWrap;
