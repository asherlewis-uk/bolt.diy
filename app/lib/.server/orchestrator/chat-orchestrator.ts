import { generateId, generateText, type DataStreamWriter, type Message } from 'ai';
import { z } from 'zod';
import {
  createArtifactContext,
  createArtifactContextAnnotation,
  formatArtifactContextForPrompt,
  hasArtifactContext,
  type ResolvedArtifactContext,
} from '~/lib/.server/artifact-context';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import {
  loadProjectMemory,
  persistProjectMemory,
  type LoadProjectMemoryResult,
  type PersistProjectMemoryInput,
  type PersistProjectMemoryResult,
  type ProjectMemoryConnection,
  type ProjectMemoryEntry,
} from '~/lib/.server/project-memory';
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import { createFilesContext, extractPropertiesFromMessage, simplifyBoltActions } from '~/lib/.server/llm/utils';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts';
import { getOperatorModeDefinition, resolveOperatorMode, type OperatorMode } from '~/lib/common/operator-mode';
import { LLMManager } from '~/lib/modules/llm/manager';
import type { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { ProgressAnnotation, ArtifactContextRequestPayload } from '~/types/context';
import type { IProviderSetting } from '~/types/model';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('chat-orchestrator');

const architectOutputSchema = z.object({
  plan: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  responseStyle: z.string().min(1),
});

const builderOutputSchema = z.object({
  implementationOutline: z.array(z.string().min(1)).min(1),
  responseStrategy: z.string().min(1),
  artifacts: z.array(z.string().min(1)).default([]),
  unresolvedQuestions: z.array(z.string().min(1)).default([]),
});

const criticOutputSchema = z.object({
  reviewSummary: z.string().min(1),
  findings: z.array(z.string().min(1)).default([]),
  mustFix: z.array(z.string().min(1)).default([]),
  readyForSynthesis: z.boolean(),
});

type ArchitectOutput = z.infer<typeof architectOutputSchema>;
type BuilderOutput = z.infer<typeof builderOutputSchema>;
type CriticOutput = z.infer<typeof criticOutputSchema>;
type StructuredStage = Exclude<OrchestratorStage, 'synthesis'>;

const MAX_STRUCTURED_STAGE_ATTEMPTS = 2;
const MAX_CRITIC_REPAIR_CYCLES = 2;

export type OrchestratorStage = 'architect' | 'builder' | 'critic' | 'synthesis';

export interface StageModelRoute {
  stage: OrchestratorStage;
  model: string;
  provider: string;
}

export interface OrchestratorModelChain {
  architect: StageModelRoute;
  builder: StageModelRoute;
  critic: StageModelRoute;
  synthesis: StageModelRoute;
}

export interface ChatOrchestratorArgs {
  messages: Messages;
  files?: FileMap;
  artifactContext?: ArtifactContextRequestPayload;
  promptId?: string;
  operatorMode?: OperatorMode;
  contextOptimization: boolean;
  supabase?: ProjectMemoryConnection & {
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  dataStream: DataStreamWriter;
  deps?: ChatOrchestratorDependencies;
}

export interface ChatOrchestratorDependencies {
  generateTextImpl?: typeof generateText;
  streamTextImpl?: typeof streamText;
  createSummaryImpl?: typeof createSummary;
  selectContextImpl?: typeof selectContext;
  loadProjectMemoryImpl?: (connection?: ProjectMemoryConnection) => Promise<LoadProjectMemoryResult>;
  persistProjectMemoryImpl?: (
    input: PersistProjectMemoryInput,
  ) => Promise<PersistProjectMemoryResult>;
}

interface OrchestratorUsage {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

interface StageContext {
  operatorMode: OperatorMode;
  userRequest: string;
  recentConversation: string;
  summary?: string;
  contextFiles?: FileMap;
  artifactContext: ResolvedArtifactContext;
  projectMemoryEntries: ProjectMemoryEntry[];
  projectMemoryStatus: LoadProjectMemoryResult['status'];
}

export function resolveOrchestratorModelChain({
  messages,
  env,
}: {
  messages: Messages;
  env?: Env;
}): OrchestratorModelChain {
  const lastUserMessage = messages.filter((message) => message.role === 'user').slice(-1)[0];
  const requestedRoute = lastUserMessage
    ? (() => {
        const { model, provider } = extractPropertiesFromMessage(lastUserMessage);
        return { model, provider };
      })()
    : { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER.name };

  return {
    architect: resolveStageRoute('architect', requestedRoute, env),
    builder: resolveStageRoute('builder', requestedRoute, env),
    critic: resolveStageRoute('critic', requestedRoute, env),
    synthesis: resolveStageRoute('synthesis', requestedRoute, env),
  };
}

export async function executeChatOrchestration(args: ChatOrchestratorArgs) {
  const {
    messages,
    env,
    apiKeys,
    providerSettings,
    files,
    artifactContext: artifactContextRequest,
    promptId,
    operatorMode: requestedOperatorMode,
    contextOptimization,
    supabase,
    dataStream,
    deps,
  } = args;

  const generateTextImpl = deps?.generateTextImpl ?? generateText;
  const streamTextImpl = deps?.streamTextImpl ?? streamText;
  const createSummaryImpl = deps?.createSummaryImpl ?? createSummary;
  const selectContextImpl = deps?.selectContextImpl ?? selectContext;
  const loadProjectMemoryImpl = deps?.loadProjectMemoryImpl ?? loadProjectMemory;
  const persistProjectMemoryImpl = deps?.persistProjectMemoryImpl ?? persistProjectMemory;

  const cumulativeUsage: OrchestratorUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  const operatorMode = resolveOperatorMode(requestedOperatorMode);

  let progressCounter = 1;
  const filePaths = getFilePaths(files || {});
  const artifactContext = createArtifactContext({
    files,
    request: artifactContextRequest,
  });
  let filteredFiles: FileMap | undefined;
  let summary: string | undefined;
  const messageSliceId = messages.length > 3 ? messages.length - 3 : 0;

  if (hasArtifactContext(artifactContext)) {
    dataStream.writeMessageAnnotation(createArtifactContextAnnotation(artifactContext) as any);
  }

  if (
    shouldLoadRepoContextForMode({
      operatorMode,
      contextOptimization,
      filePaths,
      artifactContext,
    })
  ) {
    writeProgress(dataStream, {
      phase: 'summary',
      group: 'context',
      label: 'summary',
      status: 'in-progress',
      order: progressCounter++,
      message: 'Analysing Request',
    });

    summary = await createSummaryImpl({
      messages: [...messages],
      env,
      apiKeys,
      providerSettings,
      promptId,
      contextOptimization,
      onFinish(response) {
        mergeUsage(cumulativeUsage, response.usage);
      },
    });

    writeProgress(dataStream, {
      phase: 'summary',
      group: 'context',
      label: 'summary',
      status: 'complete',
      order: progressCounter++,
      message: 'Analysis Complete',
    });

    dataStream.writeMessageAnnotation({
      type: 'chatSummary',
      summary,
      chatId: messages.slice(-1)?.[0]?.id,
    } as any);

    writeProgress(dataStream, {
      phase: 'context',
      group: 'context',
      label: 'context',
      status: 'in-progress',
      order: progressCounter++,
      message: 'Determining Files to Read',
    });

    filteredFiles = await selectContextImpl({
      messages: [...messages],
      env,
      apiKeys,
      files: files || {},
      providerSettings,
      promptId,
      contextOptimization,
      summary,
      artifactContext,
      onFinish(response) {
        mergeUsage(cumulativeUsage, response.usage);
      },
    });

    dataStream.writeMessageAnnotation({
      type: 'codeContext',
      files: Object.keys(filteredFiles).map((key) => {
        let path = key;

        if (path.startsWith(WORK_DIR)) {
          path = path.replace(WORK_DIR, '');
        }

        return path;
      }),
    } as any);

    writeProgress(dataStream, {
      phase: 'context',
      group: 'context',
      label: 'context',
      status: 'complete',
      order: progressCounter++,
      message: 'Code Files Selected',
    });
  }

  writeProgress(dataStream, {
    phase: 'memory',
    group: 'memory',
    label: 'memory-load',
    status: 'in-progress',
    order: progressCounter++,
    message: 'Loading Project Memory',
  });

  const projectMemoryResult = await loadProjectMemoryImpl(supabase);

  writeProgress(dataStream, {
    phase: 'memory',
    group: 'memory',
    label: 'memory-load',
    status: projectMemoryResult.status === 'available' ? 'complete' : 'failed',
    order: progressCounter++,
    message: getProjectMemoryLoadMessage(projectMemoryResult),
  });

  const modelChain = resolveOrchestratorModelChain({ messages, env });
  const stageContext = createStageContext({
    operatorMode,
    messages,
    summary,
    contextFiles: filteredFiles,
    artifactContext,
    projectMemoryResult,
  });

  const architect = await runStructuredStage({
    stage: 'architect',
    route: modelChain.architect,
    schema: architectOutputSchema,
    system: [
      'You are the ARCHITECT stage for a production-first AI builder.',
      'Return JSON only.',
      'Define the implementation plan for the final assistant response without writing code or markup.',
      getModeStageInstruction(stageContext.operatorMode, 'architect'),
    ].join('\n'),
    prompt: [
      createSharedContext(stageContext),
      'Return a JSON object with keys:',
      '- plan: a concrete execution plan for the response',
      '- goals: an array of the main goals that must be satisfied',
      '- constraints: an array of constraints that must be preserved',
      '- responseStyle: how the final synthesis should communicate the result',
    ].join('\n\n'),
    env,
    apiKeys,
    providerSettings,
    generateTextImpl,
    dataStream,
    usage: cumulativeUsage,
    progressOrder: () => progressCounter++,
  });

  const { builder, critic } = await runBuilderCriticLoop({
    architect,
    stageContext,
    modelChain,
    env,
    apiKeys,
    providerSettings,
    generateTextImpl,
    dataStream,
    usage: cumulativeUsage,
    progressOrder: () => progressCounter++,
  });

  const synthesisMessages = buildSynthesisMessages({
    messages,
    route: modelChain.synthesis,
    stageContext,
    architect,
    builder,
    critic,
  });

  writeProgress(dataStream, {
    phase: 'synthesis',
    group: 'orchestrator',
    label: 'synthesis',
    status: 'in-progress',
    order: progressCounter++,
    message: 'Synthesising Final Response',
  });

  let synthesisSegments = 1;
  let usedSynthesisContinuation = false;

  const streamSynthesis = async () => {
    const options: StreamingOptions = {
      supabaseConnection: supabase
        ? {
            isConnected: !!supabase.isConnected,
            hasSelectedProject: !!supabase.hasSelectedProject,
            credentials: supabase.credentials,
          }
        : undefined,
      toolChoice: 'none',
      onFinish: async ({ text, finishReason, usage }) => {
        mergeUsage(cumulativeUsage, usage);

        if (finishReason !== 'length') {
          if (usedSynthesisContinuation) {
            writeLoopProgress(dataStream, {
              label: 'synthesis-continuation',
              status: 'complete',
              order: progressCounter++,
              message: `Synthesis continuation completed within ${synthesisSegments}/${MAX_RESPONSE_SEGMENTS} segments`,
            });
          }

          writeProgress(dataStream, {
            phase: 'memory',
            group: 'memory',
            label: 'memory-persist',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Persisting Project Memory',
          });

          const persistResult = await persistProjectMemoryImpl({
            connection: supabase,
            userRequest: stageContext.userRequest,
            chatId: messages.slice(-1)?.[0]?.id,
            architect,
            builder,
            critic,
            finalResponse: text,
          });

          writeProgress(dataStream, {
            phase: 'memory',
            group: 'memory',
            label: 'memory-persist',
            status: persistResult.status === 'persisted' ? 'complete' : 'failed',
            order: progressCounter++,
            message: getProjectMemoryPersistMessage(persistResult),
          });

          dataStream.writeMessageAnnotation({
            type: 'usage',
            value: {
              completionTokens: cumulativeUsage.completionTokens,
              promptTokens: cumulativeUsage.promptTokens,
              totalTokens: cumulativeUsage.totalTokens,
            },
          });

          writeProgress(dataStream, {
            phase: 'synthesis',
            group: 'orchestrator',
            label: 'synthesis',
            status: 'complete',
            order: progressCounter++,
            message: 'Final Response Ready',
          });

          return;
        }

        if (synthesisSegments >= MAX_RESPONSE_SEGMENTS) {
          const message = `Stopped synthesis continuation after ${synthesisSegments}/${MAX_RESPONSE_SEGMENTS} segments`;
          writeLoopProgress(dataStream, {
            label: 'synthesis-continuation',
            status: 'failed',
            order: progressCounter++,
            message,
          });
          throw new Error(`${message}: maximum continuation budget reached`);
        }

        synthesisSegments += 1;
        usedSynthesisContinuation = true;
        writeLoopProgress(dataStream, {
          label: 'synthesis-continuation',
          status: 'in-progress',
          order: progressCounter++,
          message: `Continuing synthesis response (${synthesisSegments}/${MAX_RESPONSE_SEGMENTS})`,
        });
        synthesisMessages.push({ id: generateId(), role: 'assistant', content: text });
        synthesisMessages.push({
          id: generateId(),
          role: 'user',
          content: `[Model: ${modelChain.synthesis.model}]\n\n[Provider: ${modelChain.synthesis.provider}]\n\n${CONTINUE_PROMPT}`,
        });

        const continuation = await streamSynthesis();
        continuation.mergeIntoDataStream(dataStream);
        void monitorStreamErrors(continuation.fullStream);
      },
    };

    return streamTextImpl({
      messages: synthesisMessages,
      env,
      options,
      apiKeys,
      files,
      providerSettings,
      promptId,
      contextOptimization,
      contextFiles: filteredFiles,
      summary,
      messageSliceId,
    });
  };

  try {
    const result = await streamSynthesis();
    result.mergeIntoDataStream(dataStream);
    void monitorStreamErrors(result.fullStream);
  } catch (error) {
    writeProgress(dataStream, {
      phase: 'synthesis',
      group: 'orchestrator',
      label: 'synthesis',
      status: 'failed',
      order: progressCounter++,
      message: getErrorMessage(error),
    });
    throw error;
  }
}

function resolveStageRoute(
  stage: OrchestratorStage,
  requestedRoute: { model: string; provider: string },
  env?: Env,
): StageModelRoute {
  const stageKey = stage.toUpperCase();
  const stageEnv = env as Record<string, string | undefined> | undefined;

  return {
    stage,
    model: stageEnv?.[`ORCHESTRATOR_${stageKey}_MODEL`] || requestedRoute.model,
    provider: stageEnv?.[`ORCHESTRATOR_${stageKey}_PROVIDER`] || requestedRoute.provider,
  };
}

function createStageContext({
  messages,
  operatorMode,
  summary,
  contextFiles,
  artifactContext,
  projectMemoryResult,
}: {
  messages: Messages;
  operatorMode: OperatorMode;
  summary?: string;
  contextFiles?: FileMap;
  artifactContext: ResolvedArtifactContext;
  projectMemoryResult: LoadProjectMemoryResult;
}): StageContext {
  const lastUserMessage = messages.filter((message) => message.role === 'user').slice(-1)[0];
  const { content } = lastUserMessage
    ? extractPropertiesFromMessage(lastUserMessage)
    : { content: 'No user request provided.' };

  return {
    operatorMode,
    userRequest: typeof content === 'string' ? content.trim() : stringifyMessageContent(content),
    recentConversation: messages.slice(-6).map(formatMessageForStage).join('\n\n'),
    summary,
    contextFiles,
    artifactContext,
    projectMemoryEntries: projectMemoryResult.entries,
    projectMemoryStatus: projectMemoryResult.status,
  };
}

function createSharedContext(stageContext: StageContext) {
  const contextSections = [
    `OPERATOR MODE\n${formatOperatorModeContext(stageContext.operatorMode)}`,
    `USER REQUEST\n${stageContext.userRequest || 'No user request provided.'}`,
    stageContext.summary ? `CHAT SUMMARY\n${stageContext.summary}` : 'CHAT SUMMARY\nNo prior chat summary was generated for this turn.',
    `RECENT CONVERSATION\n${stageContext.recentConversation || 'No recent conversation available.'}`,
  ];

  if (stageContext.contextFiles && Object.keys(stageContext.contextFiles).length > 0) {
    contextSections.push(`SELECTED FILE CONTEXT\n${createFilesContext(stageContext.contextFiles, true)}`);
  } else {
    contextSections.push('SELECTED FILE CONTEXT\nNo code context files were selected for this turn.');
  }

  contextSections.push(`PROJECT ARTIFACT CONTEXT\n${formatArtifactContextForPrompt(stageContext.artifactContext)}`);
  contextSections.push(`PROJECT MEMORY\n${formatProjectMemoryContext(stageContext)}`);

  return contextSections.join('\n\n');
}

async function runStructuredStage<TSchema extends z.ZodTypeAny>({
  stage,
  route,
  schema,
  system,
  prompt,
  env,
  apiKeys,
  providerSettings,
  generateTextImpl,
  dataStream,
  usage,
  progressOrder,
}: {
  stage: StructuredStage;
  route: StageModelRoute;
  schema: TSchema;
  system: string;
  prompt: string;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  generateTextImpl: typeof generateText;
  dataStream: DataStreamWriter;
  usage: OrchestratorUsage;
  progressOrder: () => number;
}): Promise<z.infer<TSchema>> {
  writeProgress(dataStream, {
    phase: stage,
    group: 'orchestrator',
    label: stage,
    status: 'in-progress',
    order: progressOrder(),
    message: getProgressMessage(stage, 'in-progress'),
  });

  for (let attempt = 1; attempt <= MAX_STRUCTURED_STAGE_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        writeLoopProgress(dataStream, {
          label: `${stage}-retry`,
          status: 'in-progress',
          order: progressOrder(),
          message: `Retrying ${stage} stage (${attempt}/${MAX_STRUCTURED_STAGE_ATTEMPTS})`,
        });
      }

      const resolvedRoute = await resolveModelRoute({
        route,
        env,
        apiKeys,
        providerSettings,
      });

      logger.info(`Running ${stage} stage with ${resolvedRoute.provider.name}:${resolvedRoute.model.name}`);

      const response = await generateTextImpl({
        system,
        prompt,
        model: resolvedRoute.provider.getModelInstance({
          model: resolvedRoute.model.name,
          serverEnv: env,
          apiKeys,
          providerSettings,
        }),
        maxTokens: Math.min(MAX_TOKENS, resolvedRoute.model.maxTokenAllowed || MAX_TOKENS),
        toolChoice: 'none',
      });

      mergeUsage(usage, response.usage);

      const output = parseStructuredStageOutput({
        stage,
        schema,
        text: response.text,
      });

      if (attempt > 1) {
        writeLoopProgress(dataStream, {
          label: `${stage}-retry`,
          status: 'complete',
          order: progressOrder(),
          message: `${capitalizeStage(stage)} stage recovered on attempt ${attempt}/${MAX_STRUCTURED_STAGE_ATTEMPTS}`,
        });
      }

      writeProgress(dataStream, {
        phase: stage,
        group: 'orchestrator',
        label: stage,
        status: 'complete',
        order: progressOrder(),
        message: getProgressMessage(stage, 'complete'),
      });

      return output;
    } catch (error) {
      if (attempt < MAX_STRUCTURED_STAGE_ATTEMPTS) {
        continue;
      }

      writeProgress(dataStream, {
        phase: stage,
        group: 'orchestrator',
        label: stage,
        status: 'failed',
        order: progressOrder(),
        message: `${capitalizeStage(stage)} stage failed`,
      });

      throw new Error(
        `${capitalizeStage(stage)} stage failed after ${MAX_STRUCTURED_STAGE_ATTEMPTS} attempts: ${getErrorMessage(error)}`,
      );
    }
  }

  throw new Error(`${capitalizeStage(stage)} stage did not produce an output`);
}

async function runBuilderCriticLoop({
  architect,
  stageContext,
  modelChain,
  env,
  apiKeys,
  providerSettings,
  generateTextImpl,
  dataStream,
  usage,
  progressOrder,
}: {
  architect: ArchitectOutput;
  stageContext: StageContext;
  modelChain: OrchestratorModelChain;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  generateTextImpl: typeof generateText;
  dataStream: DataStreamWriter;
  usage: OrchestratorUsage;
  progressOrder: () => number;
}): Promise<{ builder: BuilderOutput; critic: CriticOutput }> {
  let repairCount = 0;
  let builder = await runBuilderStage({
    architect,
    stageContext,
    route: modelChain.builder,
    env,
    apiKeys,
    providerSettings,
    generateTextImpl,
    dataStream,
    usage,
    progressOrder,
  });

  let critic = await runCriticStage({
    architect,
    builder,
    stageContext,
    route: modelChain.critic,
    env,
    apiKeys,
    providerSettings,
    generateTextImpl,
    dataStream,
    usage,
    progressOrder,
  });

  while (shouldRepairAfterCritic(critic)) {
    if (repairCount >= MAX_CRITIC_REPAIR_CYCLES) {
      const message = getRepairLoopFailureMessage(critic);
      writeLoopProgress(dataStream, {
        label: 'repair-loop',
        status: 'failed',
        order: progressOrder(),
        message,
      });
      throw new Error(message);
    }

    repairCount += 1;
    writeLoopProgress(dataStream, {
      label: 'repair-loop',
      status: 'in-progress',
      order: progressOrder(),
      message: getRepairLoopInProgressMessage(repairCount, critic),
    });

    builder = await runBuilderStage({
      architect,
      stageContext,
      route: modelChain.builder,
      env,
      apiKeys,
      providerSettings,
      generateTextImpl,
      dataStream,
      usage,
      progressOrder,
      repairAttempt: repairCount,
      repairFeedback: critic,
    });

    critic = await runCriticStage({
      architect,
      builder,
      stageContext,
      route: modelChain.critic,
      env,
      apiKeys,
      providerSettings,
      generateTextImpl,
      dataStream,
      usage,
      progressOrder,
      repairAttempt: repairCount,
      priorCritic: critic,
    });
  }

  if (repairCount > 0) {
    writeLoopProgress(dataStream, {
      label: 'repair-loop',
      status: 'complete',
      order: progressOrder(),
      message: `Repair loop converged after ${repairCount}/${MAX_CRITIC_REPAIR_CYCLES} attempts`,
    });
  }

  return { builder, critic };
}

async function runBuilderStage({
  architect,
  stageContext,
  route,
  env,
  apiKeys,
  providerSettings,
  generateTextImpl,
  dataStream,
  usage,
  progressOrder,
  repairAttempt,
  repairFeedback,
}: {
  architect: ArchitectOutput;
  stageContext: StageContext;
  route: StageModelRoute;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  generateTextImpl: typeof generateText;
  dataStream: DataStreamWriter;
  usage: OrchestratorUsage;
  progressOrder: () => number;
  repairAttempt?: number;
  repairFeedback?: CriticOutput;
}) {
  return runStructuredStage({
    stage: 'builder',
    route,
    schema: builderOutputSchema,
    system: [
      'You are the BUILDER stage for a production-first AI builder.',
      'Return JSON only.',
      'Use the structured project artifact context, especially modified files and workbench artifacts, when deciding the response strategy.',
      'Turn the architect plan into an implementation-ready response strategy for the final assistant turn.',
      getModeStageInstruction(stageContext.operatorMode, 'builder'),
      repairFeedback
        ? `This is repair attempt ${repairAttempt}/${MAX_CRITIC_REPAIR_CYCLES}. Resolve every critic must-fix item before returning.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    prompt: [
      createSharedContext(stageContext),
      'ARCHITECT OUTPUT',
      JSON.stringify(architect, null, 2),
      repairFeedback ? 'CRITIC REPAIR DIRECTIVE' : '',
      repairFeedback ? JSON.stringify(repairFeedback, null, 2) : '',
      repairFeedback
        ? `Repair attempt ${repairAttempt}/${MAX_CRITIC_REPAIR_CYCLES}. Return a builder output that resolves the critic objections.`
        : '',
      'Return a JSON object with keys:',
      '- implementationOutline: ordered steps the synthesis stage should execute',
      '- responseStrategy: how the final response should satisfy the user request',
      '- artifacts: an array of files or surfaces likely to be involved',
      '- unresolvedQuestions: an array of remaining questions or assumptions',
    ]
      .filter(Boolean)
      .join('\n\n'),
    env,
    apiKeys,
    providerSettings,
    generateTextImpl,
    dataStream,
    usage,
    progressOrder,
  });
}

async function runCriticStage({
  architect,
  builder,
  stageContext,
  route,
  env,
  apiKeys,
  providerSettings,
  generateTextImpl,
  dataStream,
  usage,
  progressOrder,
  repairAttempt,
  priorCritic,
}: {
  architect: ArchitectOutput;
  builder: BuilderOutput;
  stageContext: StageContext;
  route: StageModelRoute;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  generateTextImpl: typeof generateText;
  dataStream: DataStreamWriter;
  usage: OrchestratorUsage;
  progressOrder: () => number;
  repairAttempt?: number;
  priorCritic?: CriticOutput;
}) {
  return runStructuredStage({
    stage: 'critic',
    route,
    schema: criticOutputSchema,
    system: [
      'You are the CRITIC stage for a production-first AI builder.',
      'Return JSON only.',
      'Review the plan against the actual project artifact context, not message text alone.',
      'Review the architect and builder outputs for correctness, risk, and missing fixes before synthesis.',
      getModeStageInstruction(stageContext.operatorMode, 'critic'),
      priorCritic
        ? `This is repair verification pass ${repairAttempt}/${MAX_CRITIC_REPAIR_CYCLES}. Only set readyForSynthesis to true when every prior must-fix item is resolved.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    prompt: [
      createSharedContext(stageContext),
      'ARCHITECT OUTPUT',
      JSON.stringify(architect, null, 2),
      'BUILDER OUTPUT',
      JSON.stringify(builder, null, 2),
      priorCritic ? 'PRIOR CRITIC OUTPUT' : '',
      priorCritic ? JSON.stringify(priorCritic, null, 2) : '',
      'Return a JSON object with keys:',
      '- reviewSummary: short summary of whether the work is ready',
      '- findings: issues or risks that synthesis must account for',
      '- mustFix: items that must be resolved in the final response',
      '- readyForSynthesis: true when the final stage can proceed',
    ]
      .filter(Boolean)
      .join('\n\n'),
    env,
    apiKeys,
    providerSettings,
    generateTextImpl,
    dataStream,
    usage,
    progressOrder,
  });
}

async function resolveModelRoute({
  route,
  env,
  apiKeys,
  providerSettings,
}: {
  route: StageModelRoute;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
}): Promise<{ provider: BaseProvider; model: ModelInfo }> {
  const provider = PROVIDER_LIST.find((candidate) => candidate.name === route.provider) || DEFAULT_PROVIDER;
  const manager = LLMManager.getInstance();
  const staticModels = manager.getStaticModelListFromProvider(provider);
  let model = staticModels.find((candidate) => candidate.name === route.model);

  if (!model) {
    const availableModels = await manager.getModelListFromProvider(provider, {
      apiKeys,
      providerSettings,
      serverEnv: env as Record<string, string> | undefined,
    });

    model = availableModels.find((candidate) => candidate.name === route.model);

    if (!model) {
      if (availableModels.length === 0) {
        throw new Error(`No models found for provider ${provider.name}`);
      }

      logger.warn(
        `Requested model ${route.model} for stage ${route.stage} not found on provider ${provider.name}. Falling back to ${availableModels[0].name}.`,
      );
      model = availableModels[0];
    }
  }

  return { provider, model };
}

function parseStructuredStageOutput<TSchema extends z.ZodTypeAny>({
  stage,
  schema,
  text,
}: {
  stage: Exclude<OrchestratorStage, 'synthesis'>;
  schema: TSchema;
  text: string;
}): z.infer<TSchema> {
  const payload = extractJsonPayload(text);

  try {
    return schema.parse(JSON.parse(payload));
  } catch (error) {
    logger.error(`Invalid ${stage} stage output`, error);
    throw new Error(`Invalid ${stage} stage output`);
  }
}

function extractJsonPayload(text: string) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Stage output did not contain a JSON object');
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function buildSynthesisMessages({
  messages,
  route,
  stageContext,
  architect,
  builder,
  critic,
}: {
  messages: Messages;
  route: StageModelRoute;
  stageContext: StageContext;
  architect: ArchitectOutput;
  builder: BuilderOutput;
  critic: CriticOutput;
}): Messages {
  const synthesisInstruction = [
    `[Model: ${route.model}]`,
    `[Provider: ${route.provider}]`,
    'Use the orchestrator outputs below to answer the user request.',
    'Do not mention the internal stage names unless they materially help the user.',
    'If code or file changes are required, emit the same bolt artifact/action format expected by the existing system prompt.',
    getModeStageInstruction(stageContext.operatorMode, 'synthesis'),
    '',
    createSharedContext(stageContext),
    '',
    'ARCHITECT OUTPUT',
    JSON.stringify(architect, null, 2),
    '',
    'BUILDER OUTPUT',
    JSON.stringify(builder, null, 2),
    '',
    'CRITIC OUTPUT',
    JSON.stringify(critic, null, 2),
  ].join('\n\n');

  return [
    ...messages,
    {
      id: generateId(),
      role: 'user',
      content: synthesisInstruction,
    },
  ];
}

function getProgressMessage(stage: StructuredStage, status: 'in-progress' | 'complete') {
  const messages = {
    architect: {
      'in-progress': 'Planning Solution',
      complete: 'Plan Ready',
    },
    builder: {
      'in-progress': 'Preparing Implementation Strategy',
      complete: 'Implementation Strategy Ready',
    },
    critic: {
      'in-progress': 'Reviewing Plan',
      complete: 'Review Complete',
    },
  } as const;

  return messages[stage][status];
}

function shouldRepairAfterCritic(critic: CriticOutput) {
  return !critic.readyForSynthesis || critic.mustFix.length > 0;
}

function shouldLoadRepoContextForMode({
  operatorMode,
  contextOptimization,
  filePaths,
  artifactContext,
}: {
  operatorMode: OperatorMode;
  contextOptimization: boolean;
  filePaths: string[];
  artifactContext: ResolvedArtifactContext;
}) {
  if (filePaths.length === 0) {
    return false;
  }

  const mode = getOperatorModeDefinition(operatorMode);

  switch (mode.contextPolicy) {
    case 'artifact-driven':
      return hasFocusedArtifactSignal(artifactContext);
    case 'require-repo-context':
      return true;
    case 'follow-setting':
    default:
      return contextOptimization;
  }
}

function hasFocusedArtifactSignal(artifactContext: ResolvedArtifactContext) {
  return !!(artifactContext.selectedFile || artifactContext.modifiedFiles.length > 0 || artifactContext.artifacts.length > 0);
}

function formatOperatorModeContext(operatorMode: OperatorMode) {
  const mode = getOperatorModeDefinition(operatorMode);

  return [`Mode: ${mode.label}`, `Description: ${mode.description}`, `Runtime behavior: ${mode.runtimeBehavior}`].join('\n');
}

function getModeStageInstruction(mode: OperatorMode, stage: OrchestratorStage) {
  const instructions: Record<OperatorMode, Record<OrchestratorStage, string>> = {
    'greenfield-build': {
      architect: 'Prefer a fresh implementation plan. Only anchor on existing repo files when the active artifact state points to them directly.',
      builder: 'Bias toward establishing the new structure cleanly instead of inheriting unrelated legacy patterns.',
      critic: 'Review for completeness of the new build path and avoid forcing legacy constraints unless the active artifact state proves they matter.',
      synthesis: 'Present the result as a clean new build path, while still respecting any concrete artifact-linked files in scope.',
    },
    'feature-add': {
      architect: 'Integrate the requested capability into the existing project shape and preserve current behavior outside the new feature.',
      builder: 'Use the current repo structure as the default landing zone for the new feature and identify the touched surfaces explicitly.',
      critic: 'Check that the proposed feature fits the existing project structure without causing avoidable regressions.',
      synthesis: 'Present the result as an addition to the current project, grounded in the existing touched files and artifacts.',
    },
    'repair-existing': {
      architect: 'Start from diagnosis. Anchor the plan in the current project state and focus on the smallest credible fix path.',
      builder: 'Prioritize root-cause repair, keep the patch narrow, and identify the exact broken surfaces before proposing changes.',
      critic: 'Reject plans that do not diagnose the failure mode or that change unrelated behavior without necessity.',
      synthesis: 'Present the result as a repair of existing behavior, including the affected surfaces and the reason the fix is bounded.',
    },
    'refactor-existing': {
      architect: 'Plan structural improvement around the existing codebase and make behavior preservation an explicit constraint.',
      builder: 'Prioritize maintainability, reduce duplication, and preserve public behavior while identifying the refactor surfaces explicitly.',
      critic: 'Reject plans that risk behavior drift, interface breaks, or unnecessary scope expansion during the refactor.',
      synthesis: 'Present the result as a behavior-preserving refactor, grounded in the existing code surfaces being reorganized.',
    },
  };

  return instructions[mode][stage];
}

function getRepairLoopInProgressMessage(repairCount: number, critic: CriticOutput) {
  return `Repairing plan (${repairCount}/${MAX_CRITIC_REPAIR_CYCLES}): ${summarizeCriticFeedback(critic)}`;
}

function getRepairLoopFailureMessage(critic: CriticOutput) {
  return `Stopped after ${MAX_CRITIC_REPAIR_CYCLES} repair attempts: ${summarizeCriticFeedback(critic)}`;
}

function summarizeCriticFeedback(critic: CriticOutput) {
  return critic.mustFix[0] || critic.findings[0] || critic.reviewSummary;
}

function getProjectMemoryLoadMessage(result: LoadProjectMemoryResult) {
  if (result.status === 'available') {
    return result.entries.length > 0 ? 'Project Memory Loaded' : 'No Stored Project Memory Yet';
  }

  return result.reason || 'Project Memory Unavailable';
}

function getProjectMemoryPersistMessage(result: PersistProjectMemoryResult) {
  if (result.status === 'persisted') {
    return 'Project Memory Persisted';
  }

  return result.reason || 'Project Memory Not Persisted';
}

function formatProjectMemoryContext(stageContext: StageContext) {
  if (stageContext.projectMemoryStatus !== 'available') {
    return 'Durable project memory was unavailable for this turn.';
  }

  if (stageContext.projectMemoryEntries.length === 0) {
    return 'No stored project memory exists for this project yet.';
  }

  return stageContext.projectMemoryEntries
    .map((entry, index) => {
      const artifactLine = Array.isArray(entry.stageSnapshot.artifacts)
        ? entry.stageSnapshot.artifacts
            .filter((artifact): artifact is string => typeof artifact === 'string')
            .join(', ')
        : '';

      return [
        `Memory ${index + 1} (${entry.createdAt || 'unknown time'})`,
        entry.memorySummary,
        artifactLine ? `Artifacts: ${artifactLine}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

function writeProgress(dataStream: DataStreamWriter, progress: Omit<ProgressAnnotation, 'type'>) {
  dataStream.writeData({
    ...progress,
    type: 'progress',
  });
}

function writeLoopProgress(
  dataStream: DataStreamWriter,
  progress: Omit<ProgressAnnotation, 'type' | 'phase' | 'group'>,
) {
  writeProgress(dataStream, {
    ...progress,
    phase: 'loop',
    group: 'orchestrator',
  });
}

function mergeUsage(target: OrchestratorUsage, usage?: Partial<OrchestratorUsage>) {
  if (!usage) {
    return;
  }

  target.completionTokens += usage.completionTokens || 0;
  target.promptTokens += usage.promptTokens || 0;
  target.totalTokens += usage.totalTokens || 0;
}

function formatMessageForStage(message: Message) {
  if (message.role === 'user') {
    const { content } = extractPropertiesFromMessage(message);
    return `[user]\n${typeof content === 'string' ? content.trim() : stringifyMessageContent(content)}`;
  }

  if (message.role === 'assistant') {
    let content = stringifyMessageContent(message.content);
    content = simplifyBoltActions(content);
    content = content.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
    content = content.replace(/<think>.*?<\/think>/s, '');

    return `[assistant]\n${content.trim()}`;
  }

  return `[${message.role}]\n${stringifyMessageContent(message.content)}`;
}

function stringifyMessageContent(content: Message['content']) {
  if (!Array.isArray(content)) {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text || '';
      }

      return `[${part.type}]`;
    })
    .join('\n')
    .trim();
}

async function monitorStreamErrors(stream: AsyncIterable<{ type: string; error?: unknown }>) {
  for await (const part of stream) {
    if (part.type === 'error') {
      logger.error(part.error);
      return;
    }
  }
}

function capitalizeStage(stage: StructuredStage) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown orchestrator error';
}
