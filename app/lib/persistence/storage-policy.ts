export const LOCAL_CHAT_CACHE_DATABASE_NAME = 'boltHistory';
export const LOCAL_CHAT_CACHE_DATABASE_VERSION = 2;

export const LOCAL_CHAT_CACHE_STORES = {
  chats: 'chats',
  snapshots: 'snapshots',
} as const;

export type StorageSurfaceId =
  | 'supabaseManagedPostgres'
  | 'browserIndexedDbChatCache'
  | 'browserLocalStorageSettings'
  | 'browserCookieBridge'
  | 'electronDesktopLocalState';

export type StorageSurfaceRole =
  | 'durable-authority'
  | 'local-cache'
  | 'local-settings'
  | 'browser-server-bridge'
  | 'desktop-local-state';

export interface StorageSurfaceDefinition {
  id: StorageSurfaceId;
  label: string;
  role: StorageSurfaceRole;
  durable: boolean;
  description: string;
}

export const STORAGE_SURFACE_MANIFEST: Record<StorageSurfaceId, StorageSurfaceDefinition> = {
  supabaseManagedPostgres: {
    id: 'supabaseManagedPostgres',
    label: 'Supabase-managed Postgres',
    role: 'durable-authority',
    durable: true,
    description: 'Approved durable storage boundary for production memory and retrieval.',
  },
  browserIndexedDbChatCache: {
    id: 'browserIndexedDbChatCache',
    label: 'Browser IndexedDB chat cache',
    role: 'local-cache',
    durable: false,
    description: 'Local browser cache for chat history and snapshots only.',
  },
  browserLocalStorageSettings: {
    id: 'browserLocalStorageSettings',
    label: 'Browser localStorage settings',
    role: 'local-settings',
    durable: false,
    description: 'Local browser settings and connection convenience state.',
  },
  browserCookieBridge: {
    id: 'browserCookieBridge',
    label: 'Browser cookies',
    role: 'browser-server-bridge',
    durable: false,
    description: 'Request-scoped settings and secrets that must cross the browser/server boundary.',
  },
  electronDesktopLocalState: {
    id: 'electronDesktopLocalState',
    label: 'Electron desktop local state',
    role: 'desktop-local-state',
    durable: false,
    description: 'Desktop-local convenience state for the Electron runtime.',
  },
};

export const APPROVED_DURABLE_STORAGE_SURFACE_ID: StorageSurfaceId = 'supabaseManagedPostgres';

export function getApprovedDurableStorageSurface(): StorageSurfaceDefinition {
  return STORAGE_SURFACE_MANIFEST[APPROVED_DURABLE_STORAGE_SURFACE_ID];
}

export function getStorageSurfaceDefinition(id: StorageSurfaceId): StorageSurfaceDefinition {
  return STORAGE_SURFACE_MANIFEST[id];
}

export function isDurableStorageSurface(id: StorageSurfaceId): boolean {
  return STORAGE_SURFACE_MANIFEST[id].durable;
}
