import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler, isSyncEligibleEbayConnection } from '../src/main.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('legacy active eBay connection rows remain eligible for their deterministic environment row', () => {
  assert.equal(
    isSyncEligibleEbayConnection(
      { encryptedTokens: 'v1.placeholder', ownerId: 'user-1', revokedAt: null },
      'user-1',
      'production',
    ),
    true,
  );
  assert.equal(
    isSyncEligibleEbayConnection(
      { environment: 'sandbox', ownerId: 'user-1', revokedAt: null },
      'user-1',
      'production',
    ),
    false,
  );
  assert.equal(
    isSyncEligibleEbayConnection(
      { ownerId: 'user-1', revokedAt: '2026-08-30T00:00:00.000Z' },
      'user-1',
      'production',
    ),
    false,
  );
});

test('overview sends Appwrite Cloud-compatible JSON query objects', async () => {
  const environmentNames = [
    'APPWRITE_BOOKS_DATABASE_ID',
    'APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID',
  ];
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    APPWRITE_BOOKS_DATABASE_ID: 'keepflip',
    APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID: 'book_journal_lines',
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://appwrite.example/v1',
    APPWRITE_FUNCTION_PROJECT_ID: 'keepflip',
  });

  try {
    const calls = [];
    const handler = createHandler({
      fetchImpl: async (url, init) => {
        calls.push({ init, url });
        const requestUrl = new URL(url);

        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }

        assert.equal(
          requestUrl.pathname,
          '/v1/tablesdb/keepflip/tables/book_journal_lines/rows',
        );
        assert.deepEqual(
          requestUrl.searchParams
            .getAll('queries[]')
            .map((query) => JSON.parse(query)),
          [
            {
              attribute: 'ownerId',
              method: 'equal',
              values: ['user-1'],
            },
            { attribute: 'occurredAt', method: 'orderDesc' },
            { method: 'limit', values: [1000] },
          ],
        );
        return jsonResponse({ rows: [] });
      },
    });
    const result = { body: null, status: null };
    const res = {
      json(body, status = 200) {
        result.body = body;
        result.status = status;
        return body;
      },
    };

    await handler({
      req: {
        headers: {
          'x-appwrite-key': 'function-key',
          'x-appwrite-user-jwt': 'user-jwt',
        },
        method: 'POST',
        path: '/overview',
      },
      res,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      moneyEvents: [],
      ok: true,
      truncated: false,
    });
  } finally {
    restoreEnvironment(previous);
  }
});