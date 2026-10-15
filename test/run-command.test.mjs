import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand, requireCommandSuccess } from '../src/run-command.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function options(root, args, extra = {}) {
  return {
    executable: process.execPath,
    args,
    cwd: root,
    stdoutPath: join(root, 'stdout.txt'),
    stderrPath: join(root, 'stderr.txt'),
    timeoutMs: 5000,
    ...extra,
  };
}

test('command receipt preserves nonzero exit status and separate output streams', async (t) => {
  const root = await workspace(t);
  const result = await runCommand(options(root, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7;']));
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(await readFile(result.stdoutPath, 'utf8'), 'out');
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'err');
  assert.throws(() => requireCommandSuccess(result, 'Fixture'), /exit 7/);
});

test('spawn failures resolve with a failed command receipt and closed logs', async (t) => {
  const root = await workspace(t);
  const result = await runCommand(options(root, [], { executable: join(root, 'missing-executable') }));
  assert.match(result.error, /ENOENT/);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(await readFile(result.stdoutPath, 'utf8'), '');
  assert.equal(await readFile(result.stderrPath, 'utf8'), '');
  assert.throws(() => requireCommandSuccess(result, 'Fixture'), /ENOENT/);
});

async function running(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') {
    // A reparented child can remain a zombie until the container's init reaps
    // it. Zombies have exited and cannot keep doing work or write to logs.
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (/^\d+ \(.*\) Z /.test(stat)) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

test('timeout kills a descendant that ignores SIGTERM after its parent exits', { skip: process.platform === 'win32' }, async (t) => {
  const root = await workspace(t);
  const childPath = join(root, 'child.cjs');
  const parentPath = join(root, 'parent.cjs');
  const pidPath = join(root, 'child.pid');
  const readyPath = join(root, 'child.ready');
  let ownedPid;
  await writeFile(childPath, `const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`);
  await writeFile(parentPath, `const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath,
  [${JSON.stringify(childPath)}, ${JSON.stringify(readyPath)}], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  try {
    const result = await runCommand(options(root, [parentPath], { timeoutMs: 1500 }));
    ownedPid = Number(await readFile(pidPath, 'utf8'));
    assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
    assert.equal(await readFile(readyPath, 'utf8'), 'ready', 'Descendant must install its SIGTERM handler before the timeout.');
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGTERM');
    assert.throws(() => requireCommandSuccess(result, 'Fixture'), /deadline exceeded/);
    const deadline = Date.now() + 2000;
    while (await running(ownedPid)) {
      assert.ok(Date.now() < deadline, 'Owned descendant survived command timeout cleanup.');
      await delay(20);
    }
  } finally {
    // Preserve cleanup when testing the previously broken implementation too.
    if (!ownedPid) {
      try { ownedPid = Number(await readFile(pidPath, 'utf8')); } catch {}
    }
    if (Number.isSafeInteger(ownedPid) && ownedPid > 0) {
      try { process.kill(ownedPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});

test('stderr open failure closes the already-open stdout descriptor', { skip: process.platform !== 'linux' }, async (t) => {
  const root = await workspace(t);
  const stdoutPath = join(root, 'stdout.txt');
  const stderrPath = join(root, 'stderr.txt');
  await writeFile(stderrPath, 'existing user log');
  await assert.rejects(runCommand(options(root, [], { stdoutPath, stderrPath })), { code: 'EEXIST' });
  const destinations = await Promise.all((await readdir('/proc/self/fd')).map(async (fd) => {
    try { return await readlink(`/proc/self/fd/${fd}`); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }));
  assert.ok(!destinations.includes(stdoutPath), 'stdout descriptor leaked when opening stderr failed.');
  assert.equal(await readFile(stdoutPath, 'utf8'), '');
  assert.equal(await readFile(stderrPath, 'utf8'), 'existing user log');
});
