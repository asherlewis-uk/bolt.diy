import { describe, expect, it } from 'vitest';
import {
  createArtifactContext,
  createArtifactContextAnnotation,
  formatArtifactContextForPrompt,
  getArtifactPriorityPaths,
} from './artifact-context';

describe('artifact context', () => {
  it('normalizes project files, modifications, and workbench artifacts from real runtime inputs', () => {
    const context = createArtifactContext({
      files: {
        '/home/project/app/routes/api.chat.ts': {
          type: 'file',
          content: 'export {};',
          isBinary: false,
        },
        '/home/project/app/components/chat/Chat.client.tsx': {
          type: 'file',
          content: 'export {};',
          isBinary: false,
        },
        '/home/project/node_modules/pkg/index.js': {
          type: 'file',
          content: 'ignored',
          isBinary: false,
        },
      },
      request: {
        selectedFile: '/home/project/app/routes/api.chat.ts',
        modifiedFiles: [
          {
            path: '/home/project/app/routes/api.chat.ts',
            kind: 'diff',
            content: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
        artifacts: [
          {
            id: 'artifact-1',
            title: 'Updated chat route',
            type: 'bundled',
            actionCount: 2,
            pendingActionCount: 1,
            filePaths: ['/home/project/app/routes/api.chat.ts', '/home/project/app/components/chat/Chat.client.tsx'],
          },
        ],
      },
    });

    expect(context.selectedFile).toBe('app/routes/api.chat.ts');
    expect(context.projectFileCount).toBe(2);
    expect(context.projectFiles).toEqual(['app/components/chat/Chat.client.tsx', 'app/routes/api.chat.ts']);
    expect(context.modifiedFiles).toEqual([
      {
        path: 'app/routes/api.chat.ts',
        kind: 'diff',
        content: '@@ -1 +1 @@\n-old\n+new',
      },
    ]);
    expect(context.artifacts).toEqual([
      {
        id: 'artifact-1',
        title: 'Updated chat route',
        type: 'bundled',
        actionCount: 2,
        pendingActionCount: 1,
        filePaths: ['app/components/chat/Chat.client.tsx', 'app/routes/api.chat.ts'],
      },
    ]);

    expect(getArtifactPriorityPaths(context)).toEqual([
      'app/routes/api.chat.ts',
      'app/components/chat/Chat.client.tsx',
    ]);

    expect(formatArtifactContextForPrompt(context)).toContain('PROJECT FILE INVENTORY');
    expect(formatArtifactContextForPrompt(context)).toContain('MODIFIED FILES');
    expect(formatArtifactContextForPrompt(context)).toContain('WORKBENCH ARTIFACTS');
    expect(formatArtifactContextForPrompt(context)).toContain('Updated chat route');
  });

  it('creates a UI-safe annotation without modified file contents', () => {
    const context = createArtifactContext({
      files: {},
      request: {
        modifiedFiles: [
          {
            path: 'app/routes/api.chat.ts',
            kind: 'file',
            content: 'secret content that should not be mirrored into annotations',
          },
        ],
      },
    });

    expect(createArtifactContextAnnotation(context)).toEqual({
      type: 'artifactContext',
      selectedFile: undefined,
      projectFileCount: 0,
      projectFiles: [],
      modifiedFiles: [
        {
          path: 'app/routes/api.chat.ts',
          kind: 'file',
        },
      ],
      artifacts: [],
    });
  });
});
