import ignore from 'ignore';
import { IGNORE_PATTERNS, type FileMap } from '~/lib/.server/llm/constants';
import type {
  ArtifactContextAnnotation,
  ArtifactContextModificationInput,
  ArtifactContextRequestPayload,
  ArtifactContextWorkbenchArtifact,
} from '~/types/context';
import { WORK_DIR } from '~/utils/constants';

const ig = ignore().add(IGNORE_PATTERNS);

const MAX_PROJECT_FILES = 25;
const MAX_MODIFIED_FILES = 8;
const MAX_ARTIFACTS = 6;
const MAX_ARTIFACT_FILE_PATHS = 6;
const MAX_MODIFIED_CONTENT_CHARS = 3000;

export interface ResolvedArtifactContext {
  selectedFile?: string;
  projectFileCount: number;
  projectFiles: string[];
  modifiedFiles: ArtifactContextModificationInput[];
  artifacts: ArtifactContextWorkbenchArtifact[];
}

export function createArtifactContext({
  files,
  request,
}: {
  files?: FileMap;
  request?: ArtifactContextRequestPayload;
}): ResolvedArtifactContext {
  const projectFiles = collectProjectFiles(files);

  return {
    selectedFile: normalizeProjectPath(request?.selectedFile),
    projectFileCount: projectFiles.length,
    projectFiles: projectFiles.slice(0, MAX_PROJECT_FILES),
    modifiedFiles: normalizeModifiedFiles(request?.modifiedFiles),
    artifacts: normalizeArtifacts(request?.artifacts),
  };
}

export function hasArtifactContext(context: ResolvedArtifactContext) {
  return !!(
    context.selectedFile ||
    context.projectFileCount > 0 ||
    context.modifiedFiles.length > 0 ||
    context.artifacts.length > 0
  );
}

export function createArtifactContextAnnotation(context: ResolvedArtifactContext): ArtifactContextAnnotation {
  return {
    type: 'artifactContext',
    selectedFile: context.selectedFile,
    projectFileCount: context.projectFileCount,
    projectFiles: [...context.projectFiles],
    modifiedFiles: context.modifiedFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
    })),
    artifacts: context.artifacts.map((artifact) => ({
      ...artifact,
      filePaths: [...artifact.filePaths],
    })),
  };
}

export function formatArtifactContextForPrompt(context: ResolvedArtifactContext) {
  const sections = [
    [
      'PROJECT FILE INVENTORY',
      `Total files: ${context.projectFileCount}`,
      `Selected file: ${context.selectedFile || 'None'}`,
      context.projectFiles.length > 0
        ? `Visible files:\n${context.projectFiles.map((filePath) => `- ${filePath}`).join('\n')}`
        : 'Visible files:\n- None',
    ].join('\n'),
  ];

  if (context.modifiedFiles.length > 0) {
    sections.push(
      [
        'MODIFIED FILES',
        context.modifiedFiles
          .map((file) => {
            return [`- ${file.path} (${file.kind})`, file.content].join('\n');
          })
          .join('\n\n'),
      ].join('\n'),
    );
  } else {
    sections.push('MODIFIED FILES\nNo modified files were present for this turn.');
  }

  if (context.artifacts.length > 0) {
    sections.push(
      [
        'WORKBENCH ARTIFACTS',
        context.artifacts
          .map((artifact) => {
            const filePaths =
              artifact.filePaths.length > 0 ? `Files: ${artifact.filePaths.join(', ')}` : 'Files: none linked';

            return [
              `- ${artifact.title} [id=${artifact.id}${artifact.type ? `, type=${artifact.type}` : ''}]`,
              `Actions: ${artifact.actionCount}, Pending: ${artifact.pendingActionCount}`,
              filePaths,
            ].join('\n');
          })
          .join('\n\n'),
      ].join('\n'),
    );
  } else {
    sections.push('WORKBENCH ARTIFACTS\nNo prior workbench artifacts were active for this turn.');
  }

  return sections.join('\n\n');
}

export function getArtifactPriorityPaths(context: ResolvedArtifactContext) {
  const priorityPaths = new Set<string>();

  if (context.selectedFile) {
    priorityPaths.add(context.selectedFile);
  }

  for (const file of context.modifiedFiles) {
    priorityPaths.add(file.path);
  }

  for (const artifact of context.artifacts) {
    for (const filePath of artifact.filePaths) {
      priorityPaths.add(filePath);
    }
  }

  return [...priorityPaths];
}

function collectProjectFiles(files?: FileMap) {
  if (!files) {
    return [];
  }

  return Object.entries(files)
    .filter(([, dirent]) => dirent?.type === 'file')
    .map(([filePath]) => normalizeProjectPath(filePath))
    .filter((filePath): filePath is string => !!filePath)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeModifiedFiles(files?: ArtifactContextModificationInput[]) {
  if (!files?.length) {
    return [];
  }

  const normalized = new Map<string, ArtifactContextModificationInput>();

  for (const file of files) {
    const path = normalizeProjectPath(file.path);

    if (!path) {
      continue;
    }

    normalized.set(path, {
      path,
      kind: file.kind === 'file' ? 'file' : 'diff',
      content: truncateContent(file.content || ''),
    });
  }

  return [...normalized.values()].slice(0, MAX_MODIFIED_FILES);
}

function normalizeArtifacts(artifacts?: ArtifactContextWorkbenchArtifact[]) {
  if (!artifacts?.length) {
    return [];
  }

  return artifacts
    .map((artifact) => {
      const filePaths = [
        ...new Set((artifact.filePaths || []).map(normalizeProjectPath).filter((filePath): filePath is string => !!filePath)),
      ].sort((left, right) => left.localeCompare(right));

      return {
        id: artifact.id,
        title: artifact.title,
        type: artifact.type,
        actionCount: artifact.actionCount,
        pendingActionCount: artifact.pendingActionCount,
        filePaths: filePaths.slice(0, MAX_ARTIFACT_FILE_PATHS),
      };
    })
    .filter((artifact) => artifact.id && artifact.title)
    .slice(0, MAX_ARTIFACTS);
}

function normalizeProjectPath(filePath?: string) {
  if (!filePath) {
    return undefined;
  }

  let normalizedPath = filePath.trim().replace(/\\/g, '/');

  if (!normalizedPath) {
    return undefined;
  }

  if (normalizedPath.startsWith(WORK_DIR)) {
    normalizedPath = normalizedPath.slice(WORK_DIR.length);
  }

  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.slice(1);
  }

  if (!normalizedPath || ig.ignores(normalizedPath)) {
    return undefined;
  }

  return normalizedPath;
}

function truncateContent(content: string) {
  const trimmed = content.trim();

  if (trimmed.length <= MAX_MODIFIED_CONTENT_CHARS) {
    return trimmed;
  }

  return trimmed.slice(0, MAX_MODIFIED_CONTENT_CHARS);
}
