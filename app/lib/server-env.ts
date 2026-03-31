type ServerEnvValue = string | undefined;
type ServerEnvRecord = Record<string, string> & Env;

export interface ServerEnvContext {
  cloudflare?: {
    env?: Record<string, ServerEnvValue> | Env;
  };
}

export function getServerEnv(context?: ServerEnvContext): ServerEnvRecord {
  const mergedEntries = new Map<string, string>();

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      mergedEntries.set(key, value);
    }
  }

  for (const [key, value] of Object.entries((context?.cloudflare?.env ?? {}) as Record<string, ServerEnvValue>)) {
    if (typeof value === 'string') {
      mergedEntries.set(key, value);
    }
  }

  return Object.fromEntries(mergedEntries) as ServerEnvRecord;
}
