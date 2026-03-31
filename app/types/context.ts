export interface ArtifactContextModification {
  path: string;
  kind: 'diff' | 'file';
}

export interface ArtifactContextModificationInput extends ArtifactContextModification {
  content: string;
}

export interface ArtifactContextWorkbenchArtifact {
  id: string;
  title: string;
  type?: string;
  actionCount: number;
  pendingActionCount: number;
  filePaths: string[];
}

export interface ArtifactContextRequestPayload {
  selectedFile?: string;
  modifiedFiles?: ArtifactContextModificationInput[];
  artifacts?: ArtifactContextWorkbenchArtifact[];
}

export interface ArtifactContextAnnotation {
  type: 'artifactContext';
  selectedFile?: string;
  projectFileCount: number;
  projectFiles: string[];
  modifiedFiles: ArtifactContextModification[];
  artifacts: ArtifactContextWorkbenchArtifact[];
}

export type ContextAnnotation =
  | {
      type: 'codeContext';
      files: string[];
    }
  | {
      type: 'chatSummary';
      summary: string;
      chatId: string;
    }
  | ArtifactContextAnnotation;

export type ProgressPhase = 'summary' | 'context' | 'memory' | 'architect' | 'builder' | 'critic' | 'synthesis' | 'loop';
export type ProgressGroup = 'context' | 'memory' | 'orchestrator';

export type ProgressAnnotation = {
  type: 'progress';
  label: string;
  status: 'in-progress' | 'complete' | 'failed';
  order: number;
  message: string;
  phase?: ProgressPhase;
  group?: ProgressGroup;
};
