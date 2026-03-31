import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { BoltAction, CommandActionType, CommandExecutionPolicy } from '~/types/actions';
import type { ITerminal } from '~/types/terminal';
import { withResolvers } from './promises';
import { atom } from 'nanostores';
import { expoUrlAtom } from '~/lib/stores/qrCodeStore';

const COMMAND_SEPARATOR = /\s*&&\s*/;
const UNSUPPORTED_COMMAND_OPERATOR_PATTERNS = [
  /\|\|/,
  /;/,
  /\r|\n/,
  /\s\|\s/,
  />/,
  /</,
  /`/,
  /\$\(/,
];
const FILE_SYSTEM_MUTATION_PATTERN = /^(rm|rmdir|del|erase|mkdir|cp|mv|touch|chmod|chown)\b/i;
const PRIVILEGED_COMMAND_PATTERN = /^(powershell|cmd|bash|sh|git|curl|wget|node|python|python3)\b/i;
const READ_ONLY_COMMAND_PATTERN = /^(pwd|ls|cat|head|tail|which|env|ps)\b(?:\s+.*)?$/i;
const SHELL_INSTALL_PATTERNS = [
  /^npm\s+(install|ci)(?:\s+--[\w-]+(?:=[^\s]+)?)*$/i,
  /^pnpm\s+(install|i)(?:\s+--[\w-]+(?:=[^\s]+)?)*$/i,
  /^yarn\s+install(?:\s+--[\w-]+(?:=[^\s]+)?)*$/i,
  /^bun\s+install(?:\s+--[\w-]+(?:=[^\s]+)?)*$/i,
];
const CHECK_COMMAND_PATTERNS = [
  /^npm\s+run\s+(build|test|lint|typecheck|check)\b(?:\s+--\s+.*)?$/i,
  /^npm\s+test\b(?:\s+--\s+.*)?$/i,
  /^pnpm(?:\s+run)?\s+(build|test|lint|typecheck|check)\b(?:\s+--\s+.*)?$/i,
  /^yarn\s+(build|test|lint|typecheck|check)\b(?:\s+--\s+.*)?$/i,
  /^bun\s+run\s+(build|test|lint|typecheck|check)\b(?:\s+--\s+.*)?$/i,
];
const START_COMMAND_PATTERNS = [
  /^npm\s+run\s+(dev|start|preview)\b(?:\s+--\s+.*)?$/i,
  /^pnpm(?:\s+run)?\s+(dev|start|preview)\b(?:\s+--\s+.*)?$/i,
  /^yarn\s+(dev|start|preview)\b(?:\s+--\s+.*)?$/i,
  /^bun\s+run\s+(dev|start|preview)\b(?:\s+--\s+.*)?$/i,
  /^npx\s+(--yes\s+)?(vite|serve|servor|http-server|expo)\b(?:\s+.*)?$/i,
];

function allowCommand(
  commandType: CommandActionType,
  command: string,
  normalizedCommand: string,
  matchedRule: string,
): CommandExecutionPolicy {
  return {
    verdict: 'allow',
    commandType,
    command,
    normalizedCommand,
    matchedRule,
  };
}

function rejectCommand(
  commandType: CommandActionType,
  command: string,
  normalizedCommand: string,
  reason: string,
  matchedRule: string,
): CommandExecutionPolicy {
  return {
    verdict: 'reject',
    commandType,
    command,
    normalizedCommand,
    reason,
    matchedRule,
  };
}

function normalizeCommandSegment(segment: string) {
  return segment.trim().replace(/\s+/g, ' ');
}

function getNormalizedSegments(command: string) {
  return command
    .split(COMMAND_SEPARATOR)
    .map((segment) => normalizeCommandSegment(segment))
    .filter(Boolean);
}

function matchesAnyPattern(command: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(command));
}

function evaluateCommandSegment(commandType: CommandActionType, segment: string): CommandExecutionPolicy {
  if (!segment) {
    return rejectCommand(commandType, segment, segment, 'Empty commands are not allowed.', 'empty-command');
  }

  if (FILE_SYSTEM_MUTATION_PATTERN.test(segment)) {
    return rejectCommand(
      commandType,
      segment,
      segment,
      'File-system mutation commands must use file actions instead of shell execution.',
      'filesystem-mutation',
    );
  }

  if (PRIVILEGED_COMMAND_PATTERN.test(segment)) {
    return rejectCommand(
      commandType,
      segment,
      segment,
      'Arbitrary interpreters, network tools, and privileged shells are not allowed in command actions.',
      'privileged-command',
    );
  }

  const isStartCommand = matchesAnyPattern(segment, START_COMMAND_PATTERNS);
  const isCheckCommand = matchesAnyPattern(segment, CHECK_COMMAND_PATTERNS);

  if (commandType === 'shell') {
    if (isStartCommand) {
      return rejectCommand(
        commandType,
        segment,
        segment,
        'Development servers must use start actions instead of shell actions.',
        'shell-start-mismatch',
      );
    }

    if (matchesAnyPattern(segment, SHELL_INSTALL_PATTERNS)) {
      return allowCommand(commandType, segment, segment, 'package-install');
    }

    if (isCheckCommand) {
      return allowCommand(commandType, segment, segment, 'project-check');
    }

    if (READ_ONLY_COMMAND_PATTERN.test(segment)) {
      return allowCommand(commandType, segment, segment, 'read-only-diagnostic');
    }

    return rejectCommand(
      commandType,
      segment,
      segment,
      'Shell actions are limited to package installation, project checks, and read-only diagnostics.',
      'shell-not-allowed',
    );
  }

  if (commandType === 'start') {
    if (matchesAnyPattern(segment, SHELL_INSTALL_PATTERNS) || isCheckCommand) {
      return rejectCommand(
        commandType,
        segment,
        segment,
        'Build, test, lint, and install commands must not use start actions.',
        'start-command-mismatch',
      );
    }

    if (isStartCommand) {
      return allowCommand(commandType, segment, segment, 'start-command');
    }

    return rejectCommand(
      commandType,
      segment,
      segment,
      'Start actions are limited to dev, start, or preview server commands.',
      'start-not-allowed',
    );
  }

  if (commandType === 'build') {
    if (segment.toLowerCase() === 'npm run build') {
      return allowCommand(commandType, segment, segment, 'build-command');
    }

    return rejectCommand(
      commandType,
      segment,
      segment,
      'Build actions may only execute `npm run build`.',
      'build-not-allowed',
    );
  }

  return rejectCommand(commandType, segment, segment, 'Command type is not supported by the execution policy.', 'unknown');
}

export function getCommandActionType(action: Pick<BoltAction, 'type'>): CommandActionType | undefined {
  if (action.type === 'shell' || action.type === 'start' || action.type === 'build') {
    return action.type;
  }

  return undefined;
}

export function getActionCommand(action: Pick<BoltAction, 'type' | 'content'>): string {
  if (action.type === 'build') {
    const command = action.content.trim();
    return command || 'npm run build';
  }

  return action.content.trim();
}

export function evaluateActionExecutionPolicy(
  action: Pick<BoltAction, 'type' | 'content'>,
): CommandExecutionPolicy | undefined {
  const commandType = getCommandActionType(action);

  if (!commandType) {
    return undefined;
  }

  const command = getActionCommand(action);

  if (!command) {
    return rejectCommand(commandType, command, command, 'Commands must not be empty.', 'empty-command');
  }

  if (UNSUPPORTED_COMMAND_OPERATOR_PATTERNS.some((pattern) => pattern.test(command))) {
    return rejectCommand(
      commandType,
      command,
      normalizeCommandSegment(command),
      'Command chaining is limited to `&&`; pipes, redirects, subshells, and multiline commands are blocked.',
      'unsupported-operator',
    );
  }

  const normalizedSegments = getNormalizedSegments(command);

  if (normalizedSegments.length === 0) {
    return rejectCommand(commandType, command, command, 'Commands must not be empty.', 'empty-command');
  }

  const decisions = normalizedSegments.map((segment) => evaluateCommandSegment(commandType, segment));
  const rejectedDecision = decisions.find((decision) => decision.verdict === 'reject');
  const normalizedCommand = normalizedSegments.join(' && ');

  if (rejectedDecision) {
    return {
      ...rejectedDecision,
      command,
      normalizedCommand,
    };
  }

  return allowCommand(commandType, command, normalizedCommand, decisions.map((decision) => decision.matchedRule).join(','));
}

export async function newShellProcess(webcontainer: WebContainer, terminal: ITerminal) {
  const args: string[] = [];

  // we spawn a JSH process with a fallback cols and rows in case the process is not attached yet to a visible terminal
  const process = await webcontainer.spawn('/bin/jsh', ['--osc', ...args], {
    terminal: {
      cols: terminal.cols ?? 80,
      rows: terminal.rows ?? 15,
    },
  });

  const input = process.input.getWriter();
  const output = process.output;

  const jshReady = withResolvers<void>();

  let isInteractive = false;
  output.pipeTo(
    new WritableStream({
      write(data) {
        if (!isInteractive) {
          const [, osc] = data.match(/\x1b\]654;([^\x07]+)\x07/) || [];

          if (osc === 'interactive') {
            // wait until we see the interactive OSC
            isInteractive = true;

            jshReady.resolve();
          }
        }

        terminal.write(data);
      },
    }),
  );

  terminal.onData((data) => {
    // console.log('terminal onData', { data, isInteractive });

    if (isInteractive) {
      input.write(data);
    }
  });

  await jshReady.promise;

  return process;
}

export type ExecutionResult = { output: string; exitCode: number } | undefined;

export class BoltShell {
  #initialized: (() => void) | undefined;
  #readyPromise: Promise<void>;
  #webcontainer: WebContainer | undefined;
  #terminal: ITerminal | undefined;
  #process: WebContainerProcess | undefined;
  executionState = atom<
    { sessionId: string; active: boolean; executionPrms?: Promise<any>; abort?: () => void } | undefined
  >();
  #outputStream: ReadableStreamDefaultReader<string> | undefined;
  #shellInputStream: WritableStreamDefaultWriter<string> | undefined;

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#initialized = resolve;
    });
  }

  ready() {
    return this.#readyPromise;
  }

  async init(webcontainer: WebContainer, terminal: ITerminal) {
    this.#webcontainer = webcontainer;
    this.#terminal = terminal;

    // Use all three streams from tee: one for terminal, one for command execution, one for Expo URL detection
    const { process, commandStream, expoUrlStream } = await this.newBoltShellProcess(webcontainer, terminal);
    this.#process = process;
    this.#outputStream = commandStream.getReader();

    // Start background Expo URL watcher immediately
    this._watchExpoUrlInBackground(expoUrlStream);

    await this.waitTillOscCode('interactive');
    this.#initialized?.();
  }

  async newBoltShellProcess(webcontainer: WebContainer, terminal: ITerminal) {
    const args: string[] = [];
    const process = await webcontainer.spawn('/bin/jsh', ['--osc', ...args], {
      terminal: {
        cols: terminal.cols ?? 80,
        rows: terminal.rows ?? 15,
      },
    });

    const input = process.input.getWriter();
    this.#shellInputStream = input;

    // Tee the output so we can have three independent readers
    const [streamA, streamB] = process.output.tee();
    const [streamC, streamD] = streamB.tee();

    const jshReady = withResolvers<void>();
    let isInteractive = false;
    streamA.pipeTo(
      new WritableStream({
        write(data) {
          if (!isInteractive) {
            const [, osc] = data.match(/\x1b\]654;([^\x07]+)\x07/) || [];

            if (osc === 'interactive') {
              isInteractive = true;
              jshReady.resolve();
            }
          }

          terminal.write(data);
        },
      }),
    );

    terminal.onData((data) => {
      if (isInteractive) {
        input.write(data);
      }
    });

    await jshReady.promise;

    // Return all streams for use in init
    return { process, terminalStream: streamA, commandStream: streamC, expoUrlStream: streamD };
  }

  // Dedicated background watcher for Expo URL
  private async _watchExpoUrlInBackground(stream: ReadableStream<string>) {
    const reader = stream.getReader();
    let buffer = '';
    const expoUrlRegex = /(exp:\/\/[^\s]+)/;

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += value || '';

      const expoUrlMatch = buffer.match(expoUrlRegex);

      if (expoUrlMatch) {
        const cleanUrl = expoUrlMatch[1]
          .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          .replace(/[^\x20-\x7E]+$/g, '');
        expoUrlAtom.set(cleanUrl);
        buffer = buffer.slice(buffer.indexOf(expoUrlMatch[1]) + expoUrlMatch[1].length);
      }

      if (buffer.length > 2048) {
        buffer = buffer.slice(-2048);
      }
    }
  }

  get terminal() {
    return this.#terminal;
  }

  get process() {
    return this.#process;
  }

  async executeCommand(sessionId: string, command: string, abort?: () => void): Promise<ExecutionResult> {
    if (!this.process || !this.terminal) {
      return undefined;
    }

    const state = this.executionState.get();

    if (state?.active && state.abort) {
      state.abort();
    }

    /*
     * interrupt the current execution
     *  this.#shellInputStream?.write('\x03');
     */
    this.terminal.input('\x03');
    await this.waitTillOscCode('prompt');

    if (state && state.executionPrms) {
      await state.executionPrms;
    }

    //start a new execution
    this.terminal.input(command.trim() + '\n');

    //wait for the execution to finish
    const executionPromise = this.getCurrentExecutionResult();
    this.executionState.set({ sessionId, active: true, executionPrms: executionPromise, abort });

    const resp = await executionPromise;
    this.executionState.set({ sessionId, active: false });

    if (resp) {
      try {
        resp.output = cleanTerminalOutput(resp.output);
      } catch (error) {
        console.log('failed to format terminal output', error);
      }
    }

    return resp;
  }

  async getCurrentExecutionResult(): Promise<ExecutionResult> {
    const { output, exitCode } = await this.waitTillOscCode('exit');
    return { output, exitCode };
  }

  onQRCodeDetected?: (qrCode: string) => void;

  async waitTillOscCode(waitCode: string) {
    let fullOutput = '';
    let exitCode: number = 0;
    let buffer = ''; // <-- Add a buffer to accumulate output

    if (!this.#outputStream) {
      return { output: fullOutput, exitCode };
    }

    const tappedStream = this.#outputStream;

    // Regex for Expo URL
    const expoUrlRegex = /(exp:\/\/[^\s]+)/;

    while (true) {
      const { value, done } = await tappedStream.read();

      if (done) {
        break;
      }

      const text = value || '';
      fullOutput += text;
      buffer += text; // <-- Accumulate in buffer

      // Extract Expo URL from buffer and set store
      const expoUrlMatch = buffer.match(expoUrlRegex);

      if (expoUrlMatch) {
        // Remove any trailing ANSI escape codes or non-printable characters
        const cleanUrl = expoUrlMatch[1]
          .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          .replace(/[^\x20-\x7E]+$/g, '');
        expoUrlAtom.set(cleanUrl);

        // Remove everything up to and including the URL from the buffer to avoid duplicate matches
        buffer = buffer.slice(buffer.indexOf(expoUrlMatch[1]) + expoUrlMatch[1].length);
      }

      // Check if command completion signal with exit code
      const [, osc, , , code] = text.match(/\x1b\]654;([^\x07=]+)=?((-?\d+):(\d+))?\x07/) || [];

      if (osc === 'exit') {
        exitCode = parseInt(code, 10);
      }

      if (osc === waitCode) {
        break;
      }
    }

    return { output: fullOutput, exitCode };
  }
}

/**
 * Cleans and formats terminal output while preserving structure and paths
 * Handles ANSI, OSC, and various terminal control sequences
 */
export function cleanTerminalOutput(input: string): string {
  // Step 1: Remove OSC sequences (including those with parameters)
  const removeOsc = input
    .replace(/\x1b\](\d+;[^\x07\x1b]*|\d+[^\x07\x1b]*)\x07/g, '')
    .replace(/\](\d+;[^\n]*|\d+[^\n]*)/g, '');

  // Step 2: Remove ANSI escape sequences and color codes more thoroughly
  const removeAnsi = removeOsc
    // Remove all escape sequences with parameters
    .replace(/\u001b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    // Remove color codes
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    // Clean up any remaining escape characters
    .replace(/\u001b/g, '')
    .replace(/\x1b/g, '');

  // Step 3: Clean up carriage returns and newlines
  const cleanNewlines = removeAnsi
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // Step 4: Add newlines at key breakpoints while preserving paths
  const formatOutput = cleanNewlines
    // Preserve prompt line
    .replace(/^([~\/][^\n❯]+)❯/m, '$1\n❯')
    // Add newline before command output indicators
    .replace(/(?<!^|\n)>/g, '\n>')
    // Add newline before error keywords without breaking paths
    .replace(/(?<!^|\n|\w)(error|failed|warning|Error|Failed|Warning):/g, '\n$1:')
    // Add newline before 'at' in stack traces without breaking paths
    .replace(/(?<!^|\n|\/)(at\s+(?!async|sync))/g, '\nat ')
    // Ensure 'at async' stays on same line
    .replace(/\bat\s+async/g, 'at async')
    // Add newline before npm error indicators
    .replace(/(?<!^|\n)(npm ERR!)/g, '\n$1');

  // Step 5: Clean up whitespace while preserving intentional spacing
  const cleanSpaces = formatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // Step 6: Final cleanup
  return cleanSpaces
    .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double newlines
    .replace(/:\s+/g, ': ') // Normalize spacing after colons
    .replace(/\s{2,}/g, ' ') // Remove multiple spaces
    .replace(/^\s+|\s+$/g, '') // Trim start and end
    .replace(/\u0000/g, ''); // Remove null characters
}

export function newBoltShellProcess() {
  return new BoltShell();
}
