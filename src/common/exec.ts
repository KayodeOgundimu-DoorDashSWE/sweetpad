import { getWorkspacePath } from "../build/utils";
import { ExecBaseError, ExecError } from "./errors";
import { prepareEnvVars } from "./helpers";
import { commonLogger } from "./logger";

import { execa } from "execa";

type ExecaError = {
  command: string;
  escapedCommand: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  killed: boolean;
  signal?: string;
  signalDescription?: string;
  cwd: string;
  message: string;
  shortMessage: string;
  originalMessage: string;
};

export async function exec(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: { [key: string]: string | null };
}): Promise<string> {
  const cwd = options.cwd ?? getWorkspacePath();

  commonLogger.debug("Executing command", {
    command: options.command,
    args: options.args,
    cwd: cwd,
    env: options.env,
  });

  const env = prepareEnvVars(options.env);

  try {
    const result = await execa(options.command, options.args, {
      cwd: cwd,
      env: env,
    }).catch(error => {
      // Handle rejection manually
      return {
        failed: true,
        exitCode: error.exitCode || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message || 'Unknown error',
      };
    });

    commonLogger.debug("Command executed", {
      command: options.command,
      args: options.args,
      cwd: cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });

    // Check for errors
    if (result.failed || result.exitCode !== 0) {
      throw new ExecError(`Error executing "${options.command}" command (exit code: ${result.exitCode})`, {
        stderr: result.stderr,
        command: options.command,
        args: options.args,
        cwd: cwd,
        errorMessage: result.stderr || "[no error output]",
      });
    }

    // Check stderr even on success
    if (result.stderr && !result.stdout) {
      commonLogger.warn(`Command "${options.command}" succeeded but had stderr output`, {
        command: options.command,
        args: options.args,
        stderr: result.stderr,
      });
    }

    return result.stdout;
  } catch (e: any) {
    const errorMessage: string = e?.shortMessage ?? e?.message ?? "[unknown error]";
    const stderr: string | undefined = e?.stderr;
    
    commonLogger.error(`Error executing command "${options.command}"`, {
      errorMessage,
      stderr,
      command: options.command,
      args: options.args,
      cwd: cwd,
    });
    
    // If this is already our error type, just re-throw it
    if (e instanceof ExecBaseError || e instanceof ExecError) {
      throw e;
    }
    
    // Otherwise, wrap it in our error type
    throw new ExecBaseError(`Error executing "${options.command}" command`, {
      errorMessage: errorMessage,
      stderr: stderr,
      command: options.command,
      args: options.args,
      cwd: cwd,
    });
  }
}
