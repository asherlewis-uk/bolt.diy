import { describe, expect, it } from 'vitest';
import {
  APPROVED_DURABLE_STORAGE_SURFACE_ID,
  LOCAL_CHAT_CACHE_DATABASE_NAME,
  LOCAL_CHAT_CACHE_DATABASE_VERSION,
  LOCAL_CHAT_CACHE_STORES,
  STORAGE_SURFACE_MANIFEST,
  getApprovedDurableStorageSurface,
  getStorageSurfaceDefinition,
  isDurableStorageSurface,
} from './storage-policy';

describe('storage-policy', () => {
  it('approves Supabase as the single durable storage surface', () => {
    const durableSurfaces = Object.values(STORAGE_SURFACE_MANIFEST).filter((surface) => surface.durable);

    expect(APPROVED_DURABLE_STORAGE_SURFACE_ID).toBe('supabaseManagedPostgres');
    expect(durableSurfaces).toHaveLength(1);
    expect(getApprovedDurableStorageSurface()).toEqual(STORAGE_SURFACE_MANIFEST.supabaseManagedPostgres);
    expect(isDurableStorageSurface('supabaseManagedPostgres')).toBe(true);
  });

  it('keeps the browser chat database scoped to a local cache surface', () => {
    expect(LOCAL_CHAT_CACHE_DATABASE_NAME).toBe('boltHistory');
    expect(LOCAL_CHAT_CACHE_DATABASE_VERSION).toBe(2);
    expect(LOCAL_CHAT_CACHE_STORES).toEqual({
      chats: 'chats',
      snapshots: 'snapshots',
    });
    expect(getStorageSurfaceDefinition('browserIndexedDbChatCache').durable).toBe(false);
  });

  it('marks browser and desktop convenience surfaces as non-durable', () => {
    expect(getStorageSurfaceDefinition('browserLocalStorageSettings').role).toBe('local-settings');
    expect(getStorageSurfaceDefinition('browserCookieBridge').role).toBe('browser-server-bridge');
    expect(getStorageSurfaceDefinition('electronDesktopLocalState').role).toBe('desktop-local-state');
    expect(isDurableStorageSurface('browserLocalStorageSettings')).toBe(false);
    expect(isDurableStorageSurface('browserCookieBridge')).toBe(false);
    expect(isDurableStorageSurface('electronDesktopLocalState')).toBe(false);
  });
});
