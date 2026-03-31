import { useState, useEffect } from 'react';
import { openDatabase } from '~/lib/persistence/db';
import { getStorageSurfaceDefinition } from '~/lib/persistence/storage-policy';

const localChatCacheSurface = getStorageSurfaceDefinition('browserIndexedDbChatCache');

/**
 * Hook to initialize and provide access to the browser chat cache database.
 */
export function useIndexedDB() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const initDB = async () => {
      try {
        setIsLoading(true);

        const database = await openDatabase();

        if (!database) {
          setError(new Error(`${localChatCacheSurface.label} is unavailable`));
          setIsLoading(false);
          return;
        }

        setDb(database);
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error initializing database'));
        setIsLoading(false);
      }
    };

    initDB();

    return () => {
      if (db) {
        db.close();
      }
    };
  }, []);

  return { db, isLoading, error };
}
