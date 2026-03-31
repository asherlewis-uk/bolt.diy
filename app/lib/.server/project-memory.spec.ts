import { describe, expect, it, vi } from 'vitest';
import { loadProjectMemory, persistProjectMemory } from './project-memory';

describe('project memory', () => {
  it('loads recent durable project memory entries', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 7,
              project_ref: 'project-123',
              chat_id: 'chat-1',
              user_request: 'Build a dashboard',
              memory_summary: 'Request: Build a dashboard',
              stage_snapshot: {
                implementationOutline: ['Inspect repo', 'Patch API route'],
              },
              created_at: '2026-03-30T12:00:00.000Z',
            },
          ]),
          { status: 200 },
        ),
      );

    const result = await loadProjectMemory(
      {
        isConnected: true,
        hasSelectedProject: true,
        token: 'token-123',
        selectedProjectId: 'project-123',
      },
      { fetchImpl },
    );

    expect(result).toEqual({
      status: 'available',
      projectId: 'project-123',
      entries: [
        {
          id: '7',
          projectRef: 'project-123',
          chatId: 'chat-1',
          userRequest: 'Build a dashboard',
          memorySummary: 'Request: Build a dashboard',
          stageSnapshot: {
            implementationOutline: ['Inspect repo', 'Patch API route'],
          },
          createdAt: '2026-03-30T12:00:00.000Z',
        },
      ],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer token-123',
      }),
    });
  });

  it('persists durable project memory rows through the approved query surface', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const result = await persistProjectMemory(
      {
        connection: {
          isConnected: true,
          hasSelectedProject: true,
          token: 'Bearer token-456',
          selectedProjectId: 'project-456',
        },
        chatId: 'chat-2',
        userRequest: "Ship the user's dashboard",
        architect: {
          plan: 'Review the existing route and add durable memory.',
          goals: ['Persist project memory'],
          constraints: ['Stay on the current runtime'],
          responseStyle: 'Direct',
        },
        builder: {
          implementationOutline: ['Load memory', 'Persist memory'],
          responseStrategy: 'Keep the response grounded in the current repo.',
          artifacts: ['app/routes/api.chat.ts'],
          unresolvedQuestions: [],
        },
        critic: {
          reviewSummary: 'The plan is ready for synthesis.',
          findings: ['No blocking issues'],
          mustFix: [],
          readyForSynthesis: true,
        },
        finalResponse: 'Durable memory has been added.',
      },
      { fetchImpl },
    );

    expect(result).toEqual({
      status: 'persisted',
      projectId: 'project-456',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const insertRequest = fetchImpl.mock.calls[1][1];
    const insertBody = JSON.parse(String(insertRequest?.body)) as { query: string };
    expect(insertBody.query).toContain('insert into public.bolt_project_memory');
    expect(insertBody.query).toContain("Ship the user''s dashboard");
    expect(insertBody.query).toContain("'project-456'");
  });

  it('skips durable project memory when no Supabase project is selected', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const loadResult = await loadProjectMemory(
      {
        isConnected: true,
        hasSelectedProject: false,
        token: 'token-123',
      },
      { fetchImpl },
    );

    const persistResult = await persistProjectMemory(
      {
        connection: {
          isConnected: true,
          hasSelectedProject: false,
          token: 'token-123',
        },
        userRequest: 'Test request',
        architect: {
          plan: 'Plan',
          goals: ['Goal'],
          constraints: [],
          responseStyle: 'Direct',
        },
        builder: {
          implementationOutline: ['Step'],
          responseStrategy: 'Strategy',
          artifacts: [],
          unresolvedQuestions: [],
        },
        critic: {
          reviewSummary: 'Review',
          findings: [],
          mustFix: [],
          readyForSynthesis: true,
        },
        finalResponse: 'Final response',
      },
      { fetchImpl },
    );

    expect(loadResult).toEqual({
      status: 'unavailable',
      entries: [],
      reason: 'A selected Supabase project is required for durable project memory.',
    });
    expect(persistResult).toEqual({
      status: 'skipped',
      reason: 'A selected Supabase project is required for durable project memory.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
