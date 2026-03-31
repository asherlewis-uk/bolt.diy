import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, type Message } from 'ai';
import { executeChatOrchestration } from '~/lib/.server/orchestrator/chat-orchestrator';
import {
  getApiKeysFromCookie,
  getProviderSettingsFromCookie,
  getSupabaseManagementTokenFromCookie,
} from '~/lib/api/cookies';
import { resolveOperatorMode, type OperatorMode } from '~/lib/common/operator-mode';
import { getServerEnv } from '~/lib/server-env';
import type { ArtifactContextRequestPayload } from '~/types/context';
import { createScopedLogger } from '~/utils/logger';

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

async function chatAction({ context, request }: ActionFunctionArgs) {
  const serverEnv = getServerEnv(context);
  const { messages, files, artifactContext, promptId, operatorMode, contextOptimization, supabase } = await request.json<{
    messages: Message[];
    files: any;
    artifactContext?: ArtifactContextRequestPayload;
    promptId?: string;
    operatorMode?: OperatorMode;
    contextOptimization: boolean;
    supabase?: {
      isConnected: boolean;
      hasSelectedProject: boolean;
      token?: string;
      selectedProjectId?: string;
      credentials?: {
        anonKey?: string;
        supabaseUrl?: string;
      };
    };
  }>();

  const apiKeys = getApiKeysFromCookie(request.headers.get('Cookie'));
  const providerSettings = getProviderSettingsFromCookie(request.headers.get('Cookie'));
  const supabaseToken = getSupabaseManagementTokenFromCookie(request.headers.get('Cookie'));
  const encoder = new TextEncoder();
  let lastChunk: string | undefined;

  try {
    const totalMessageContent = messages
      .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
      .join('');

    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);

    const dataStream = createDataStream({
      async execute(stream) {
        await executeChatOrchestration({
          messages,
          files,
          artifactContext,
          promptId,
          operatorMode: resolveOperatorMode(operatorMode),
          contextOptimization,
          supabase: supabase
            ? {
                ...supabase,
                token: supabaseToken,
              }
            : undefined,
          env: serverEnv as Env,
          apiKeys,
          providerSettings,
          dataStream: stream,
        });
      },
      onError(error) {
        if (error instanceof Error) {
          return `Orchestrator failed: ${error.message}`;
        }

        return 'Orchestrator failed';
      },
    }).pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (!lastChunk) {
            lastChunk = ' ';
          }

          if (typeof chunk === 'string') {
            if (chunk.startsWith('g') && !lastChunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "<div class=\\"__boltThought__\\">"\n`));
            }

            if (lastChunk.startsWith('g') && !chunk.startsWith('g')) {
              controller.enqueue(encoder.encode(`0: "</div>\\n"\n`));
            }
          }

          lastChunk = chunk;

          let transformedChunk = chunk;

          if (typeof chunk === 'string' && chunk.startsWith('g')) {
            let content = chunk.split(':').slice(1).join(':');

            if (content.endsWith('\n')) {
              content = content.slice(0, content.length - 1);
            }

            transformedChunk = `0:${content}\n`;
          }

          const serialized = typeof transformedChunk === 'string' ? transformedChunk : JSON.stringify(transformedChunk);
          controller.enqueue(encoder.encode(serialized));
        },
      }),
    );

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error(error);

    if (error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
