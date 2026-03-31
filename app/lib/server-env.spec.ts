import { afterEach, describe, expect, it } from 'vitest';
import { getServerEnv } from './server-env';

const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

afterEach(() => {
  if (typeof ORIGINAL_OPENAI_API_KEY === 'string') {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  } else {
    delete process.env.OPENAI_API_KEY;
  }

  if (typeof ORIGINAL_GOOGLE_GENERATIVE_AI_API_KEY === 'string') {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = ORIGINAL_GOOGLE_GENERATIVE_AI_API_KEY;
  } else {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  }
});

describe('getServerEnv', () => {
  it('falls back to process.env when no Cloudflare context is present', () => {
    process.env.OPENAI_API_KEY = 'process-env-openai-key';

    const serverEnv = getServerEnv();

    expect(serverEnv.OPENAI_API_KEY).toBe('process-env-openai-key');
  });

  it('prefers Cloudflare env values over process.env values', () => {
    process.env.OPENAI_API_KEY = 'process-env-openai-key';

    const serverEnv = getServerEnv({
      cloudflare: {
        env: {
          OPENAI_API_KEY: 'cloudflare-openai-key',
          GOOGLE_GENERATIVE_AI_API_KEY: 'cloudflare-google-key',
        },
      },
    });

    expect(serverEnv.OPENAI_API_KEY).toBe('cloudflare-openai-key');
    expect(serverEnv.GOOGLE_GENERATIVE_AI_API_KEY).toBe('cloudflare-google-key');
  });
});
