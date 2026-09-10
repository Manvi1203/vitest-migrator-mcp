import { spawn } from 'child_process';
import * as fs from 'fs';

export interface TestRunResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  passedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  errors: string[];
}

export function runVerification(
  packagePath: string,
  target: 'vitest-browser' | 'vitest-node' | 'mocha-node' | 'karma-browser' = 'vitest-browser'
): Promise<TestRunResult> {
  return new Promise((resolve) => {
    if (!fs.existsSync(packagePath)) {
      resolve({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Directory not found: ${packagePath}`,
        errors: [`Directory not found: ${packagePath}`]
      });
      return;
    }

    let command: string;
    let args: string[];

    if (target === 'vitest-browser') {
      command = 'yarn';
      args = ['vitest', 'run', '--project=browser'];
    } else if (target === 'vitest-node') {
      command = 'yarn';
      args = ['vitest', 'run', '--project=node'];
    } else if (target === 'karma-browser') {
      command = 'yarn';
      args = ['test:browser'];
    } else {
      command = 'yarn';
      args = ['test:node'];
    }

    const proc = spawn(command, args, {
      cwd: packagePath,
      shell: true,
      env: {
        ...process.env,
        CI: 'true',
        PATH: `/usr/lib/jvm/java-21-openjdk-amd64/bin:${process.env.PATH}`
      }
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        errors: [err.message]
      });
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const fullOutput = stdout + '\n' + stderr;
      const errors: string[] = [];

      // Extract error stack traces or fail reasons
      const lines = fullOutput.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          line.includes('Error:') ||
          line.includes('TypeError:') ||
          line.includes('ReferenceError:') ||
          line.includes('SyntaxError:') ||
          line.includes('FAIL') ||
          line.includes('INTERNAL ASSERTION FAILED')
        ) {
          errors.push(lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 6)).join('\n'));
          i += 5;
        }
      }

      // Parse test counts if possible
      let passedCount: number | undefined;
      let failedCount: number | undefined;
      let skippedCount: number | undefined;

      const passedMatch = fullOutput.match(/(\d+)\s+passed/i);
      if (passedMatch) passedCount = parseInt(passedMatch[1], 10);

      const failedMatch = fullOutput.match(/(\d+)\s+failed/i);
      if (failedMatch) failedCount = parseInt(failedMatch[1], 10);

      const skippedMatch = fullOutput.match(/(\d+)\s+skipped/i);
      if (skippedMatch) skippedCount = parseInt(skippedMatch[1], 10);

      resolve({
        success: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
        passedCount,
        failedCount,
        skippedCount,
        errors
      });
    });
  });
}
