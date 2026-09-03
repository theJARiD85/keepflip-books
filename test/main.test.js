import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHandler,
  inventorySaleState,
  isSyncEligibleEbayConnection,
} from '../src/main.js';

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

test('overview sends Appwrite TablesDB JSON query objects', async () => {
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
        assert.deepEqual(requestUrl.searchParams.getAll('queries[]').map(JSON.parse), [
          { attribute: 'ownerId', method: 'equal', values: ['user-1'] },
          { attribute: 'occurredAt', method: 'orderDesc' },
          { method: 'limit', values: [1000] },
        ]);
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

test('maps an Appwrite overview failure to an upstream 502 instead of a generic 500', async () => {
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
    const logs = [];
    const handler = createHandler({
      fetchImpl: async (url) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        return jsonResponse({ message: 'Invalid query.' }, 400);
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
      log: (message) => logs.push(message),
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

    assert.equal(result.status, 502);
    assert.deepEqual(result.body, {
      error: 'KeepFlip could not update Books. Please try again.',
      ok: false,
    });
    assert.deepEqual(logs, [
      'KeepFlip Books POST /overview failed with status 502. reason=APPWRITE_400',
    ]);
  } finally {
    restoreEnvironment(previous);
  }
});

test('a partial lot sale carries only its share of cost and the last unit gets the remainder', () => {
  const firstSale = inventorySaleState(
    { acquisitionCostCents: 1_001, quantityOnHand: 3 },
    1,
  );
  const secondSale = inventorySaleState(
    {
      inventoryCostCentsOnHand: firstSale.inventoryCostCentsOnHand,
      quantityOnHand: firstSale.quantityOnHand,
    },
    1,
  );
  const finalSale = inventorySaleState(
    {
      inventoryCostCentsOnHand: secondSale.inventoryCostCentsOnHand,
      quantityOnHand: secondSale.quantityOnHand,
    },
    1,
  );

  assert.deepEqual(firstSale, {
    costCents: 333,
    inventoryCostCentsOnHand: 668,
    quantityBefore: 3,
    quantityOnHand: 2,
  });
  assert.deepEqual(secondSale, {
    costCents: 334,
    inventoryCostCentsOnHand: 334,
    quantityBefore: 2,
    quantityOnHand: 1,
  });
  assert.deepEqual(finalSale, {
    costCents: 334,
    inventoryCostCentsOnHand: 0,
    quantityBefore: 1,
    quantityOnHand: 0,
  });
  assert.equal(
    firstSale.costCents + secondSale.costCents + finalSale.costCents,
    1_001,
  );
});


test('configured Books entrypoint serves the focused review detail route', async () => {
  const environmentNames = [
    'APPWRITE_BOOKS_DATABASE_ID',
    'APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID',
  ];
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    APPWRITE_BOOKS_DATABASE_ID: 'keepflip',
    APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID: 'book_source_events',
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://appwrite.example/v1',
    APPWRITE_FUNCTION_PROJECT_ID: 'keepflip',
  });

  try {
    const handler = createHandler({
      fetchImpl: async (url) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        if (
          requestUrl.pathname ===
          '/v1/tablesdb/keepflip/tables/book_source_events/rows/review-1'
        ) {
          return jsonResponse({
            $id: 'review-1',
            amountCents: 1919,
            bookingEntry: 'CREDIT',
            currency: 'GBP',
            eventStatus: 'needs_review',
            externalKey: 'ebay-transaction-1',
            itemId: null,
            occurredAt: '2026-08-22T12:00:00.000Z',
            orderId: null,
            ownerId: 'user-1',
            payoutId: null,
            rawAmountValue: '19.19',
            rawCurrency: 'GBP',
            rawTransactionType: 'CREDIT',
            reviewReason: 'Confirm this marketplace credit.',
            reviewUpdatedAt: '2026-09-03T20:00:00.000Z',
            source: 'ebay_finances',
            sourceType: 'marketplace_credit_foreign_currency',
            transactionMemo: 'Marketplace credit',
          });
        }
        return jsonResponse({ message: 'Not found.' }, 404);
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
        bodyJson: { reviewId: 'review-1' },
        headers: {
          'x-appwrite-key': 'function-key',
          'x-appwrite-user-jwt': 'user-jwt',
        },
        method: 'POST',
        path: '/review/detail',
      },
      res,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body?.ok, true);
    assert.equal(result.body?.item?.id, 'review-1');
    assert.equal(result.body?.item?.rawTransactionType, 'CREDIT');
    assert.equal(result.body?.item?.amountCents, 1919);
    assert.equal(result.body?.item?.currency, 'GBP');
    assert.equal(result.body?.item?.reason, 'Confirm this marketplace credit.');
  } finally {
    restoreEnvironment(previous);
  }
});


test('review confirm falls back safely when eventStatus rejects review_confirmed', async () => {
  const environmentNames = [
    'APPWRITE_BOOKS_DATABASE_ID',
    'APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID',
  ];
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    APPWRITE_BOOKS_DATABASE_ID: 'keepflip',
    APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID: 'book_source_events',
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://appwrite.example/v1',
    APPWRITE_FUNCTION_PROJECT_ID: 'keepflip',
  });

  try {
    const patches = [];
    const handler = createHandler({
      fetchImpl: async (url, init = {}) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        if (
          requestUrl.pathname ===
          '/v1/tablesdb/keepflip/tables/book_source_events/rows/review-1'
        ) {
          if ((init.method || 'GET') === 'PATCH') {
            const body = JSON.parse(init.body || '{}');
            patches.push(body.data);
            if (body.data?.eventStatus === 'review_confirmed') {
              return jsonResponse(
                { message: 'eventStatus contains an invalid enum value.' },
                400,
              );
            }
            return jsonResponse({ $id: 'review-1', ...body.data });
          }
          return jsonResponse({
            $id: 'review-1',
            amountCents: 1919,
            currency: 'GBP',
            eventStatus: 'needs_review',
            externalKey: 'ebay-transaction-1',
            occurredAt: '2026-08-22T12:00:00.000Z',
            ownerId: 'user-1',
            reviewReason: 'Confirm this marketplace credit.',
            source: 'ebay_finances',
            sourceType: 'marketplace_credit_foreign_currency',
          });
        }
        return jsonResponse({ message: 'Not found.' }, 404);
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
        bodyJson: {
          amountCents: 1919,
          currency: 'GBP',
          reviewId: 'review-1',
          transactionMemo: null,
        },
        headers: {
          'x-appwrite-key': 'function-key',
          'x-appwrite-user-jwt': 'user-jwt',
        },
        method: 'POST',
        path: '/review/confirm',
      },
      res,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      alreadyConfirmed: false,
      amountCents: 1919,
      currency: 'GBP',
      ok: true,
      status: 'review_confirmed',
    });
    assert.equal(patches.length, 2);
    assert.equal(patches[0].eventStatus, 'review_confirmed');
    assert.equal(patches[1].eventStatus, 'needs_review');
    assert.match(
      patches[1].reviewReason,
      /^\[KEEPFLIP_REVIEW_CONFIRMED\]/,
    );
  } finally {
    restoreEnvironment(previous);
  }
});
