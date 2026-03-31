declare module 'react-dom/server.browser' {
  import type { ReactNode } from 'react';

  export * from 'react-dom/server';

  export function renderToReadableStream(
    children: ReactNode,
    options?: {
      signal?: AbortSignal;
      onError?: (error: unknown) => void;
    },
  ): Promise<ReadableStream<Uint8Array> & { allReady: Promise<void> }>;
}
