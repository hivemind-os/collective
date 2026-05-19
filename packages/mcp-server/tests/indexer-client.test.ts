import { describe, expect, it } from 'vitest';

import { resolveIndexerUrl } from '../src/tools/indexer-client.js';

describe('resolveIndexerUrl', () => {
  it('accepts valid https URLs', () => {
    expect(resolveIndexerUrl({ indexer: { graphqlUrl: 'https://indexer.example/graphql' } } as never)).toBe(
      'https://indexer.example/graphql',
    );
  });

  it('accepts localhost http URLs for local development', () => {
    expect(resolveIndexerUrl({ indexer: { graphqlUrl: 'http://localhost:4000/graphql' } } as never)).toBe(
      'http://localhost:4000/graphql',
    );
    expect(resolveIndexerUrl({ indexer: { graphqlUrl: 'http://127.0.0.1:4000/graphql' } } as never)).toBe(
      'http://127.0.0.1:4000/graphql',
    );
  });

  it.each(['ftp://example.com/graphql', 'file:///etc/passwd'])('returns null for unsafe scheme %s', (graphqlUrl) => {
    expect(resolveIndexerUrl({ indexer: { graphqlUrl } } as never)).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(resolveIndexerUrl({ indexer: { graphqlUrl: 'not a url' } } as never)).toBeNull();
  });
});
