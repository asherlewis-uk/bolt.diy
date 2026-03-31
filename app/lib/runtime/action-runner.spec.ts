import { describe, expect, it, vi } from 'vitest';
import { ActionRunner } from './action-runner';
import type { ActionCallbackData } from './message-parser';

function createShellMock() {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    terminal: {},
    process: {},
    executeCommand: vi.fn(),
  };
}

function createRunnerAction(data: Partial<ActionCallbackData['action']> & { type: ActionCallbackData['action']['type'] }): ActionCallbackData {
  return {
    artifactId: 'artifact_1',
    messageId: 'message_1',
    actionId: 'action_1',
    action: {
      content: '',
      ...data,
    } as ActionCallbackData['action'],
  };
}

describe('ActionRunner', () => {
  it('rejects blocked commands before they execute', async () => {
    const shell = createShellMock();
    const onAlert = vi.fn();
    const runner = new ActionRunner(Promise.resolve({} as never), () => shell as never, onAlert);
    const blockedAction = createRunnerAction({
      type: 'shell',
      content: 'rm -rf dist',
    });

    runner.addAction(blockedAction);
    await runner.runAction(blockedAction);

    expect(shell.executeCommand).not.toHaveBeenCalled();
    expect(runner.actions.get()[blockedAction.actionId]).toMatchObject({
      type: 'shell',
      status: 'failed',
      executed: true,
      error: 'File-system mutation commands must use file actions instead of shell execution.',
    });
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Command Blocked',
        source: 'policy',
        content: 'rm -rf dist',
      }),
    );
  });

  it('executes allowed shell checks through the terminal', async () => {
    const shell = createShellMock();
    shell.executeCommand.mockResolvedValue({ exitCode: 0, output: 'ok' });

    const runner = new ActionRunner(Promise.resolve({} as never), () => shell as never);
    const allowedAction = createRunnerAction({
      type: 'shell',
      content: 'npm run lint && npm run test',
    });

    runner.addAction(allowedAction);
    await runner.runAction(allowedAction);

    expect(shell.ready).toHaveBeenCalledTimes(1);
    expect(shell.executeCommand).toHaveBeenCalledWith(
      runner.runnerId.get(),
      'npm run lint && npm run test',
      expect.any(Function),
    );
    expect(runner.actions.get()[allowedAction.actionId]).toMatchObject({
      type: 'shell',
      status: 'complete',
    });
  });

  it('aborts pending actions before they execute', async () => {
    const shell = createShellMock();
    const runner = new ActionRunner(Promise.resolve({} as never), () => shell as never);
    const pendingAction = createRunnerAction({
      type: 'shell',
      content: 'npm run test',
    });

    runner.addAction(pendingAction);
    runner.abortActiveActions();
    await runner.runAction(pendingAction);

    expect(shell.executeCommand).not.toHaveBeenCalled();
    expect(runner.actions.get()[pendingAction.actionId]).toMatchObject({
      type: 'shell',
      status: 'aborted',
      executed: false,
    });
  });
});
