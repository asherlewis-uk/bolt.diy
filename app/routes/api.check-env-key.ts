import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { LLMManager } from '~/lib/modules/llm/manager';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { getServerEnv } from '~/lib/server-env';

export const loader = async ({ context, request }: LoaderFunctionArgs) => {
  const serverEnv = getServerEnv(context);
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider');

  if (!provider) {
    return json({ isSet: false });
  }

  const llmManager = LLMManager.getInstance(serverEnv);
  const providerInstance = llmManager.getProvider(provider);

  if (!providerInstance || !providerInstance.config.apiTokenKey) {
    return json({ isSet: false });
  }

  const envVarName = providerInstance.config.apiTokenKey;

  // Get API keys from cookie
  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);

  /*
   * Check API key in order of precedence:
   * 1. Client-side API keys (from cookies)
   * 2. Server environment variables (from Cloudflare env)
   * 3. Process environment variables (from .env.local)
   * 4. LLMManager environment variables
   */
  const isSet = !!(
    apiKeys?.[provider] ||
    serverEnv[envVarName] ||
    llmManager.env[envVarName]
  );

  return json({ isSet });
};
