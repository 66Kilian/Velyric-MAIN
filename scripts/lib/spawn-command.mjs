import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { constants } from 'node:os';
import { extname, join } from 'node:path';

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const NODE_MODULES_BIN_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const BATCH_FILE = /\.(cmd|bat)$/i;

function readEnv(env, key) {
  const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === key);
  return match === undefined ? undefined : env[match];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveWindowsExecutable(command, env) {
  const pathExtensions = (readEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.length > 0);
  const hasKnownExtension = pathExtensions.includes(extname(command).toLowerCase());
  const candidates = hasKnownExtension
    ? [command]
    : pathExtensions.map((extension) => `${command}${extension}`);
  const hasDirectory = /[\\/]/.test(command);
  const directories = hasDirectory
    ? ['']
    : (readEnv(env, 'PATH') ?? '').split(';').filter((entry) => entry.length > 0);
  for (const directory of directories) {
    for (const candidate of candidates) {
      const fullPath = directory === '' ? candidate : join(directory, candidate);
      if (isFile(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

export function escapeCmdCommand(value) {
  return value.replace(CMD_META_CHARS, '^$1');
}

export function quoteWindowsArgument(value) {
  let quoted = '"';
  let pendingBackslashes = 0;
  for (const character of String(value)) {
    if (character === '\\') {
      pendingBackslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${'\\'.repeat(pendingBackslashes * 2 + 1)}"`;
    } else {
      quoted += `${'\\'.repeat(pendingBackslashes)}${character}`;
    }
    pendingBackslashes = 0;
  }
  return `${quoted}${'\\'.repeat(pendingBackslashes * 2)}"`;
}

export function escapeCmdArgument(value, doubleEscape) {
  let argument = quoteWindowsArgument(value).replace(CMD_META_CHARS, '^$1');
  if (doubleEscape) {
    argument = argument.replace(CMD_META_CHARS, '^$1');
  }
  return argument;
}

export function buildSpawnPlan(command, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    return { file: command, args: [...args], windowsVerbatimArguments: false };
  }
  const resolved = resolveWindowsExecutable(command, env);
  if (resolved === null) {
    return { file: command, args: [...args], windowsVerbatimArguments: false };
  }
  if (!BATCH_FILE.test(resolved)) {
    return { file: resolved, args: [...args], windowsVerbatimArguments: false };
  }
  const doubleEscape = NODE_MODULES_BIN_SHIM.test(resolved);
  const line = [
    escapeCmdCommand(resolved),
    ...args.map((argument) => escapeCmdArgument(argument, doubleEscape)),
  ].join(' ');
  return {
    file: readEnv(env, 'COMSPEC') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export function signalExitCode(signal) {
  const number = signal === null ? undefined : constants.signals[signal];
  return 128 + (number ?? 1);
}

export function spawnPlanned(command, args, options = {}) {
  const env = options.env ?? process.env;
  const plan = buildSpawnPlan(command, args, env);
  return spawn(plan.file, plan.args, {
    cwd: options.cwd,
    env,
    stdio: options.stdio ?? 'inherit',
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    detached: options.detached ?? false,
  });
}

export function runInherited(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnPlanned(command, args, options);
    const forwardedSignals =
      process.platform === 'win32' ? ['SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const ignoredSignals = process.platform === 'win32' ? ['SIGINT'] : [];
    const forward = (signal) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    const ignore = () => undefined;
    for (const signal of forwardedSignals) {
      process.on(signal, forward);
    }
    for (const signal of ignoredSignals) {
      process.on(signal, ignore);
    }
    const settle = (code, error) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const signal of forwardedSignals) {
        process.removeListener(signal, forward);
      }
      for (const signal of ignoredSignals) {
        process.removeListener(signal, ignore);
      }
      resolve({ code, error });
    };
    child.on('error', (error) => {
      const code = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 127 : 126;
      settle(code, error);
    });
    child.on('exit', (code, signal) => {
      settle(code ?? signalExitCode(signal), undefined);
    });
  });
}
