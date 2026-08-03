import { z } from 'zod';

/** Max argv entries accepted from renderer or remote peer. */
export const MAX_EXEC_ARGV = 32;
/** Max bytes per argv entry. */
export const MAX_EXEC_ARGV_ENTRY = 4096;
/** Max source/code payload size (1 MiB). */
export const MAX_EXEC_SOURCE_BYTES = 1_000_000;
/** Allowed temp script extensions for peer-exec file mode. */
export const SAFE_EXEC_FILENAME_EXTS = ['.mts', '.mjs', '.js', '.ts', '.cjs'] as const;

/**
 * Host-side safe temp file name: basename only, no separators/traversal,
 * extension allowlist. Reject anything a remote peer could use for path abuse.
 */
export function isSafeExecFileName(name: string): boolean {
  if (typeof name !== 'string' || !name) return false;
  if (name !== name.normalize('NFC')) return false;
  if (name.length > 128) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.includes('..')) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  return SAFE_EXEC_FILENAME_EXTS.some((ext) => name.endsWith(ext));
}

const argvSchema = z
  .array(z.string().max(MAX_EXEC_ARGV_ENTRY))
  .max(MAX_EXEC_ARGV)
  .optional();

const fileNameSchema = z
  .string()
  .optional()
  .refine((v) => v === undefined || isSafeExecFileName(v), {
    message: 'fileName must be a safe basename with an allowed extension',
  });

export const academyRunPayloadSchema = z.object({
  source: z.string().min(1).max(MAX_EXEC_SOURCE_BYTES),
  language: z.string().min(1).max(64),
  argv: argvSchema,
  peerId: z.string().min(1).max(128).optional(),
  /** Human-readable run label shown in the paired-devices history. */
  label: z.string().max(200).optional(),
  /** Temp file name on the host. Internal; must be a safe basename. */
  fileName: fileNameSchema,
});

export const academyRunResultSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  remoteExit: z
    .object({ code: z.number().nullable(), signal: z.string().nullable() })
    .optional(),
});

export const academyRunChunkSchema = z.string();

/** Loose device metadata; never used as a trust signal. */
export const peerUserDataSchema = z
  .object({
    name: z.string().max(200).optional(),
    hostname: z.string().max(200).optional(),
    app: z.string().max(100).optional(),
    buildId: z.string().max(100).optional(),
    pairingCode: z.string().max(32).optional(),
  })
  .passthrough()
  .nullable()
  .optional();

// Renderer → main invite options. `.strict()` rejects autoApprove/code.
export const peerInviteOptsSchema = z
  .object({
    userData: peerUserDataSchema,
  })
  .strict()
  .optional()
  .default({});

/** Renderer → main accept options. Guest must supply the out-of-band code. */
export const peerAcceptOptsSchema = z
  .object({
    userData: peerUserDataSchema,
    code: z.string().max(64).nullable().optional(),
    hostIdentity: z.string().max(256).nullable().optional(),
  })
  .strict()
  .optional()
  .default({});

/** Absolute path of a file a lesson saved. Confined to the lesson folder in main. */
export const academyRevealPathSchema = z.string().min(1).max(4096);

export const peerRequestIdSchema = z.string().uuid();

/** Answer to a per-run device-access prompt (microphone/camera). */
export const peerDeviceConsentSchema = z.object({
  requestId: peerRequestIdSchema,
  approved: z.boolean(),
});

export const peerDiscoveryKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[0-9a-fA-F]+$/, 'discoveryKey must be hex');

export const peerAuditOptsSchema = z
  .object({
    since: z.number().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .strict()
  .optional()
  .default({});

export const peerInviteB64Schema = z.string().min(1).max(8192);

export const stateKeySchema = z.string().min(1).max(256);

/** Bounded value the renderer's academy:state:set may write; see state-store.cjs. */
export const MAX_STATE_VALUE_BYTES = 1_000_000;
const utf8 = new TextEncoder();
export const stateValueSchema = z.unknown().refine(
  (v) => {
    try {
      return utf8.encode(JSON.stringify(v) ?? '').byteLength <= MAX_STATE_VALUE_BYTES;
    } catch {
      return false;
    }
  },
  { message: `state value exceeds ${MAX_STATE_VALUE_BYTES} bytes when serialized` },
);

/** academy:state:set takes a single object so the renderer cannot smuggle a
 *  second positional argument past the schema check. */
export const stateSetSchema = z
  .object({
    key: stateKeySchema,
    value: stateValueSchema,
  })
  .strict();

/** Renderer → main accept takes a single object; replaces the two-argument
 *  form. `.strict()` keeps the invite's autoApprove/code rejection. */
export const peerAcceptSchema = z
  .object({
    inviteB64: peerInviteB64Schema,
    opts: peerAcceptOptsSchema,
  })
  .strict();

/** Max bytes accepted on one worker IPC frame. */
export const MAX_WORKER_IPC_BYTES = 1_000_000;

/** How long a copied pairing code or invite link may sit on the clipboard. */
export const CLIPBOARD_SCRUB_MS = 90_000;

export const clipboardCopySchema = z.object({
  text: z.string().min(1).max(8192),
  /** 0 leaves the text in place. Capped so a caller cannot park a scrub
   *  timer far enough out that it never runs. */
  scrubAfterMs: z.number().int().min(0).max(10 * 60_000).default(CLIPBOARD_SCRUB_MS),
});

/**
 * A model cache entry id, used as a relative path under the models root. Any
 * depth is allowed; what is rejected is anything that could leave the root.
 * `removeModel()` resolves and containment-checks the result as well, so this
 * is the earlier of two gates rather than the only one.
 */
export const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.includes('\0') && !v.includes('\\') && !v.startsWith('/'), {
    message: 'modelId must be a relative path with no backslashes or NUL',
  })
  .refine((v) => v.split('/').every((seg) => seg && seg !== '.' && seg !== '..'), {
    message: 'modelId must not contain empty or traversal segments',
  });

/** Worker module specifier. main.js compares it against the one it registered. */
export const workerSpecifierSchema = z.string().min(1).max(256);

/** One frame written to a worker's IPC pipe. Electron delivers a Buffer as a
 *  Uint8Array, and Buffer is a subclass, so both arrive here. */
export const workerIpcDataSchema = z.union([
  z.string().max(MAX_WORKER_IPC_BYTES),
  z
    .instanceof(Uint8Array)
    .refine((v) => v.byteLength <= MAX_WORKER_IPC_BYTES, {
      message: `worker IPC frame exceeds ${MAX_WORKER_IPC_BYTES} bytes`,
    }),
]);

/** 32-byte Ed25519 public key, hex-encoded. */
export const devicePublicKeyHexSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-fA-F]{64}$/, 'devicePublicKey must be 32-byte hex');

/** Mirrors identity/manager.cjs's own >=12-word check; belt-and-suspenders at the IPC boundary. */
export function isPlausibleMnemonic(v: unknown): v is string {
  return typeof v === 'string' && v.trim().split(/\s+/).length >= 12 && v.length <= 1024;
}
export const identityMnemonicSchema = z
  .string()
  .refine(isPlausibleMnemonic, { message: 'mnemonic must be at least 12 words' });

export const identityBeginAttestPayloadSchema = z
  .object({
    devicePublicKey: devicePublicKeyHexSchema,
    label: z.string().max(200).nullable().optional(),
  })
  .strict();

export const identityFinishAttestPayloadSchema = z
  .object({ sessionId: z.string().uuid(), confirm: z.literal(true) })
  .strict();

export const identitySessionIdSchema = z.string().uuid();

export function parseIpc<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`${label}: ${detail}`);
  }
  return result.data;
}
