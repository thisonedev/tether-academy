// @ts-check
'use strict';

import type { Capability, MacWrap } from '@academy/sandbox-types';

export type { MacWrap };

/** Build a default-deny sandbox-exec profile. */
export function buildProfile(capabilityName?: string): string;

/** Write the profile to a unique file in tmpdir; returns its path. */
export function writeProfile(
  profile: string,
  options?: { tmpdir?: string },
): string;

/** Build the wrap: `sandbox-exec -f <profilePath> <command> <args...>`. */
export function buildWrap(
  profilePath: string,
  command: string,
  args?: string[],
): MacWrap;

export function platformFilter(
  entries: string[] | undefined,
  platform: NodeJS.Platform,
): string[];

/** Exposed for tests. */
export function _allowRules(
  cap: Capability,
  options?: { warnings?: string[] },
): string[];
