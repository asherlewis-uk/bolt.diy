export type OperatorMode = 'greenfield-build' | 'feature-add' | 'repair-existing' | 'refactor-existing';

export type OperatorModeContextPolicy = 'artifact-driven' | 'follow-setting' | 'require-repo-context';

export interface OperatorModeDefinition {
  id: OperatorMode;
  label: string;
  description: string;
  runtimeBehavior: string;
  contextPolicy: OperatorModeContextPolicy;
}

export const DEFAULT_OPERATOR_MODE: OperatorMode = 'feature-add';

export const OPERATOR_MODE_DEFINITIONS: Record<OperatorMode, OperatorModeDefinition> = {
  'greenfield-build': {
    id: 'greenfield-build',
    label: 'Greenfield Build',
    description: 'Plan and build a new feature or project shape without assuming the whole current repo is relevant.',
    runtimeBehavior: 'Only loads focused repo context when the current artifact state points at specific files.',
    contextPolicy: 'artifact-driven',
  },
  'feature-add': {
    id: 'feature-add',
    label: 'Feature Add',
    description: 'Extend the existing project with a new capability while preserving the current structure.',
    runtimeBehavior: 'Follows the normal context-optimization toggle for repo-context loading.',
    contextPolicy: 'follow-setting',
  },
  'repair-existing': {
    id: 'repair-existing',
    label: 'Repair Existing Project',
    description: 'Diagnose and fix a broken or incorrect behavior in the current project.',
    runtimeBehavior: 'Always loads repo context when project files exist, even if context optimization is disabled.',
    contextPolicy: 'require-repo-context',
  },
  'refactor-existing': {
    id: 'refactor-existing',
    label: 'Refactor Existing Project',
    description: 'Improve structure and maintainability while preserving behavior and interfaces.',
    runtimeBehavior: 'Always loads repo context when project files exist, even if context optimization is disabled.',
    contextPolicy: 'require-repo-context',
  },
};

export function listOperatorModes() {
  return Object.values(OPERATOR_MODE_DEFINITIONS);
}

export function isOperatorMode(value: unknown): value is OperatorMode {
  return typeof value === 'string' && value in OPERATOR_MODE_DEFINITIONS;
}

export function resolveOperatorMode(value?: string | null): OperatorMode {
  if (!value || !isOperatorMode(value)) {
    return DEFAULT_OPERATOR_MODE;
  }

  return value;
}

export function getOperatorModeDefinition(mode?: OperatorMode | null) {
  return OPERATOR_MODE_DEFINITIONS[resolveOperatorMode(mode)];
}
