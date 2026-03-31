import type { Change } from 'diff';

export type CommandActionType = 'shell' | 'start' | 'build';
export type ActionType = 'file' | CommandActionType | 'supabase';

export interface CommandExecutionPolicy {
  verdict: 'allow' | 'reject';
  commandType: CommandActionType;
  command: string;
  normalizedCommand: string;
  matchedRule?: string;
  reason?: string;
}

export interface BaseAction {
  content: string;
  executionPolicy?: CommandExecutionPolicy;
}

export interface FileAction extends BaseAction {
  type: 'file';
  filePath: string;
}

export interface ShellAction extends BaseAction {
  type: 'shell';
}

export interface StartAction extends BaseAction {
  type: 'start';
}

export interface BuildAction extends BaseAction {
  type: 'build';
}

export interface SupabaseAction extends BaseAction {
  type: 'supabase';
  operation: 'migration' | 'query';
  filePath?: string;
  projectId?: string;
}

export type BoltAction = FileAction | ShellAction | StartAction | BuildAction | SupabaseAction;

export type BoltActionData = BoltAction | BaseAction;

export interface ActionAlert {
  type: string;
  title: string;
  description: string;
  content: string;
  source?: 'terminal' | 'preview' | 'policy';
}

export interface SupabaseAlert {
  type: string;
  title: string;
  description: string;
  content: string;
  source?: 'supabase';
}

export interface DeployAlert {
  type: 'success' | 'error' | 'info';
  title: string;
  description: string;
  content?: string;
  url?: string;
  stage?: 'building' | 'deploying' | 'complete';
  buildStatus?: 'pending' | 'running' | 'complete' | 'failed';
  deployStatus?: 'pending' | 'running' | 'complete' | 'failed';
  source?: 'vercel' | 'netlify' | 'github';
}

export interface FileHistory {
  originalContent: string;
  lastModified: number;
  changes: Change[];
  versions: {
    timestamp: number;
    content: string;
  }[];

  // Novo campo para rastrear a origem das mudanças
  changeSource?: 'user' | 'auto-save' | 'external';
}
