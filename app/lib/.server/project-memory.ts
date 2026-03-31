import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('project-memory');

const PROJECT_MEMORY_TABLE = 'public.bolt_project_memory';
const PROJECT_MEMORY_FETCH_LIMIT = 5;

const PROJECT_MEMORY_BOOTSTRAP_QUERY = [
  `create table if not exists ${PROJECT_MEMORY_TABLE} (`,
  '  id bigserial primary key,',
  '  project_ref text not null,',
  '  chat_id text,',
  '  user_request text not null,',
  "  memory_summary text not null,",
  "  stage_snapshot jsonb not null default '{}'::jsonb,",
  "  created_at timestamptz not null default timezone('utc', now())",
  ');',
  `create index if not exists bolt_project_memory_project_ref_created_at_idx on ${PROJECT_MEMORY_TABLE} (project_ref, created_at desc);`,
].join('\n');

export interface ProjectMemoryConnection {
  isConnected?: boolean;
  hasSelectedProject?: boolean;
  token?: string;
  selectedProjectId?: string;
}

export interface ProjectMemoryEntry {
  id: string;
  projectRef: string;
  chatId?: string;
  userRequest: string;
  memorySummary: string;
  stageSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface PersistProjectMemoryInput {
  connection?: ProjectMemoryConnection;
  userRequest: string;
  chatId?: string;
  architect: {
    plan: string;
    goals: string[];
    constraints: string[];
    responseStyle: string;
  };
  builder: {
    implementationOutline: string[];
    responseStrategy: string;
    artifacts: string[];
    unresolvedQuestions: string[];
  };
  critic: {
    reviewSummary: string;
    findings: string[];
    mustFix: string[];
    readyForSynthesis: boolean;
  };
  finalResponse: string;
}

export interface LoadProjectMemoryResult {
  status: 'available' | 'unavailable' | 'failed';
  entries: ProjectMemoryEntry[];
  reason?: string;
  projectId?: string;
}

export interface PersistProjectMemoryResult {
  status: 'persisted' | 'skipped' | 'failed';
  reason?: string;
  projectId?: string;
}

export interface ProjectMemoryDependencies {
  fetchImpl?: typeof fetch;
}

export async function loadProjectMemory(
  connection?: ProjectMemoryConnection,
  deps?: ProjectMemoryDependencies,
): Promise<LoadProjectMemoryResult> {
  const resolvedConnection = resolveProjectMemoryConnection(connection);

  if (!resolvedConnection.ok) {
    return {
      status: 'unavailable',
      entries: [],
      reason: resolvedConnection.reason,
    };
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;

  try {
    await ensureProjectMemoryTable({
      connection: resolvedConnection.connection,
      fetchImpl,
    });

    const query = [
      'select id, project_ref, chat_id, user_request, memory_summary, stage_snapshot, created_at',
      `from ${PROJECT_MEMORY_TABLE}`,
      `where project_ref = '${escapeSqlLiteral(resolvedConnection.connection.selectedProjectId)}'`,
      'order by created_at desc',
      `limit ${PROJECT_MEMORY_FETCH_LIMIT};`,
    ].join('\n');

    const payload = await executeProjectQuery({
      connection: resolvedConnection.connection,
      query,
      fetchImpl,
    });

    return {
      status: 'available',
      entries: normalizeProjectMemoryEntries(payload),
      projectId: resolvedConnection.connection.selectedProjectId,
    };
  } catch (error) {
    const reason = getErrorMessage(error);
    logger.error('Failed to load project memory', error);

    return {
      status: 'failed',
      entries: [],
      reason,
      projectId: resolvedConnection.connection.selectedProjectId,
    };
  }
}

export async function persistProjectMemory(
  input: PersistProjectMemoryInput,
  deps?: ProjectMemoryDependencies,
): Promise<PersistProjectMemoryResult> {
  const resolvedConnection = resolveProjectMemoryConnection(input.connection);

  if (!resolvedConnection.ok) {
    return {
      status: 'skipped',
      reason: resolvedConnection.reason,
    };
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;

  try {
    await ensureProjectMemoryTable({
      connection: resolvedConnection.connection,
      fetchImpl,
    });

    const record = buildProjectMemoryRecord(input);
    const query = [
      `insert into ${PROJECT_MEMORY_TABLE} (`,
      '  project_ref,',
      '  chat_id,',
      '  user_request,',
      '  memory_summary,',
      '  stage_snapshot',
      ') values (',
      `  '${escapeSqlLiteral(record.projectRef)}',`,
      record.chatId ? `  '${escapeSqlLiteral(record.chatId)}',` : '  null,',
      `  '${escapeSqlLiteral(record.userRequest)}',`,
      `  '${escapeSqlLiteral(record.memorySummary)}',`,
      `  '${escapeSqlLiteral(JSON.stringify(record.stageSnapshot))}'::jsonb`,
      ');',
    ].join('\n');

    await executeProjectQuery({
      connection: resolvedConnection.connection,
      query,
      fetchImpl,
    });

    return {
      status: 'persisted',
      projectId: resolvedConnection.connection.selectedProjectId,
    };
  } catch (error) {
    const reason = getErrorMessage(error);
    logger.error('Failed to persist project memory', error);

    return {
      status: 'failed',
      reason,
      projectId: resolvedConnection.connection.selectedProjectId,
    };
  }
}

interface ResolvedProjectMemoryConnection {
  ok: true;
  connection: Required<Pick<ProjectMemoryConnection, 'selectedProjectId' | 'token'>>;
}

interface RejectedProjectMemoryConnection {
  ok: false;
  reason: string;
}

function resolveProjectMemoryConnection(
  connection?: ProjectMemoryConnection,
): ResolvedProjectMemoryConnection | RejectedProjectMemoryConnection {
  if (!connection?.isConnected || !connection.token) {
    return {
      ok: false,
      reason: 'Supabase connection is required for durable project memory.',
    };
  }

  if (!connection.hasSelectedProject || !connection.selectedProjectId) {
    return {
      ok: false,
      reason: 'A selected Supabase project is required for durable project memory.',
    };
  }

  return {
    ok: true,
    connection: {
      selectedProjectId: connection.selectedProjectId,
      token: connection.token,
    },
  };
}

async function ensureProjectMemoryTable({
  connection,
  fetchImpl,
}: {
  connection: Required<Pick<ProjectMemoryConnection, 'selectedProjectId' | 'token'>>;
  fetchImpl: typeof fetch;
}) {
  await executeProjectQuery({
    connection,
    query: PROJECT_MEMORY_BOOTSTRAP_QUERY,
    fetchImpl,
  });
}

async function executeProjectQuery({
  connection,
  query,
  fetchImpl,
}: {
  connection: Required<Pick<ProjectMemoryConnection, 'selectedProjectId' | 'token'>>;
  query: string;
  fetchImpl: typeof fetch;
}) {
  const response = await fetchImpl(`https://api.supabase.com/v1/projects/${connection.selectedProjectId}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: formatSupabaseAuthorizationHeader(connection.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`Supabase project memory query failed (${response.status}): ${errorText}`);
  }

  const responseText = await response.text();

  if (responseText.trim().length === 0) {
    return [];
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
}

function normalizeProjectMemoryEntries(payload: unknown): ProjectMemoryEntry[] {
  return extractQueryRows(payload).map((row) => ({
    id: String(row.id ?? ''),
    projectRef: String(row.project_ref ?? ''),
    chatId: asOptionalString(row.chat_id),
    userRequest: asOptionalString(row.user_request) || '',
    memorySummary: asOptionalString(row.memory_summary) || '',
    stageSnapshot: parseStageSnapshot(row.stage_snapshot),
    createdAt: asOptionalString(row.created_at) || '',
  }));
}

function extractQueryRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const directKeys = ['result', 'results', 'rows', 'data'];

  for (const key of directKeys) {
    const value = payload[key];

    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }

    if (isRecord(value)) {
      const nested = extractQueryRows(value);

      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

function parseStageSnapshot(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildProjectMemoryRecord(input: PersistProjectMemoryInput) {
  const projectRef = input.connection?.selectedProjectId || '';
  const memorySummary = buildProjectMemorySummary(input);

  return {
    projectRef,
    chatId: input.chatId,
    userRequest: truncateForStorage(input.userRequest, 2000),
    memorySummary,
    stageSnapshot: {
      architectPlan: truncateForStorage(input.architect.plan, 2000),
      goals: input.architect.goals,
      constraints: input.architect.constraints,
      responseStyle: truncateForStorage(input.architect.responseStyle, 500),
      implementationOutline: input.builder.implementationOutline,
      responseStrategy: truncateForStorage(input.builder.responseStrategy, 1000),
      artifacts: input.builder.artifacts,
      unresolvedQuestions: input.builder.unresolvedQuestions,
      reviewSummary: truncateForStorage(input.critic.reviewSummary, 1000),
      findings: input.critic.findings,
      mustFix: input.critic.mustFix,
      readyForSynthesis: input.critic.readyForSynthesis,
      finalResponseExcerpt: truncateForStorage(input.finalResponse, 2000),
    },
  };
}

function buildProjectMemorySummary(input: PersistProjectMemoryInput) {
  const summaryLines = [
    `Request: ${truncateForStorage(input.userRequest, 320)}`,
    `Plan: ${truncateForStorage(input.architect.plan, 320)}`,
    `Strategy: ${truncateForStorage(input.builder.responseStrategy, 320)}`,
    `Review: ${truncateForStorage(input.critic.reviewSummary, 240)}`,
  ];

  if (input.builder.artifacts.length > 0) {
    summaryLines.push(`Artifacts: ${truncateForStorage(input.builder.artifacts.join(', '), 320)}`);
  }

  return summaryLines.join('\n');
}

function truncateForStorage(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatSupabaseAuthorizationHeader(token: string) {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

function escapeSqlLiteral(value: string) {
  return value.replace(/\u0000/g, '').replace(/'/g, "''");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown) {
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown project memory error';
}
