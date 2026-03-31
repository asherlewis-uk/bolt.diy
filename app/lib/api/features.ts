export interface Feature {
  id: string;
  name: string;
  description: string;
  viewed: boolean;
  releaseDate: string;
}

const RELEASE_FEATURES: ReadonlyArray<Feature> = Object.freeze([
  {
    id: 'orchestrated-chat-flow',
    name: 'Orchestrated Chat Flow',
    description: 'The main chat path now runs architect, builder, critic, and synthesis stages instead of a single prompt pass.',
    viewed: false,
    releaseDate: '2026-03-31',
  },
  {
    id: 'durable-project-memory',
    name: 'Durable Project Memory',
    description: 'Project-scoped memory is now loaded and persisted through the approved Supabase-backed runtime path.',
    viewed: false,
    releaseDate: '2026-03-31',
  },
  {
    id: 'artifact-aware-context',
    name: 'Artifact-Aware Context',
    description: 'Real file changes, selected files, and workbench artifacts now influence orchestration and context selection.',
    viewed: false,
    releaseDate: '2026-03-31',
  },
  {
    id: 'operator-modes-and-guarded-actions',
    name: 'Operator Modes And Guarded Actions',
    description: 'Explicit operator modes change orchestration behavior, and model-emitted commands are policy-gated before execution.',
    viewed: false,
    releaseDate: '2026-03-31',
  },
  {
    id: 'mobile-and-runtime-hardening',
    name: 'Mobile And Runtime Hardening',
    description: 'Mobile layout overflow is bounded, and the web production runtime now starts through the Node-compatible Remix path.',
    viewed: false,
    releaseDate: '2026-03-31',
  },
]);

export const getFeatureFlags = async (): Promise<Feature[]> => {
  return RELEASE_FEATURES.map((feature) => ({ ...feature }));
};

export const markFeatureViewed = async (featureId: string): Promise<void> => {
  const featureExists = RELEASE_FEATURES.some((feature) => feature.id === featureId);

  if (!featureExists) {
    throw new Error(`Unknown feature release note: ${featureId}`);
  }
};
