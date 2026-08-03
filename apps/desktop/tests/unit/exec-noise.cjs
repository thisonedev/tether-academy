'use strict';

// macOS emits kernel/codesign chatter on stderr when spawning sandboxed
// children. It must never reach the lesson output the user sees.

const test = require('brittle');

const { isNoiseLine, createNoiseFilter } = require('../../workers/peer/exec-noise.cjs');

test('exec-noise - recognises platform chatter', (t) => {
  t.is(isNoiseLine('task_name_for_pid: (os/kern) failure (5)'), true);
  t.is(isNoiseLine('[0731/203044.387077:ERROR:electron/shell/common/mac/codesign_util.cc:79]'), true);
});

test('exec-noise - leaves real output alone', (t) => {
  t.is(isNoiseLine('Error: spawn EPERM'), false, 'genuine errors must survive');
  t.is(isNoiseLine('modelId: abc'), false);
});

test('exec-noise - filters noise out of a mixed chunk', (t) => {
  const filter = createNoiseFilter();
  const out = filter.push(
    'modelId: x\n[0731:ERROR:codesign_util.cc:79] task_name_for_pid\nhello\n',
  );

  t.ok(out.includes('modelId: x'));
  t.ok(out.includes('hello'));
  t.absent(out.includes('codesign_util'));
  t.absent(out.includes('task_name_for_pid'));
  t.is(filter.end(), '', 'nothing buffered at end of stream');
});
