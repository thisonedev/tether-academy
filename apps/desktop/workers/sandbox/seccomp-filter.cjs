// @ts-check
'use strict';

// Seccomp-bpf program for the bwrap child, applied after the namespace is
// built and before exec. This is the only place a syscall can be named;
// every other bwrap flag is per-path or per-namespace. An architecture not
// named in SYSCALLS gets no filter, and the caller refuses the spawn.

const OFFSET_NR = 0;
const OFFSET_ARCH = 4;

// linux/bpf_common.h opcodes.
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const RET_K = 0x06;

// EPERM (not a kill) so a trip reports a readable permission error.
const RET_ALLOW = 0x7fff0000;
const RET_EPERM = 0x00050001;

const AUDIT_ARCH = {
  x64: 0xc000003e,
  arm64: 0xc00000b7,
};

// A name absent from an arch's table is left out; mount-API calls added in
// 5.2 share the same numbers on both arches.
const SYSCALLS = {
  x64: {
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
    symlink: 88,
    symlinkat: 266,
    mount: 165,
    umount2: 166,
    pivot_root: 155,
    open_tree: 428,
    move_mount: 429,
    fsopen: 430,
    fsconfig: 431,
    fsmount: 432,
    fspick: 433,
    unshare: 272,
    setns: 308,
  },
  arm64: {
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
    // No `symlink` here: aarch64 only has the -at form; glibc's symlink() routes through it.
    symlinkat: 36,
    mount: 40,
    umount2: 39,
    pivot_root: 41,
    open_tree: 428,
    move_mount: 429,
    fsopen: 430,
    fsconfig: 431,
    fsmount: 432,
    fspick: 433,
    unshare: 97,
    setns: 268,
  },
};

// ptrace/memory syscalls can read a sibling process's memory (QVAC shares
// this namespace); mount/unshare/setns can rewrite or escape the sandbox.
const BLOCKED = [
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'symlink',
  'symlinkat',
  'mount',
  'umount2',
  'pivot_root',
  'open_tree',
  'move_mount',
  'fsopen',
  'fsconfig',
  'fsmount',
  'fspick',
  'unshare',
  'setns',
];

/** One `struct sock_filter`: u16 code, u8 jt, u8 jf, u32 k. */
function instruction(code, jt, jf, k) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(code, 0);
  buf.writeUInt8(jt, 2);
  buf.writeUInt8(jf, 3);
  buf.writeUInt32LE(k >>> 0, 4);
  return buf;
}

/**
 * Denied calls for an architecture, in program order; missing names drop out.
 * @param {string} [arch]
 * @returns {string[] | null}
 */
function blockedCalls(arch = process.arch) {
  const table = SYSCALLS[arch];
  if (!table) return null;
  return BLOCKED.filter((name) => typeof table[name] === 'number');
}

/**
 * The syscall numbers this filter denies on an architecture, in program order.
 * @param {string} [arch]
 * @returns {number[] | null}
 */
function blockedNumbers(arch = process.arch) {
  const names = blockedCalls(arch);
  if (!names) return null;
  return names.map((name) => SYSCALLS[arch][name]);
}

/**
 * Compiled program, or null with no syscall table for the architecture.
 * Checks the arch word, then each blocked syscall number, jumping to EPERM.
 * @param {string} [arch]
 * @returns {Buffer | null}
 */
function buildFilter(arch = process.arch) {
  const numbers = blockedNumbers(arch);
  const auditArch = AUDIT_ARCH[arch];
  if (!numbers || numbers.length === 0 || !auditArch) return null;

  const denyIndex = numbers.length + 5;
  const program = [
    instruction(LD_W_ABS, 0, 0, OFFSET_ARCH),
    // A compat-personality process reports a different arch word, so its syscall numbers wouldn't match below.
    instruction(JEQ_K, 1, 0, auditArch),
    instruction(RET_K, 0, 0, RET_EPERM),
    instruction(LD_W_ABS, 0, 0, OFFSET_NR),
  ];
  // jt counts forward from the instruction after this one.
  numbers.forEach((nr, i) => {
    program.push(instruction(JEQ_K, numbers.length - i, 0, nr));
  });
  program.push(instruction(RET_K, 0, 0, RET_ALLOW));
  program.push(instruction(RET_K, 0, 0, RET_EPERM));

  if (program.length !== denyIndex + 1) {
    throw new Error('seccomp: program length does not match the computed deny offset');
  }
  return Buffer.concat(program);
}

module.exports = {
  buildFilter,
  blockedCalls,
  blockedNumbers,
  BLOCKED,
  SYSCALLS,
  AUDIT_ARCH,
  RET_ALLOW,
  RET_EPERM,
};
