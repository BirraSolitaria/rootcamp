import { spawn } from 'node:child_process';

export type ShellcheckLevel = 'error' | 'warning' | 'info' | 'style';

export interface ShellcheckFinding {
  path: string;
  line: number;
  level: ShellcheckLevel;
  message: string;
}

/** Lints shell scripts. Throws when no shellcheck can be run (validation reports one R18 error). */
export type ShellcheckRunner = (
  files: { path: string; content: string }[],
) => Promise<ShellcheckFinding[]>;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs `cmd args` with `stdin`; rejects (e.g. with code ENOENT) when the command cannot start. */
export type ExecFn = (cmd: string, args: string[], stdin: string) => Promise<ExecResult>;

export const SHELLCHECK_IMAGE = 'koalaman/shellcheck:v0.10.0';
const SHELLCHECK_ARGS = ['-f', 'json', '-'];
const DOCKER_ARGS = ['run', '--rm', '-i', SHELLCHECK_IMAGE, ...SHELLCHECK_ARGS];

export class ShellcheckUnavailableError extends Error {
  constructor(reason: string) {
    super(`shellcheck недоступен: ${reason}`);
    this.name = 'ShellcheckUnavailableError';
  }
}

export const spawnExec: ExecFn = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.on('error', () => {}); // EPIPE if the process exits early; reported via 'close'
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

/**
 * shellcheck from PATH; if it is not installed (ENOENT), the `koalaman/shellcheck`
 * image via `docker run`, one file at a time. If neither works, the runner throws
 * {@link ShellcheckUnavailableError}.
 */
export function defaultShellcheck(exec: ExecFn = spawnExec): ShellcheckRunner {
  return async (files) => {
    let useDocker = false;
    const findings: ShellcheckFinding[] = [];
    for (const file of files) {
      let result: ExecResult | undefined;
      if (!useDocker) {
        try {
          result = await exec('shellcheck', SHELLCHECK_ARGS, file.content);
        } catch (e) {
          if (!isEnoent(e)) throw e;
          useDocker = true;
        }
      }
      if (useDocker) {
        try {
          result = await exec('docker', DOCKER_ARGS, file.content);
        } catch (e) {
          if (isEnoent(e))
            throw new ShellcheckUnavailableError('нет shellcheck в PATH и нет docker');
          throw e;
        }
      }
      findings.push(...parseFindings(result!, file.path, useDocker));
    }
    return findings;
  };
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

/** shellcheck exits 0 (clean) or 1 (findings) with a JSON array on stdout; anything else is a failure. */
function parseFindings(result: ExecResult, path: string, viaDocker: boolean): ShellcheckFinding[] {
  let parsed: unknown;
  try {
    parsed = result.code === 0 || result.code === 1 ? JSON.parse(result.stdout) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    const detail = result.stderr.trim().split('\n')[0] || `код выхода ${String(result.code)}`;
    throw new ShellcheckUnavailableError(
      viaDocker ? `нет shellcheck в PATH, docker: ${detail}` : detail,
    );
  }
  return parsed.map(
    (c: { line: number; level: ShellcheckLevel; code: number; message: string }) => ({
      path,
      line: c.line,
      level: c.level,
      message: `SC${c.code}: ${c.message}`,
    }),
  );
}
