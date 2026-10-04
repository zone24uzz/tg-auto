/**
 * Tiny local PostgreSQL cluster manager for development and tests (no Docker).
 * Uses the binaries shipped by the `@embedded-postgres/<platform>` dev dependency, but starts
 * the server through `pg_ctl`, which (unlike running postgres directly) also works from an
 * administrator account on Windows — pg_ctl drops admin privileges with a restricted token.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PLATFORM_PACKAGES: Record<string, string> = {
  'win32-x64': '@embedded-postgres/windows-x64',
  'linux-x64': '@embedded-postgres/linux-x64',
  'linux-arm64': '@embedded-postgres/linux-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
};

export interface PgBinaries {
  initdb: string;
  pg_ctl: string;
}

export async function pgBinaries(): Promise<PgBinaries> {
  const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!pkg) throw new Error(`no embedded PostgreSQL binaries for ${process.platform}-${process.arch}`);
  const mod = (await import(pkg)) as PgBinaries;
  if (!existsSync(mod.pg_ctl) || !existsSync(mod.initdb)) throw new Error(`${pkg} is installed without binaries`);
  return { initdb: mod.initdb, pg_ctl: mod.pg_ctl };
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${out.slice(-800)}`));
    });
  });
}

export async function initCluster(dataDir: string, user = 'postgres', password = 'postgres'): Promise<void> {
  const { initdb } = await pgBinaries();
  mkdirSync(path.dirname(dataDir), { recursive: true });
  const pwFile = path.join(tmpdir(), `pgpw-${process.pid}-${Date.now()}`);
  writeFileSync(pwFile, password, { mode: 0o600 });
  try {
    await run(initdb, ['-D', dataDir, '-U', user, `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C']);
  } finally {
    rmSync(pwFile, { force: true });
  }
}

export async function startCluster(dataDir: string, port: number): Promise<void> {
  const { pg_ctl } = await pgBinaries();
  const logFile = path.join(dataDir, 'server.log');
  // The server inherits pg_ctl's stdio handles and keeps them open, so pipes would never
  // "close": ignore stdio and wait for pg_ctl's own exit (-w waits until the server accepts connections).
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pg_ctl,
      ['-D', dataDir, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-l', logFile, '-w', '-t', '60', 'start'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_ctl start exited with ${code}; see ${logFile}`));
    });
  });
}

export async function stopCluster(dataDir: string): Promise<void> {
  const { pg_ctl } = await pgBinaries();
  await run(pg_ctl, ['-D', dataDir, '-m', 'fast', '-w', '-t', '30', 'stop']);
}

export function isInitialised(dataDir: string): boolean {
  return existsSync(path.join(dataDir, 'PG_VERSION'));
}
