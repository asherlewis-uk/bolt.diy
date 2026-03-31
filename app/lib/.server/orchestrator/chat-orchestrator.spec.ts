import type { DataStreamWriter } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { executeChatOrchestration, resolveOrchestratorModelChain } from './chat-orchestrator';

function createProgressRecorder() {
  const recordedData: unknown[] = [];
  const recordedAnnotations: unknown[] = [];

  return {
    recordedData,
    recordedAnnotations,
    dataStream: {
      writeData(value: unknown) {
        recordedData.push(value);
      },
      writeMessageAnnotation(value: unknown) {
        recordedAnnotations.push(value);
      },
    } as unknown as DataStreamWriter,
  };
}

function createArchitectResponse(overrides: Partial<{ plan: string; goals: string[]; constraints: string[]; responseStyle: string }> = {}) {
  return {
    text: JSON.stringify({
      plan: 'Inspect the request and produce a grounded implementation.',
      goals: ['Keep the response grounded'],
      constraints: ['Preserve the existing runtime path'],
      responseStyle: 'Direct and concrete',
      ...overrides,
    }),
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
  };
}

function createBuilderResponse(
  overrides: Partial<{
    implementationOutline: string[];
    responseStrategy: string;
    artifacts: string[];
    unresolvedQuestions: string[];
  }> = {},
) {
  return {
    text: JSON.stringify({
      implementationOutline: ['Map the affected files', 'Produce the final artifact response'],
      responseStrategy: 'Use the architect plan as the baseline for the final answer.',
      artifacts: ['app/routes/api.chat.ts'],
      unresolvedQuestions: [],
      ...overrides,
    }),
    usage: { completionTokens: 1, promptTokens: 4, totalTokens: 5 },
  };
}

function createCriticResponse(
  overrides: Partial<{
    reviewSummary: string;
    findings: string[];
    mustFix: string[];
    readyForSynthesis: boolean;
  }> = {},
) {
  return {
    text: JSON.stringify({
      reviewSummary: 'The response is ready for synthesis.',
      findings: ['No blocking issues'],
      mustFix: [],
      readyForSynthesis: true,
      ...overrides,
    }),
    usage: { completionTokens: 1, promptTokens: 2, totalTokens: 3 },
  };
}

function createSynthesisStreamMock({
  finishReasons,
  texts,
}: {
  finishReasons: Array<'stop' | 'length'>;
  texts?: string[];
}) {
  let callCount = 0;

  return vi.fn(async (input: any) => {
    const index = callCount++;
    const text = texts?.[index] ?? `Synthesis segment ${index + 1}`;

    await input.options.onFinish({
      text,
      finishReason: finishReasons[index] ?? 'stop',
      usage: { completionTokens: 2, promptTokens: 6, totalTokens: 8 },
    });

    return {
      fullStream: (async function* () {
        yield { type: 'text-delta', textDelta: text };
      })(),
      mergeIntoDataStream(target: DataStreamWriter) {
        target.writeData({ type: 'synthesis-stream', text });
      },
    };
  });
}

describe('chat orchestrator', () => {
  it('resolves an explicit stage model chain with per-stage overrides', () => {
    const chain = resolveOrchestratorModelChain({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nBuild a dashboard',
        },
      ],
      env: {
        ORCHESTRATOR_BUILDER_MODEL: 'gpt-4o-mini',
        ORCHESTRATOR_CRITIC_PROVIDER: 'openai',
      } as unknown as Env,
    });

    expect(chain.architect.model).toBe('claude-3-5-sonnet-latest');
    expect(chain.builder.model).toBe('gpt-4o-mini');
    expect(chain.critic.provider).toBe('openai');
    expect(chain.synthesis.provider).toBe('anthropic');
  });

  it('runs architect, builder, critic, and synthesis stages in order', async () => {
    const { recordedData, recordedAnnotations, dataStream } = createProgressRecorder();

    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(createCriticResponse());
    const loadProjectMemoryImpl = vi.fn().mockResolvedValue({
      status: 'available',
      entries: [
        {
          id: 'memory-1',
          projectRef: 'project-1',
          chatId: 'chat-1',
          userRequest: 'Implement the orchestrator.',
          memorySummary: 'Request: Implement the orchestrator.\nPlan: Keep the runtime grounded.',
          stageSnapshot: {
            artifacts: ['app/routes/api.chat.ts'],
          },
          createdAt: '2026-03-30T12:00:00.000Z',
        },
      ],
      projectId: 'project-1',
    });
    const persistProjectMemoryImpl = vi.fn().mockResolvedValue({
      status: 'persisted',
      projectId: 'project-1',
    });

    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['Final orchestrated response'],
    });

    await executeChatOrchestration({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nImplement the orchestrator.',
        },
      ],
      files: {
        '/home/project/app/routes/api.chat.ts': {
          type: 'file',
          content: 'export async function action() {}',
          isBinary: false,
        },
        '/home/project/app/components/chat/Chat.client.tsx': {
          type: 'file',
          content: 'export function Chat() {}',
          isBinary: false,
        },
      },
      artifactContext: {
        selectedFile: '/home/project/app/routes/api.chat.ts',
        modifiedFiles: [
          {
            path: '/home/project/app/routes/api.chat.ts',
            kind: 'diff',
            content: '@@ -1 +1 @@\n-export async function oldAction() {}\n+export async function action() {}',
          },
        ],
        artifacts: [
          {
            id: 'artifact-1',
            title: 'Updated chat route',
            type: 'bundled',
            actionCount: 2,
            pendingActionCount: 1,
            filePaths: ['/home/project/app/routes/api.chat.ts'],
          },
        ],
      },
      contextOptimization: false,
      env: {} as Env,
      supabase: {
        isConnected: true,
        hasSelectedProject: true,
        token: 'token-1',
        selectedProjectId: 'project-1',
      },
      dataStream,
      deps: {
        generateTextImpl: generateTextImpl as never,
        streamTextImpl: streamTextImpl as never,
        loadProjectMemoryImpl,
        persistProjectMemoryImpl,
      },
    });

    expect(generateTextImpl).toHaveBeenCalledTimes(3);
    expect(streamTextImpl).toHaveBeenCalledTimes(1);
    expect(loadProjectMemoryImpl).toHaveBeenCalledTimes(1);
    expect(persistProjectMemoryImpl).toHaveBeenCalledTimes(1);

    const progressPhases = recordedData
      .filter((value): value is { type: string; phase?: string } => typeof value === 'object' && value !== null)
      .filter((value) => value.type === 'progress')
      .map((value) => value.phase);

    expect(progressPhases).toEqual([
      'memory',
      'memory',
      'architect',
      'architect',
      'builder',
      'builder',
      'critic',
      'critic',
      'synthesis',
      'memory',
      'memory',
      'synthesis',
    ]);

    const synthesisPrompt = streamTextImpl.mock.calls[0][0].messages.at(-1).content as string;
    const builderPrompt = generateTextImpl.mock.calls[1][0].prompt as string;
    const criticPrompt = generateTextImpl.mock.calls[2][0].prompt as string;
    expect(synthesisPrompt).toContain('ARCHITECT OUTPUT');
    expect(synthesisPrompt).toContain('BUILDER OUTPUT');
    expect(synthesisPrompt).toContain('CRITIC OUTPUT');
    expect(synthesisPrompt).toContain('[Model: claude-3-5-sonnet-latest]');
    expect(synthesisPrompt).toContain('[Provider: anthropic]');
    expect(synthesisPrompt).toContain('PROJECT MEMORY');
    expect(synthesisPrompt).toContain('Request: Implement the orchestrator.');
    expect(builderPrompt).toContain('PROJECT ARTIFACT CONTEXT');
    expect(builderPrompt).toContain('MODIFIED FILES');
    expect(builderPrompt).toContain('Updated chat route');
    expect(builderPrompt).toContain('@@ -1 +1 @@');
    expect(criticPrompt).toContain('WORKBENCH ARTIFACTS');
    expect(criticPrompt).toContain('Selected file: app/routes/api.chat.ts');

    expect(recordedAnnotations).toContainEqual(
      expect.objectContaining({
        type: 'artifactContext',
        selectedFile: 'app/routes/api.chat.ts',
        modifiedFiles: [
          {
            path: 'app/routes/api.chat.ts',
            kind: 'diff',
          },
        ],
      }),
    );

    expect(recordedAnnotations).toContainEqual({
      type: 'usage',
      value: {
        completionTokens: 6,
        promptTokens: 15,
        totalTokens: 21,
      },
    });

    expect(persistProjectMemoryImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          selectedProjectId: 'project-1',
        }),
        userRequest: 'Implement the orchestrator.',
        finalResponse: 'Final orchestrated response',
      }),
    );
  });

  it('retries an invalid structured stage output once before continuing', async () => {
    const { recordedData, dataStream } = createProgressRecorder();
    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce({
        text: 'not valid json',
        usage: { completionTokens: 1, promptTokens: 4, totalTokens: 5 },
      })
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(createCriticResponse());
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['Recovered final response'],
    });

    await executeChatOrchestration({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nImplement the orchestrator.',
        },
      ],
      files: {},
      contextOptimization: false,
      env: {} as Env,
      dataStream,
      deps: {
        generateTextImpl: generateTextImpl as never,
        streamTextImpl: streamTextImpl as never,
      },
    });

    expect(generateTextImpl).toHaveBeenCalledTimes(4);
    expect(streamTextImpl).toHaveBeenCalledTimes(1);
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'builder-retry',
        status: 'complete',
        message: 'Builder stage recovered on attempt 2/2',
      }),
    );
  });

  it('repairs the builder plan when the critic requests fixes', async () => {
    const { recordedData, dataStream } = createProgressRecorder();
    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(
        createCriticResponse({
          reviewSummary: 'The builder response is missing the file path details.',
          findings: ['The response does not ground the changed file path.'],
          mustFix: ['Reference the affected route file explicitly.'],
          readyForSynthesis: false,
        }),
      )
      .mockResolvedValueOnce(
        createBuilderResponse({
          responseStrategy: 'Use the architect plan and explicitly reference the affected route file.',
          artifacts: ['app/routes/api.chat.ts', 'app/lib/.server/orchestrator/chat-orchestrator.ts'],
        }),
      )
      .mockResolvedValueOnce(
        createCriticResponse({
          reviewSummary: 'The builder response now resolves the missing file-path detail.',
          findings: [],
          mustFix: [],
          readyForSynthesis: true,
        }),
      );
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['Repaired final response'],
    });

    await executeChatOrchestration({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nImplement the orchestrator.',
        },
      ],
      files: {},
      contextOptimization: false,
      env: {} as Env,
      dataStream,
      deps: {
        generateTextImpl: generateTextImpl as never,
        streamTextImpl: streamTextImpl as never,
      },
    });

    expect(generateTextImpl).toHaveBeenCalledTimes(5);
    expect(streamTextImpl).toHaveBeenCalledTimes(1);
    expect(generateTextImpl.mock.calls[3][0].prompt).toContain('CRITIC REPAIR DIRECTIVE');
    expect(generateTextImpl.mock.calls[3][0].prompt).toContain('Repair attempt 1/2');
    expect(generateTextImpl.mock.calls[4][0].prompt).toContain('PRIOR CRITIC OUTPUT');
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'repair-loop',
        status: 'complete',
        message: 'Repair loop converged after 1/2 attempts',
      }),
    );
  });

  it('stops after the critic repair budget is exhausted', async () => {
    const { recordedData, dataStream } = createProgressRecorder();
    const unresolvedCritic = createCriticResponse({
      reviewSummary: 'The builder response still misses the required file-path details.',
      findings: ['The route file is still not identified.'],
      mustFix: ['Name the affected route file before synthesis.'],
      readyForSynthesis: false,
    });
    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(unresolvedCritic)
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(unresolvedCritic)
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(unresolvedCritic);
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['This response should never be streamed'],
    });

    await expect(
      executeChatOrchestration({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nImplement the orchestrator.',
          },
        ],
        files: {},
        contextOptimization: false,
        env: {} as Env,
        dataStream,
        deps: {
          generateTextImpl: generateTextImpl as never,
          streamTextImpl: streamTextImpl as never,
        },
      }),
    ).rejects.toThrow('Stopped after 2 repair attempts');

    expect(generateTextImpl).toHaveBeenCalledTimes(7);
    expect(streamTextImpl).not.toHaveBeenCalled();
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'repair-loop',
        status: 'failed',
      }),
    );
  });

  it('stops synthesis continuation when the response segment budget is exhausted', async () => {
    const { recordedData, dataStream } = createProgressRecorder();
    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(createCriticResponse());
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['length', 'length'],
      texts: ['Segment 1', 'Segment 2'],
    });

    await expect(
      executeChatOrchestration({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nImplement the orchestrator.',
          },
        ],
        files: {},
        contextOptimization: false,
        env: {} as Env,
        dataStream,
        deps: {
          generateTextImpl: generateTextImpl as never,
          streamTextImpl: streamTextImpl as never,
        },
      }),
    ).rejects.toThrow('maximum continuation budget reached');

    expect(streamTextImpl).toHaveBeenCalledTimes(2);
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'synthesis-continuation',
        status: 'failed',
        message: 'Stopped synthesis continuation after 2/2 segments',
      }),
    );
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'synthesis',
        status: 'failed',
      }),
    );
  });

  it('surfaces durable memory failures without blocking synthesis', async () => {
    const { recordedData, dataStream } = createProgressRecorder();

    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(createCriticResponse());
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['Final orchestrated response'],
    });
    const loadProjectMemoryImpl = vi.fn().mockResolvedValue({
      status: 'failed',
      entries: [],
      reason: 'Supabase project memory query failed',
      projectId: 'project-1',
    });
    const persistProjectMemoryImpl = vi.fn().mockResolvedValue({
      status: 'failed',
      reason: 'Supabase project memory write failed',
      projectId: 'project-1',
    });

    await executeChatOrchestration({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nImplement the orchestrator.',
        },
      ],
      files: {},
      contextOptimization: false,
      env: {} as Env,
      supabase: {
        isConnected: true,
        hasSelectedProject: true,
        token: 'token-1',
        selectedProjectId: 'project-1',
      },
      dataStream,
      deps: {
        generateTextImpl: generateTextImpl as never,
        streamTextImpl: streamTextImpl as never,
        loadProjectMemoryImpl,
        persistProjectMemoryImpl,
      },
    });

    expect(streamTextImpl).toHaveBeenCalledTimes(1);
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'memory-load',
        status: 'failed',
        message: 'Supabase project memory query failed',
      }),
    );
    expect(recordedData).toContainEqual(
      expect.objectContaining({
        label: 'memory-persist',
        status: 'failed',
        message: 'Supabase project memory write failed',
      }),
    );
  });

  it('skips repo context selection in greenfield mode without focused artifacts', async () => {
    const { dataStream } = createProgressRecorder();
    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(createCriticResponse());
    const createSummaryImpl = vi.fn().mockResolvedValue('This summary should not be used.');
    const selectContextImpl = vi.fn().mockResolvedValue({
      'app/routes/api.chat.ts': {
        type: 'file',
        content: 'export async function action() {}',
        isBinary: false,
      },
    });
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['Greenfield final response'],
    });

    await executeChatOrchestration({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nBuild a new app shell.',
        },
      ],
      files: {
        '/home/project/app/routes/api.chat.ts': {
          type: 'file',
          content: 'export async function action() {}',
          isBinary: false,
        },
      },
      operatorMode: 'greenfield-build',
      contextOptimization: true,
      env: {} as Env,
      dataStream,
      deps: {
        generateTextImpl: generateTextImpl as never,
        streamTextImpl: streamTextImpl as never,
        createSummaryImpl,
        selectContextImpl,
      },
    });

    expect(createSummaryImpl).not.toHaveBeenCalled();
    expect(selectContextImpl).not.toHaveBeenCalled();
    expect(generateTextImpl.mock.calls[0][0].prompt).toContain('Mode: Greenfield Build');
  });

  it('forces repo context selection in repair mode even when context optimization is disabled', async () => {
    const { dataStream } = createProgressRecorder();
    const generateTextImpl = vi
      .fn()
      .mockResolvedValueOnce(createArchitectResponse())
      .mockResolvedValueOnce(createBuilderResponse())
      .mockResolvedValueOnce(createCriticResponse());
    const createSummaryImpl = vi.fn().mockResolvedValue('The route handler is currently failing.');
    const selectContextImpl = vi.fn().mockResolvedValue({
      'app/routes/api.chat.ts': {
        type: 'file',
        content: 'export async function action() {}',
        isBinary: false,
      },
    });
    const streamTextImpl = createSynthesisStreamMock({
      finishReasons: ['stop'],
      texts: ['Repair final response'],
    });

    await executeChatOrchestration({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '[Model: claude-3-5-sonnet-latest]\n\n[Provider: anthropic]\n\nFix the broken chat route.',
        },
      ],
      files: {
        '/home/project/app/routes/api.chat.ts': {
          type: 'file',
          content: 'export async function action() {}',
          isBinary: false,
        },
      },
      operatorMode: 'repair-existing',
      contextOptimization: false,
      env: {} as Env,
      dataStream,
      deps: {
        generateTextImpl: generateTextImpl as never,
        streamTextImpl: streamTextImpl as never,
        createSummaryImpl,
        selectContextImpl,
      },
    });

    expect(createSummaryImpl).toHaveBeenCalledTimes(1);
    expect(selectContextImpl).toHaveBeenCalledTimes(1);
    expect(generateTextImpl.mock.calls[0][0].prompt).toContain('Mode: Repair Existing Project');
  });
});
