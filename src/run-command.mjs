import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

/** Run an owned child, retaining its actual output and exit status. */
export async function runCommand({ executable, args, cwd, stdoutPath, stderrPath, timeoutMs }) {
  const stdout = await open(stdoutPath, 'wx');
  let stderr;
  try {
    stderr = await open(stderrPath, 'wx');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    return await new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd, env, shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', stdout.fd, stderr.fd],
      });
      let spawnError;
      let timedOut = false;
      let hardStop;
      const terminate = (signal) => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill(signal);
          }
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') spawnError ??= error.message;
        }
      };
      const deadline = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
        hardStop = setTimeout(() => terminate('SIGKILL'), 5000);
      }, timeoutMs);
      child.on('error', (error) => { spawnError = error.message; });
      child.on('close', (exitCode, signal) => {
        clearTimeout(deadline);
        // A timed-out parent can exit on SIGTERM while descendants ignore it.
        // Kill the remaining owned group before returning, even after its
        // original leader has exited. No timer may send signals after return.
        if (timedOut && process.platform !== 'win32') terminate('SIGKILL');
        clearTimeout(hardStop);
        resolve({
          executable, args, cwd, startedAt,
          durationMs: Math.round(performance.now() - start),
          exitCode, signal, timedOut,
          stdoutPath, stderrPath,
          ...(spawnError ? { error: spawnError } : {}),
        });
      });
    });
  } finally {
    await Promise.all([stdout.close(), stderr?.close()]);
  }
}

export function requireCommandSuccess(result, label) {
  if (result.error || result.timedOut || result.exitCode !== 0 || result.signal) {
    throw new Error(`${label} failed: ${result.error ?? (result.timedOut ? 'deadline exceeded' : result.signal ?? `exit ${result.exitCode}`)}. Inspect the retained command logs.`);
  }
}
