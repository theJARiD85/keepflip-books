import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHandler,
  findInvalidTransactionReplacement,
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
      authorizeBooksCapability: async () => 'user-1',
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

test('invalid eBay placeholders resolve only to one independently matching corrected transaction', () => {
  const row = {
    amountCents: 1919,
    currency: 'USD',
    externalKey: 'invalid-transaction-aaaaaaaaaaaaaaaaaaaaaaaa',
    occurredAt: '2026-09-10T12:00:00.000Z',
    orderId: 'order-1',
    rawTransactionType: 'SALE',
    source: 'ebay_finances',
    sourceType: 'sale',
  };
  const corrected = {
    amount: { currency: 'USD', value: '19.19' },
    bookingEntry: 'CREDIT',
    orderId: 'order-1',
    totalFeeBasisAmount: { currency: 'USD', value: '19.19' },
    transactionDate: '2026-09-10T12:00:00.000Z',
    transactionId: 'txn-1',
    transactionType: 'SALE',
  };

  assert.equal(
    findInvalidTransactionReplacement(
      row,
      [corrected],
      '2026-09-10T18:30:00.000Z',
    ),
    corrected,
  );
  assert.equal(
    findInvalidTransactionReplacement(
      row,
      [corrected, { ...corrected, transactionId: 'txn-2' }],
      '2026-09-10T18:30:00.000Z',
    ),
    null,
  );
  assert.equal(
    findInvalidTransactionReplacement(
      { ...row, externalKey: 'real-transaction-id' },
      [corrected],
      '2026-09-10T18:30:00.000Z',
    ),
    null,
  );
});

test('review queue keeps legacy confirmed eBay imports available for linked posting', async () => {
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
      authorizeBooksCapability: async () => 'user-1',
      fetchImpl: async (url) => {
        const requestUrl = new URL(url);
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        assert.equal(
          requestUrl.pathname,
          '/v1/tablesdb/keepflip/tables/book_source_events/rows',
        );
        return jsonResponse({
          rows: [
            {
              $id: 'review-confirmed',
              amountCents: 2500,
              currency: 'USD',
              eventStatus: 'review_confirmed',
              externalKey: 'ebay-legacy-confirmed',
              occurredAt: '2026-09-10T12:00:00.000Z',
              ownerId: 'user-1',
              source: 'ebay_finances',
              sourceType: 'fee',
            },
            {
              $id: 'review-open',
              amountCents: 1200,
              currency: 'USD',
              eventStatus: 'needs_review',
              externalKey: 'ebay-open',
              occurredAt: '2026-09-09T12:00:00.000Z',
              ownerId: 'user-1',
              source: 'ebay_finances',
              sourceType: 'fee',
            },
            {
              $id: 'review-posted',
              amountCents: 500,
              currency: 'USD',
              eventStatus: 'posted',
              externalKey: 'ebay-posted',
              occurredAt: '2026-09-11T12:00:00.000Z',
              ownerId: 'user-1',
              source: 'ebay_finances',
              sourceType: 'fee',
            },
          ],
        });
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
        path: '/review/list',
      },
      res,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.items.map(({ id, status }) => ({ id, status })),
      [
        { id: 'review-confirmed', status: 'review_confirmed' },
        { id: 'review-open', status: 'needs_review' },
      ],
    );
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
      authorizeBooksCapability: async () => 'user-1',
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

test('Books checks the JWT-backed subscription before loading protected data', async () => {
  const environmentNames = [
    'APPWRITE_BOOKS_DATABASE_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID',
    'APPWRITE_USER_SUBSCRIPTIONS_TABLE_ID',
  ];
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    APPWRITE_BOOKS_DATABASE_ID: 'keepflip',
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://appwrite.example/v1',
    APPWRITE_FUNCTION_PROJECT_ID: 'keepflip',
    APPWRITE_USER_SUBSCRIPTIONS_TABLE_ID: 'user_subscriptions',
  });

  try {
    const calls = [];
    const handler = createHandler({
      now: () => '2026-09-09T12:00:00.000Z',
      fetchImpl: async (url) => {
        const requestUrl = new URL(url);
        calls.push(requestUrl.pathname);
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        if (
          requestUrl.pathname ===
          '/v1/tablesdb/keepflip/tables/user_subscriptions/rows/user-1'
        ) {
          return jsonResponse({
            $id: 'user-1',
            currentPeriodEndsAt: '2026-09-01T00:00:00.000Z',
            ownerId: 'user-1',
            plan: 'serious',
            status: 'cancelled',
          });
        }
        if (requestUrl.pathname.includes('/tables/trial_device_claims/rows/')) {
          return jsonResponse({ message: 'Not found.' }, 404);
        }
        throw new Error(`Unexpected protected Books request: ${requestUrl.pathname}`);
      },
    });
    const result = { body: null, status: null };
    await handler({
      req: {
        headers: {
          'x-appwrite-key': 'function-key',
          'x-appwrite-user-jwt': 'user-jwt',
        },
        method: 'POST',
        path: '/overview',
      },
      res: {
        json(body, status = 200) {
          result.body = body;
          result.status = status;
          return body;
        },
      },
    });

    assert.equal(result.status, 403);
    assert.deepEqual(result.body, {
      error: 'An active KeepFlip subscription with Books is required.',
      ok: false,
    });
    assert.equal(
      calls.some((path) => path.endsWith('/tables/book_journal_lines/rows')),
      false,
    );
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
      authorizeBooksCapability: async () => 'user-1',
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
      authorizeBooksCapability: async () => 'user-1',
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

test('review post creates one Books record tied to the imported eBay transaction ID', async () => {
  const environmentNames = [
    'APPWRITE_BOOKS_DATABASE_ID',
    'APPWRITE_BOOK_ACCOUNTS_TABLE_ID',
    'APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID',
    'APPWRITE_BOOK_TRANSACTIONS_TABLE_ID',
    'APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID',
  ];
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    APPWRITE_BOOKS_DATABASE_ID: 'keepflip',
    APPWRITE_BOOK_ACCOUNTS_TABLE_ID: 'book_accounts',
    APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID: 'book_source_events',
    APPWRITE_BOOK_TRANSACTIONS_TABLE_ID: 'book_transactions',
    APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID: 'book_journal_lines',
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://appwrite.example/v1',
    APPWRITE_FUNCTION_PROJECT_ID: 'keepflip',
  });

  try {
    let stagedOperations = [];
    const handler = createHandler({
      authorizeBooksCapability: async () => 'user-1',
      now: () => '2026-09-10T18:30:00.000Z',
      fetchImpl: async (url, init = {}) => {
        const requestUrl = new URL(url);
        const method = init.method || 'GET';
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        if (requestUrl.pathname.includes('/tables/book_source_events/rows/')) {
          return jsonResponse({
            $id: 'review-1',
            amountCents: 1919,
            bookingEntry: 'CREDIT',
            currency: 'USD',
            eventStatus: 'needs_review',
            externalKey: 'ebay-transaction-1',
            occurredAt: '2026-08-22T12:00:00.000Z',
            ownerId: 'user-1',
            rawTransactionType: 'CREDIT',
            source: 'ebay_finances',
            sourceType: 'credit_debit',
          });
        }
        if (requestUrl.pathname.includes('/tables/book_transactions/rows/')) {
          return jsonResponse({ message: 'Not found.' }, 404);
        }
        if (requestUrl.pathname.includes('/tables/book_accounts/rows/')) {
          return jsonResponse({ message: 'Not found.' }, 404);
        }
        if (
          requestUrl.pathname === '/v1/tablesdb/keepflip/tables/book_accounts/rows' &&
          method === 'POST'
        ) {
          return jsonResponse({ $id: 'account' }, 201);
        }
        if (requestUrl.pathname === '/v1/tablesdb/transactions' && method === 'POST') {
          return jsonResponse({ $id: 'transaction-1' }, 201);
        }
        if (
          requestUrl.pathname === '/v1/tablesdb/transactions/transaction-1/operations' &&
          method === 'POST'
        ) {
          stagedOperations = JSON.parse(init.body || '{}').operations || [];
          return jsonResponse({});
        }
        if (
          requestUrl.pathname === '/v1/tablesdb/transactions/transaction-1' &&
          method === 'PATCH'
        ) {
          return jsonResponse({});
        }
        throw new Error(`Unexpected review post request: ${method} ${requestUrl.pathname}`);
      },
    });

    const result = { body: null, status: null };
    await handler({
      req: {
        bodyJson: {
          amountCents: 1919,
          bookingEntry: 'DEBIT',
          currency: 'USD',
          eventType: 'marketplace_fee',
          // The client may send this field, but the review endpoint must ignore
          // it and use the stored source identity instead.
          externalKey: 'different-transaction-id',
          occurredAt: '2026-08-22T12:00:00.000Z',
          reviewId: 'review-1',
          transactionMemo: 'Corrected eBay charge',
          transactionType: 'NON_SALE_CHARGE',
        },
        headers: {
          'x-appwrite-key': 'function-key',
          'x-appwrite-user-jwt': 'user-jwt',
        },
        method: 'POST',
        path: '/review/post',
      },
      res: {
        json(body, status = 200) {
          result.body = body;
          result.status = status;
          return body;
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body?.ok, true);
    assert.equal(result.body?.status, 'posted');
    assert.ok(result.body?.bookTransactionId);

    const transactionOperation = stagedOperations.find(
      (operation) => operation.tableId === 'book_transactions',
    );
    const sourceOperation = stagedOperations.find(
      (operation) => operation.tableId === 'book_source_events',
    );
    const journalOperations = stagedOperations.filter(
      (operation) => operation.tableId === 'book_journal_lines',
    );

    assert.equal(transactionOperation?.data?.externalKey, 'ebay-transaction-1');
    assert.equal(transactionOperation?.data?.source, 'ebay_finances');
    assert.equal(sourceOperation?.data?.externalKey, 'ebay-transaction-1');
    assert.equal(sourceOperation?.data?.eventStatus, 'posted');
    assert.equal(sourceOperation?.data?.rawTransactionType, 'NON_SALE_CHARGE');
    assert.equal(sourceOperation?.data?.bookingEntry, 'DEBIT');
    assert.equal(journalOperations.length, 2);
    assert.ok(
      journalOperations.every(
        (operation) => operation.data?.externalKey === 'ebay-transaction-1',
      ),
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('correcting a synthetic eBay review replaces the placeholder source row', async () => {
  const environmentNames = [
    'APPWRITE_BOOKS_DATABASE_ID',
    'APPWRITE_BOOK_ACCOUNTS_TABLE_ID',
    'APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID',
    'APPWRITE_BOOK_TRANSACTIONS_TABLE_ID',
    'APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID',
  ];
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    APPWRITE_BOOKS_DATABASE_ID: 'keepflip',
    APPWRITE_BOOK_ACCOUNTS_TABLE_ID: 'book_accounts',
    APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID: 'book_source_events',
    APPWRITE_BOOK_TRANSACTIONS_TABLE_ID: 'book_transactions',
    APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID: 'book_journal_lines',
    APPWRITE_FUNCTION_API_ENDPOINT: 'https://appwrite.example/v1',
    APPWRITE_FUNCTION_PROJECT_ID: 'keepflip',
  });

  try {
    let stagedOperations = [];
    let deletedReviewRow = false;
    const handler = createHandler({
      authorizeBooksCapability: async () => 'user-1',
      now: () => '2026-09-10T18:30:00.000Z',
      fetchImpl: async (url, init = {}) => {
        const requestUrl = new URL(url);
        const method = init.method || 'GET';
        if (requestUrl.pathname === '/v1/account') {
          return jsonResponse({ $id: 'user-1' });
        }
        if (requestUrl.pathname.endsWith('/book_source_events/rows/review-invalid')) {
          if (method === 'DELETE') {
            deletedReviewRow = true;
            return jsonResponse({});
          }
          return jsonResponse({
            $id: 'review-invalid',
            amountCents: 1919,
            bookingEntry: 'CREDIT',
            currency: 'USD',
            eventStatus: 'needs_review',
            externalKey: 'invalid-transaction-aaaaaaaaaaaaaaaaaaaaaaaa',
            occurredAt: '2026-08-22T12:00:00.000Z',
            ownerId: 'user-1',
            rawTransactionType: 'SALE',
            source: 'ebay_finances',
            sourceType: 'sale',
          });
        }
        if (requestUrl.pathname.includes('/tables/book_source_events/rows/')) {
          return jsonResponse({ message: 'Not found.' }, 404);
        }
        if (requestUrl.pathname.includes('/tables/book_transactions/rows/')) {
          return jsonResponse({ message: 'Not found.' }, 404);
        }
        if (requestUrl.pathname.includes('/tables/book_accounts/rows/')) {
          return jsonResponse({ message: 'Not found.' }, 404);
        }
        if (
          requestUrl.pathname === '/v1/tablesdb/keepflip/tables/book_accounts/rows' &&
          method === 'POST'
        ) {
          return jsonResponse({ $id: 'account' }, 201);
        }
        if (requestUrl.pathname === '/v1/tablesdb/transactions' && method === 'POST') {
          return jsonResponse({ $id: 'transaction-corrected' }, 201);
        }
        if (
          requestUrl.pathname === '/v1/tablesdb/transactions/transaction-corrected/operations' &&
          method === 'POST'
        ) {
          stagedOperations = JSON.parse(init.body || '{}').operations || [];
          return jsonResponse({});
        }
        if (
          requestUrl.pathname === '/v1/tablesdb/transactions/transaction-corrected' &&
          method === 'PATCH'
        ) {
          return jsonResponse({});
        }
        throw new Error(`Unexpected synthetic review request: ${method} ${requestUrl.pathname}`);
      },
    });

    const result = { body: null, status: null };
    await handler({
      req: {
        bodyJson: {
          amountCents: 1919,
          bookingEntry: 'CREDIT',
          currency: 'USD',
          eventType: 'marketplace_credit',
          replacementExternalKey: 'txn-corrected',
          occurredAt: '2026-08-22T12:00:00.000Z',
          reviewId: 'review-invalid',
          transactionType: 'CREDIT',
        },
        headers: {
          'x-appwrite-key': 'function-key',
          'x-appwrite-user-jwt': 'user-jwt',
        },
        method: 'POST',
        path: '/review/post',
      },
      res: {
        json(body, status = 200) {
          result.body = body;
          result.status = status;
          return body;
        },
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body?.ok, true);
    assert.equal(result.body?.replacedInvalidReview, true);
    assert.equal(deletedReviewRow, true);
    const transactionOperation = stagedOperations.find(
      (operation) => operation.tableId === 'book_transactions',
    );
    assert.equal(transactionOperation?.data?.externalKey, 'txn-corrected');
  } finally {
    restoreEnvironment(previous);
  }
});
