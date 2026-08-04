'use strict';

// The seccomp program bwrap installs on the Linux child; bwrap flags are
// per-path and per-namespace, so this is the only thing standing between a
// run and ptrace or a remount of the sandbox's bind layout. The kernel that
// would enforce it isn't the one running these tests, so it's decoded and
// read instruction by instruction.

const test = require('brittle');

const seccomp = require('../../workers/sandbox/seccomp-filter.cjs');

// struct sock_filter, 8 bytes each.
function decode(filter) {
  const out = [];
  for (let i = 0; i < filter.length; i += 8) {
    out.push({
      code: filter.readUInt16LE(i),
      jt: filter.readUInt8(i + 2),
      jf: filter.readUInt8(i + 3),
      k: filter.readUInt32LE(i + 4),
    });
  }
  return out;
}

for (const arch of ['x64', 'arm64']) {
  test(`seccomp - ${arch} denies every blocked call and allows the rest`, (t) => {
    const program = decode(seccomp.buildFilter(arch));
    const names = seccomp.blockedCalls(arch);
    const numbers = seccomp.blockedNumbers(arch);
    const denyIndex = program.length - 1;

    t.is(program[0].k, 4, 'the arch word is read first');
    t.is(program[1].k, seccomp.AUDIT_ARCH[arch], 'and compared against this arch');
    t.is(program[2].k, seccomp.RET_EPERM, 'a different arch reports different numbers, so deny');
    t.is(program[3].k, 0, 'then the syscall number is read');
    t.is(program[denyIndex].k, seccomp.RET_EPERM, 'the last instruction is the denial');
    t.is(program[denyIndex - 1].k, seccomp.RET_ALLOW, 'anything falling through is allowed');

    for (const [i, nr] of numbers.entries()) {
      const at = 4 + i;
      t.is(program[at].k, nr, `compares ${names[i]}`);
      // jt counts forward from the instruction after this one.
      t.is(at + 1 + program[at].jt, denyIndex, `and jumps ${names[i]} to the denial`);
      t.is(program[at].jf, 0, 'a miss falls through to the next comparison');
    }
  });
}

test('seccomp - the syscall numbers are the per-arch ones', (t) => {
  // Wrong numbers deny an unrelated call and let the intended one through, unnoticed elsewhere in the tree.
  t.is(seccomp.SYSCALLS.x64.ptrace, 101);
  t.is(seccomp.SYSCALLS.arm64.ptrace, 117);
  t.is(seccomp.SYSCALLS.x64.mount, 165);
  t.is(seccomp.SYSCALLS.arm64.mount, 40);
  t.is(seccomp.SYSCALLS.x64.unshare, 272);
  t.is(seccomp.SYSCALLS.arm64.unshare, 97);
  t.is(seccomp.SYSCALLS.x64.setns, 308);
  t.is(seccomp.SYSCALLS.arm64.setns, 268);
  // The mount API added in 5.2 was numbered the same on every architecture.
  t.is(seccomp.SYSCALLS.x64.fsopen, seccomp.SYSCALLS.arm64.fsopen);
});

// bwrap enforces per mount; this is the Linux counterpart of the macOS profile's (deny file-write-create (vnode-type SYMLINK)).
test('seccomp - a run can create files in its writable binds but not links', (t) => {
  for (const arch of ['x64', 'arm64']) {
    const denied = seccomp.blockedCalls(arch);
    t.ok(denied.includes('symlinkat'), `${arch}: the -at form is denied`);
    t.absent(denied.includes('open'), `${arch}: ordinary file creation still works`);
    t.absent(denied.includes('openat'), `${arch}: ordinary file creation still works`);
  }
  // aarch64 has no bare symlink(2); glibc routes symlink() through symlinkat.
  t.ok(seccomp.blockedCalls('x64').includes('symlink'), 'x64 has both forms');
  t.absent(seccomp.blockedCalls('arm64').includes('symlink'), 'arm64 has only the -at form');
});

test('seccomp - an architecture with no table gets no filter', (t) => {
  t.is(seccomp.buildFilter('mips'), null, 'so the caller refuses the spawn');
  t.is(seccomp.blockedNumbers('mips'), null);
});

test('seccomp - the program is a whole number of instructions', (t) => {
  for (const arch of ['x64', 'arm64']) {
    const filter = seccomp.buildFilter(arch);
    t.is(filter.length % 8, 0, `${arch}: the kernel reads 8-byte instructions`);
    t.is(filter.length / 8, seccomp.blockedCalls(arch).length + 6);
  }
});
