// Shared TypeScript types for the OS-level sandbox. Consumed by
// apps/desktop/electron/sandbox/ (the runtime) and apps/web/ (the
// admin UI that edits the dynamic allowlist JSON).

export interface TemplateVars {
  projectDir?: string;
  appRoot: string;
  coursesDir: string;
  homeDir: string;
  tmpDir: string;
  execDir: string;
  execPath: string;
  userData: string;
  [key: string]: string | undefined;
}

// Path can be prefixed MAC: / LIN: / WIN: / COM: (or no prefix = all).
// Platform profile generators filter on the prefix.
export type PlatformPrefix = 'MAC:' | 'LIN:' | 'WIN:' | 'COM:' | '';

export type PathSpec = `${PlatformPrefix}${string}` | string;

export interface FsCapability {
  read?: PathSpec[];
  write?: PathSpec[];
}

export interface NetworkCapability {
  allow?: string[];
}

export interface ExecCapability {
  paths?: string[];
}

export interface EnvCapability {
  passThrough?: string[];
  block?: string[];
}

export interface PlatformOverrides {
  mac?: MacPlatformOverrides;
  linux?: LinuxPlatformOverrides;
  windows?: WindowsPlatformOverrides;
}

export interface MacPlatformOverrides {
  dockHideShim?: string;
  [key: string]: unknown;
}

export interface LinuxPlatformOverrides {
  [key: string]: unknown;
}

export interface WindowsPlatformOverrides {
  fallback?: 'restricted-token' | 'appcontainer';
  appContainerName?: string;
  [key: string]: unknown;
}

export interface Capability {
  fs?: FsCapability;
  network?: NetworkCapability;
  exec?: string[];
  env?: EnvCapability;
  platformOverrides?: PlatformOverrides;
  [key: string]: unknown;
}

export interface WrapResult {
  command: string;
  args: string[];
  env: Record<string, string>;
  warnings: string[];
  sandboxed: boolean;
  mode: string;
  profilePath?: string;
}

export interface WrapOptions {
  dynamicPath?: string;
  cwd?: string;
}

// Subset of Capability the dynamic JSON file can hold. Merged
// additively into the static baseline at spawn time.
export interface DynamicCapabilityFile {
  fs?: Partial<FsCapability>;
  network?: Partial<NetworkCapability>;
  exec?: string[];
  env?: Partial<EnvCapability>;
  platformOverrides?: Partial<PlatformOverrides>;
}

export type ProductName = string;

export interface MacWrap {
  command: string;
  args: string[];
  env: Record<string, string>;
  warnings: string[];
}

export interface LinuxWrap extends MacWrap {
  bwrapMissing: boolean;
}

export interface WindowsWrap extends MacWrap {
  mode: 'passthrough';
}
