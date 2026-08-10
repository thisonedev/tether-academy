// Shared TypeScript types for the OS-level sandbox. Consumed by
// apps/desktop/electron/sandbox/ (the runtime) and apps/web/ (the
// admin UI that edits the dynamic allowlist JSON).

export interface TemplateVars {
  projectDir?: string;
  appRoot: string;
  /** pnpm workspace root (appRoot's grandparent); Linux binds hoisted deps from here. */
  workspaceRoot: string;
  coursesDir: string;
  homeDir: string;
  tmpDir: string;
  /** The child's only writable temp, and the TMPDIR it is given. */
  runDir: string;
  execDir: string;
  execPath: string;
  /** The app's own state directory. Denied in every profile. */
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
  /** Carved back out of a write grant that covers them. Applied after write. */
  readOnly?: PathSpec[];
}

export interface NetworkCapability {
  /** What the platform enforces: 'all' | 'localhost' | 'none'. */
  mode?: 'all' | 'localhost' | 'none';
  /** Documented intent when mode is 'all' (not a kernel filter on mac/linux). */
  hosts?: string[];
  /** @deprecated Use hosts + mode. */
  allow?: string[];
}

export interface ExecCapability {
  paths?: string[];
}

export interface EnvCapability {
  passThrough?: string[];
  block?: string[];
  /** Values forced into the child env regardless of the parent's, e.g. the
   *  TMPDIR that points the child at its own per-run scratch directory. */
  force?: Record<string, string>;
}

export interface PlatformOverrides {
  mac?: MacPlatformOverrides;
  linux?: LinuxPlatformOverrides;
  windows?: WindowsPlatformOverrides;
}

export interface MacPlatformOverrides {
  /** Absolute paths added to the profile's process-exec allowlist. */
  extraExecPaths?: string[];
  /** Regexes for bins whose paths are only known once npm has installed them. */
  extraExecRegex?: string[];
  /** Extra reads to refuse, on top of the ones generated from $HOME. */
  denyReadPaths?: string[];
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

/** Recording hardware. Granted per run, never from an allowlist file. */
export interface DeviceCapability {
  microphone?: boolean;
  camera?: boolean;
}

export interface Capability {
  fs?: FsCapability;
  network?: NetworkCapability;
  exec?: string[];
  device?: DeviceCapability;
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
  /** The scope the platform enforces, which can be wider than the capability's
   *  `network.mode` requested. */
  networkScope?: 'all' | 'localhost' | 'none';
  profilePath?: string;
  /** Resolved bare-runtime binary added to the exec allowlist, or null when
   *  it could not be resolved. */
  bareBin?: string | null;
  /** Directory of generated PATH shims for allowlisted tools, when used. */
  toolWrapperDir?: string | null;
  /** The run's scratch directory, whether the caller supplied it or not. */
  runDir?: string;
  /** Linux only. The compiled seccomp-bpf program the child's `--seccomp`
   *  descriptor must carry; see `openSeccompFd`. */
  seccompFilter?: Buffer;
}

export interface WrapOptions {
  dynamicPath?: string;
  cwd?: string;
  /** Add the bare runtime to the child's process-exec allowlist. */
  includeBare?: boolean;
  /** Explicit bare-runtime binary path; resolved automatically when absent. */
  bareRuntimeBinPath?: string | null;
  /** Granted for this run, e.g. `['microphone', 'network']`. */
  grants?: Array<keyof DeviceCapability | 'network' | 'network-loopback'>;
  /** Scratch for this run. One is created when absent. */
  runDir?: string;
  /** Which interpreter `command` is. Only 'node' needs the Electron guards. */
  runtime?: 'node' | 'bare';
  /**
   * Resolved userData from the host (`app.getPath('userData')`). The
   * capability profile denies this path; without the override, the
   * capability's default disagrees with the app's real state directory
   * when the host was launched with `--storage` or any userData override.
   */
  userData?: string;
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

export interface MacWrapResult extends MacWrap {
  /** sandbox-exec(1) is deprecated; this build of macOS no longer ships it. */
  sandboxExecMissing?: boolean;
}

export interface LinuxWrap extends MacWrap {
  bwrapMissing: boolean;
  /** bwrap is installed but the kernel refused it a user namespace. */
  namespacesUnavailable?: boolean;
  /** No seccomp syscall table for this architecture. */
  seccompUnavailable?: boolean;
  /** Compiled seccomp-bpf program for the spawning side to pass on a
   *  descriptor. Present only when the wrap is usable. */
  seccompFilter?: Buffer;
}

export interface WindowsWrap extends MacWrap {
  mode: 'windows-unavailable' | string;
  available?: boolean;
}
