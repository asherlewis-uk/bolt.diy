import { describe, expect, it } from 'vitest';
import { getFeatureFlags, markFeatureViewed } from './features';

describe('feature release notes', () => {
  it('returns grounded release notes instead of placeholder sample data', async () => {
    const features = await getFeatureFlags();

    expect(features.length).toBeGreaterThan(0);
    expect(features.map((feature) => feature.name)).not.toContain('Dark Mode');
    expect(features.map((feature) => feature.id)).toEqual([
      'orchestrated-chat-flow',
      'durable-project-memory',
      'artifact-aware-context',
      'operator-modes-and-guarded-actions',
      'mobile-and-runtime-hardening',
    ]);
  });

  it('rejects unknown release notes when the UI acknowledges them', async () => {
    await expect(markFeatureViewed('unknown-feature')).rejects.toThrow('Unknown feature release note');
    await expect(markFeatureViewed('orchestrated-chat-flow')).resolves.toBeUndefined();
  });
});
