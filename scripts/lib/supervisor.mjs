import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { buildSpawnPlan, signalExitCode } from './spawn-command.mjs';

const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;
export const EXIT_INTERRUPTED = 130;

function prefixLines(stream, name, write) {
  if (stream === null) {
    return Promise.resolve();
  }
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  reader.on('line', (line) => {
    write(`[${name}] ${line}\n`);
  });
  return new Promise((resolve) => {
    reader.once('close', resolve);
  });
}

export function terminateTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => {
      child.kill();
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

function startProcess(spec, io) {
  const env = { ...io.env, ...spec.env };
  const plan = buildSpawnPlan(spec.command, spec.args, env);
  const child = spawn(plan.file, plan.args, {
    cwd: spec.cwd ?? io.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    detached: process.platform !== 'win32',
  });
  const output = Promise.all([
    prefixLines(child.stdout, spec.name, io.stdout),
    prefixLines(child.stderr, spec.name, io.stderr),
  ]);
  const exited = new Promise((resolve) => {
    let settled = false;
    const settle = (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    child.once('error', (error) => {
      io.stderr(`[${spec.name}] failed to start: ${error.message}\n`);
      settle('code' in error && error.code === 'ENOENT' ? 127 : 126);
    });
    child.once('exit', (code, signal) => {
      settle(code ?? signalExitCode(signal));
    });
  });
  const done = exited.then(async (code) => {
    await Promise.race([output, delay(OUTPUT_DRAIN_TIMEOUT_MS)]);
    return code;
  });
  return { spec, child, done };
}

export function validateProcessTable(specs) {
  const names = new Set();
  for (const spec of specs) {
    if (typeof spec.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(spec.name)) {
      throw new TypeError(`Invalid process name: ${String(spec.name)}`);
    }
    if (names.has(spec.name)) {
      throw new TypeError(`Duplicate process name: ${spec.name}`);
    }
    names.add(spec.name);
    if (spec.kind !== 'task' && spec.kind !== 'service') {
      throw new TypeError(`Process ${spec.name} has invalid kind ${String(spec.kind)}`);
    }
    if (
      typeof spec.command !== 'string' ||
      spec.command.length === 0 ||
      !Array.isArray(spec.args)
    ) {
      throw new TypeError(`Process ${spec.name} must define command and args`);
    }
  }
}

export async function runSupervised(specs, io) {
  validateProcessTable(specs);
  const active = new Set();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    for (const running of active) {
      terminateTree(running.child);
    }
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, onSignal);
  }
  try {
    for (const task of specs.filter((spec) => spec.kind === 'task')) {
      io.stderr(`[supervisor] running ${task.name}\n`);
      const running = startProcess(task, io);
      active.add(running);
      const code = await running.done;
      active.delete(running);
      if (interrupted) {
        return EXIT_INTERRUPTED;
      }
      if (code !== 0) {
        io.stderr(`[supervisor] ${task.name} failed with exit code ${String(code)}\n`);
        return code;
      }
    }
    const services = specs.filter((spec) => spec.kind === 'service');
    if (services.length === 0) {
      return 0;
    }
    const running = services.map((spec) => {
      io.stderr(`[supervisor] starting ${spec.name}\n`);
      const started = startProcess(spec, io);
      active.add(started);
      return started;
    });
    const first = await Promise.race(
      running.map((entry) => entry.done.then((code) => ({ name: entry.spec.name, code }))),
    );
    for (const entry of running) {
      terminateTree(entry.child);
    }
    await Promise.all(running.map((entry) => entry.done));
    if (interrupted) {
      return EXIT_INTERRUPTED;
    }
    io.stderr(
      `[supervisor] ${first.name} exited with code ${String(first.code)}; stopped remaining services\n`,
    );
    return first.code === 0 ? 1 : first.code;
  } finally {
    for (const signal of signals) {
      process.removeListener(signal, onSignal);
    }
  }
}
