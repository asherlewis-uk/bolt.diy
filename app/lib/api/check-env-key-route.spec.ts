import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loader } from '~/routes/api.check-env-key';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { LLMManager } from '~/lib/modules/llm/manager';

vi.mock('~/lib/modules/llm/manager', () => ({
  LLMManager: {
    getInstance: vi.fn(),
  },
}));

vi.mock('~/lib/api/cookies', () => ({
  getApiKeysFromCookie: vi.fn(),
}));

describe('api.check-env-key loader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getApiKeysFromCookie).mockReturnValue({});
  });

  it('returns false when no provider is requested', async () => {
    const response = await loader({
      request: new Request('http://localhost/api/check-env-key'),
      context: {},
      params: {},
    } as any);

    await expect(response.json()).resolves.toEqual({ isSet: false });
    expect(LLMManager.getInstance).not.toHaveBeenCalled();
  });

  it('uses the merged server env when checking provider configuration', async () => {
    vi.mocked(LLMManager.getInstance).mockReturnValue({
      getProvider: vi.fn().mockReturnValue({
        config: {
          apiTokenKey: 'OPENAI_API_KEY',
        },
      }),
      env: {},
    } as any);

    const response = await loader({
      request: new Request('http://localhost/api/check-env-key?provider=OpenAI'),
      context: {
        cloudflare: {
          env: {
            OPENAI_API_KEY: 'server-key',
          },
        },
      },
      params: {},
    } as any);

    await expect(response.json()).resolves.toEqual({ isSet: true });
    expect(LLMManager.getInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENAI_API_KEY: 'server-key',
      }),
    );
  });
});
