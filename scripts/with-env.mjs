#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [envFile, command, ...args] = process.argv.slice(2);
if (envFile === undefined || command === undefined) {
  process.stderr.write('usage: with-env.mjs <env-file> <command> [args...]\n');
  process.exit(64);
}
const envPath = resolve(envFile);
if (!existsSync(envPath)) {
  process.stderr.write(`CONFIG_INVALID: ${envPath} does not exist\n`);
  process.exit(78);
}
process.loadEnvFile(envPath);

const child = spawn(command, args, { stdio: 'inherit', env: process.env });
const forward = (signal) => {
  if (child.exitCode === null) {
    child.kill(signal);
  }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    forward(signal);
  });
}
child.on('error', (error) => {
  process.stderr.write(`failed to start ${command}: ${error.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1));
});
