// @ts-check
'use strict';

// A seccomp-bpf program for the bwrap child, in the classic BPF encoding the
// kernel installs directly. bwrap reads a compiled program from a file
// descriptor and applies it after the namespace is built and before exec.
// Every other bwrap flag is per-path or per-namespace, which leaves this as
// the one place a syscall can be named.
//
// Syscall numbers differ per architecture and nothing looks them up at
// runtime, so an architecture this file does not name gets no filter and
// buildFilter returns null. The caller then refuses the spawn.

// struct seccomp_data field offsets.
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;

// linux/bpf_common.h opcodes.
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const RET_K = 0x06;

// linux/seccomp.h actions. EPERM and not a kill, so a run that trips the
// filter reports a permission error the lesson author can read.
const RET_ALLOW = 0x7fff0000;
const RET_EPERM = 0x00050001;

// linux/audit.h.
const AUDIT_ARCH = {
  x64: 0xc000003e,
  arm64: 0xc00000b7,
};

// A name the kernel does not have on an architecture is left out of that
// table. The mount-API calls added in 5.2 were given the same numbers
// everywhere, so those two columns agree.
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
    // No `symlink` here; aarch64 only has the -at form, and glibc's symlink()
    // routes through it.
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

// ptrace reads another process's memory, and the QVAC worker is a sibling in
// the same namespace. The mount family rewrites the bind layout the sandbox is
// made of. unshare and setns hand the child a fresh namespace where none of it
// applies.
//
// The symlink calls are the bwrap counterpart of the macOS profile's
// `(deny file-write-create (vnode-type SYMLINK))`. bwrap enforces per mount,
// so a link planted in a writable bind gets followed on the way out of it.
// Creating ordinary files in a writable bind still works.
//
// Hardlinks are the same class of trick and stay allowed on both platforms.
// link(2) needs its target on the same filesystem, which makes it a narrower
// reach than a symlink. Recorded as a residual, not as a closed hole.
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
 * The calls this filter denies on an architecture, in program order. Names the
 * architecture does not have drop out, so this is shorter than BLOCKED there.
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
 * The compiled program, or null on an architecture with no syscall table here.
 *
 * Layout: check the arch word first, since syscall numbers mean nothing without
 * it, then compare the syscall number against each blocked entry and jump to a
 * single EPERM return. Anything that falls through is allowed.
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
    // A process running in a compat personality reports a different arch word,
    // and its syscall numbers would not be the ones checked below.
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
