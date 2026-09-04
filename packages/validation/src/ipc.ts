import { z } from 'zod';

/** Max argv entries accepted from renderer or remote peer. */
export const MAX_EXEC_ARGV = 32;
export const MAX_EXEC_ARGV_ENTRY = 4096;
/** Max source/code payload size (1 MiB). */
export const MAX_EXEC_SOURCE_BYTES = 1_000_000;
/** Allowed temp script extensions for peer-exec file mode. */
export const SAFE_EXEC_FILENAME_EXTS = ['.mts', '.mjs', '.js', '.ts', '.cjs'] as const;

/** Host-side safe temp file name: basename only, no separators or traversal, with an extension allowlist. */
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
  /** Forwarded to a paired peer as `declared.lessonReference`. Only meaningful with `peerId`. */
  lessonReference: z.string().max(8_000).optional(),
});

export const academyRunResultSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  remoteExit: z
    .object({ code: z.number().nullable(), signal: z.string().nullable() })
    .optional(),
  /** True when the user clicked Stop while the run was still healthy. Lets the
   *  UI render a neutral "stopped" note instead of a red "[exit non-zero]". */
  stopRequested: z.boolean().optional(),
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

/** Cap on `academy:readSaved` responses. Models never exceed ~6 MB but a
 *  generated MP4 clip can run higher, so this is sized for video, not images. */
export const MAX_READ_SAVED_BYTES = 64 * 1024 * 1024;

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

/** academy:state:set takes a single object argument, validated as one unit. */
export const stateSetSchema = z
  .object({
    key: stateKeySchema,
    value: stateValueSchema,
  })
  .strict();

/** Renderer → main accept takes a single object; `.strict()` keeps the invite's autoApprove/code rejection. */
export const peerAcceptSchema = z
  .object({
    inviteB64: peerInviteB64Schema,
    opts: peerAcceptOptsSchema,
  })
  .strict();

export const MAX_WORKER_IPC_BYTES = 1_000_000;

/** How long a copied pairing code or invite link may sit on the clipboard. */
export const CLIPBOARD_SCRUB_MS = 90_000;

export const clipboardCopySchema = z.object({
  text: z.string().min(1).max(8192),
  /** 0 leaves the text in place; capped to keep the scrub timer bounded. */
  scrubAfterMs: z.number().int().min(0).max(10 * 60_000).default(CLIPBOARD_SCRUB_MS),
});

export const academyRagSearchSchema = z.object({
  documents: z.array(z.string().min(1)).min(1).max(50),
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional(),
});

export const academyTranslateSchema = z.object({
  text: z.string().min(1).max(20_000),
  /** Matches a key in translate.cjs's NMT_PRESETS (English source only). */
  language: z.string().min(1).max(64),
});

/** A `data:` URL, as read from a picked file via FileReader in the renderer. */
export const academyImageInputSchema = z.object({
  image: z.string().min(1).max(25_000_000),
});

export const academyTextToSpeechSchema = z.object({
  text: z.string().min(1).max(5_000),
});

export const academySpeechToTextSchema = z.object({
  audio: z.string().min(1).max(60_000_000),
});

export const academyGenerateImageSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  model: z.string().min(1).max(64).optional(),
});

export const academyGenerateVideoSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  model: z.string().min(1).max(64).optional(),
  frames: z.number().int().min(1).max(200).optional(),
  steps: z.number().int().min(1).max(150).optional(),
});

export const academyGenerateMusicSchema = z.object({
  caption: z.string().min(1).max(2_000),
  durationSec: z.number().int().min(1).max(60).optional(),
});

/** A playground credential's name: the only thing a workflow JSON is ever allowed to store, never the secret itself. */
export const playgroundCredentialNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'credential name must be letters, digits, dot, dash, or underscore');

export const playgroundCredentialSetSchema = z.object({
  name: playgroundCredentialNameSchema,
  value: z.string().min(1).max(8192),
});

/** A model cache entry id, used as a relative path under the models root; `removeModel()` containment-checks the resolved result too, so this is the earlier of two gates. */
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

// Loose on purpose; the manager's regex (not this schema) enforces the
// actual username rules.
export const identityUsernameSchema = z.object({ username: z.string().min(1).max(64) }).strict();

// Progress is open JSON; bounded so a runaway renderer can't fill the disk.
export const MAX_PROGRESS_BYTES = 256 * 1024;
export const identityProgressSchema = z
  .object({ progress: z.record(z.string().min(1).max(128), z.unknown()) })
  .strict()
  .refine((v) => JSON.stringify(v).length <= MAX_PROGRESS_BYTES, {
    message: `progress exceeds ${MAX_PROGRESS_BYTES} bytes`,
  });

export const identityVerifyAttestedSchema = z
  .object({
    kind: z.string().min(1).max(64),
    payload: z.unknown(),
    proofB64: z.string().min(1).max(8192),
    expectedIdentityPublicKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  })
  .strict();

// Untrusted peer profile blob; the renderer marks it "unverified" until
// verifyAttested confirms it.
export const identityImportProfileSchema = z
  .object({
    identityPublicKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
    profile: z.unknown(),
  })
  .strict();

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

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(32_000),
});

export const chatLessonKeySchema = z
  .object({
    chapter: z.string().min(1).max(64),
    lesson: z.string().min(1).max(128),
  })
  .strict()
  .nullable();

// Bounded facts supplied by the renderer; the host does not guess a content API.
export const chatLessonReferenceSchema = z.string().max(8_000).optional();

// When true, the host fetches the public QVAC docs and injects them into the
// system prompt. The renderer decides based on navigator.onLine + a user toggle.
export const chatUseFullDocsSchema = z.boolean().optional();

export const chatSendSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(64),
    lessonKey: chatLessonKeySchema,
    lessonReference: chatLessonReferenceSchema,
    useFullDocs: chatUseFullDocsSchema,
    /**
     * Filename of the catalogue model the renderer wants to use. When omitted,
     * the host picks the smallest installed chat model automatically.
     */
    modelHint: z.string().min(1).max(256).optional(),
  })
  .strict();

export const chatVerifyTestSchema = z
  .object({
    id: z.string().min(1).max(128),
    description: z.string().min(1).max(500),
  })
  .strict();

export const chatVerifySchema = z
  .object({
    code: z.string().min(1).max(20_000),
    tests: z.array(chatVerifyTestSchema).min(1).max(32),
    lessonKey: chatLessonKeySchema,
    lessonReference: chatLessonReferenceSchema,
    /** Canonical solution; omitted for lessons with no vendored answer file. */
    answer: z.string().max(20_000).optional(),
    /** Filename of the catalogue model to grade with; omitted uses whatever the host already has loaded/configured. */
    modelHint: z.string().min(1).max(256).optional(),
  })
  .strict();

/** Payload for the pre-flight security scan a submission gets before it may
 *  ship to a paired device. Mirrors chatVerifySchema minus the checklist. */
export const chatSecuritySchema = z
  .object({
    code: z.string().min(1).max(20_000),
    lessonKey: chatLessonKeySchema,
    lessonReference: chatLessonReferenceSchema,
    modelHint: z.string().min(1).max(256).optional(),
  })
  .strict();

export const chatRequestIdSchema = z.string().min(1).max(128);

export const chatLoadSchema = z.string().min(1).max(256);

// Null is the documented way to ask without a lesson in mind, which is what
// the console sends when it wants the best model already on disk.
export const modelLessonKeySchema = z
  .object({
    chapter: z.string().min(1).max(64),
    lesson: z.string().min(1).max(128),
  })
  .strict()
  .nullable();
