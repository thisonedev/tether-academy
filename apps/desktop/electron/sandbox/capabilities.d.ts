// @ts-check
'use strict';

const PREFIX = { darwin: 'MAC', linux: 'LIN', win32: 'WIN' };

export const CAPABILITIES: Record<string, Capability>;
export const PRODUCT_NAMES: string[];

export function platformFilter(
  entries: string[] | undefined,
  platform: NodeJS.Platform,
): string[];

export function expandDeep<T = unknown>(value: T, scope?: TemplateVars): T;

export function resolveTemplate(value: unknown, scope: TemplateVars): unknown;

export function defaultTemplateVars(overrides?: {
  projectDir?: string;
  execDir?: string;
}): TemplateVars;

export function resolveExecName(binName: string): string | null;

export function resolveExecNames(execList: string[] | undefined): {
  found: string[];
  missing: string[];
};

export function loadDynamicCapabilities(
  filePath: string,
): DynamicCapabilityFile | null;

export function mergeCapabilities(
  base: Capability,
  dynamic: DynamicCapabilityFile,
): Capability;

export function getCapabilities(name: string): Capability;

export type {
  TemplateVars,
  Capability,
  FsCapability,
  NetworkCapability,
  EnvCapability,
  PlatformOverrides,
  MacPlatformOverrides,
  LinuxPlatformOverrides,
  WindowsPlatformOverrides,
  DynamicCapabilityFile,
  ProductName,
} from '@academy/sandbox-types';
