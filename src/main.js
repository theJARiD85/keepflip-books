import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import {
  BOOK_ACCOUNT,
  BookkeepingValidationError,
  parseEbayFinanceTransaction,
  parseEbayPayout,
  postBookkeepingEvent,
} from './bookkeeping-domain.js';

const MAX_EBAY_SYNC_DAYS = 90;
const MAX_EBAY_SYNC_ROWS = 500;
const MAX_INVENTORY_QUANTITY = 100_000;
const EBAY_SCOPES = Object.freeze([
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
]);

const BOOK_ACCOUNT_SEEDS = Object.freeze([
  ['cash', 'Cash on hand', 'asset'],
  ['marketplaceClearing', 'Marketplace clearing', 'asset'],
  ['inventory', 'Inventory asset', 'asset'],
  ['salesTaxHeld', 'Marketplace tax pass-through', 'liability'],
  ['resaleRevenue', 'Resale revenue', 'income'],
  ['salesReturns', 'Refunds and returns', 'income'],
  ['costOfGoodsSold', 'Cost of goods sold', 'expense'],
  ['marketplaceFees', 'Marketplace fees', 'expense'],
  ['shippingLabels', 'Shipping expense', 'expense'],
  ['repairs', 'Repairs', 'expense'],
  ['supplies', 'Supplies', 'expense'],
  ['software', 'Software', 'expense'],
  ['advertising', 'Advertising', 'expense'],
  ['storage', 'Storage', 'expense'],
  ['mileage', 'Mileage', 'expense'],
  ['otherExpense', 'Other business expense', 'expense'],
  ['ebayCredits', 'Marketplace credits', 'income'],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function text(value, maximum = 8_000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maximum);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requestHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  if (typeof headers.get === 'function') return text(headers.get(name));
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) continue;
    return text(Array.isArray(value) ? value[0] : value);
  }
  return '';
}

function requestBody(req) {
  return record(req?.bodyJson);
}

function requestPath(req) {
  const raw = text(req?.path || req?.url || '/') || '/';
  return new URL(raw, 'https://keepflip.invalid').pathname;
}

function firstEnvironment(names, fallback = '') {
  for (const name of names) {
    const value = text(process.env[name]);
    if (value) return value;
  }
  return fallback;
}

function requiredEnvironment(names, message = 'Missing KeepFlip bookkeeping configuration.') {
  const value = firstEnvironment(names);
  if (!value) throw new Error(message);
  return value;
}

function runtimeConfiguration() {
  const endpoint = requiredEnvironment(['APPWRITE_FUNCTION_API_ENDPOINT']).replace(/\/+$/, '');
  const projectId = requiredEnvironment(['APPWRITE_FUNCTION_PROJECT_ID']);
  return { endpoint, projectId };
}

function dynamicApiKey(req) {
  const key =
    requestHeader(req?.headers, 'x-appwrite-key') ||
    text(process.env.APPWRITE_FUNCTION_API_KEY);
  if (!key) throw new Error('Appwrite did not provide this Function a dynamic API key.');
  return key;
}

function normalizeEnvironment(value) {
  const environment = text(value, 16).toLowerCase();
  if (environment === 'sandbox' || environment === 'production') return environment;
  throw new HttpError(400, 'eBay environment must be "sandbox" or "production".');
}

function tableConfiguration() {
  return {
    databaseId: firstEnvironment(['APPWRITE_BOOKS_DATABASE_ID', 'APPWRITE_DATABASE_ID'], 'keepflip'),
    accountsTableId: firstEnvironment(['APPWRITE_BOOK_ACCOUNTS_TABLE_ID'], 'book_accounts'),
    transactionsTableId: firstEnvironment(['APPWRITE_BOOK_TRANSACTIONS_TABLE_ID'], 'book_transactions'),
    journalLinesTableId: firstEnvironment(['APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID'], 'book_journal_lines'),
    sourceEventsTableId: firstEnvironment(['APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID'], 'book_source_events'),
    payoutsTableId: firstEnvironment(['APPWRITE_BOOK_PAYOUTS_TABLE_ID'], 'book_payouts'),
    itemsTableId: firstEnvironment(['APPWRITE_BOOK_ITEMS_TABLE_ID', 'APPWRITE_ITEMS_TABLE_ID'], 'items'),
    connectionsTableId: firstEnvironment([
      'APPWRITE_EBAY_CONNECTIONS_TABLE_ID',
      'APPWRITE_CONNECTIONS_TABLE_ID',
    ], 'ebay_connections'),
  };
}

function decodeEncryptionKey() {
  const encoded = requiredEnvironment(['EBAY_TOKEN_ENCRYPTION_KEY']);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('EBAY_TOKEN_ENCRYPTION_KEY must be a Base64 32-byte key.');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('EBAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  return key;
}

function ebayConfiguration(environment) {
  const normalized = normalizeEnvironment(environment);
  const prefix = normalized === 'production' ? 'EBAY_PRODUCTION' : 'EBAY_SANDBOX';
  return {
    ...tableConfiguration(),
    clientId: requiredEnvironment([`${prefix}_CLIENT_ID`]),
    clientSecret: requiredEnvironment([`${prefix}_CLIENT_SECRET`]),
    encryptionKey: decodeEncryptionKey(),
    environment: normalized,
    scopeText: EBAY_SCOPES.join(' '),
  };
}

function appwriteHeaders(runtime, { apiKey, jwt } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Appwrite-Project': runtime.projectId,
  };
  if (apiKey) headers['X-Appwrite-Key'] = apiKey;
  if (jwt) headers['X-Appwrite-JWT'] = jwt;
  return headers;
}

async function responseJson(response) {
  try {
    const payload = await response.text();
    return payload ? JSON.parse(payload) : {};
  } catch {
    return {};
  }
}

async function appwriteJson({
  runtime,
  path,
  method = 'GET',
  apiKey,
  jwt,
  body,
  failureMessage,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(runtime.endpoint + path, {
      method,
      headers: appwriteHeaders(runtime, { apiKey, jwt }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new UpstreamError(0, failureMessage);
  }
  const payload = await responseJson(response);
  if (!response.ok) throw new UpstreamError(response.status, failureMessage);
  return payload;
}

function tableRowsPath(configuration, tableId) {
  return `/tablesdb/${encodeURIComponent(configuration.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
}

function rowPath(configuration, tableId, rowId) {
  return `${tableRowsPath(configuration, tableId)}/${encodeURIComponent(rowId)}`;
}

function createQuery(method, attribute = '', values = []) {
  const query = { method: text(method, 64) };
  const queryAttribute = text(attribute, 512);

  if (queryAttribute) query.attribute = queryAttribute;
  if (Array.isArray(values) && values.length) {
    query.values = values;
  }

  return JSON.stringify(query);
}

function listRowsPath(configuration, tableId, queries) {
  const params = new URLSearchParams();
  for (const query of queries) params.append('queries[]', query);
  const suffix = params.toString();
  return `${tableRowsPath(configuration, tableId)}${suffix ? `?${suffix}` : ''}`;
}

async function authenticatedUserId({ req, runtime, fetchImpl }) {
  const jwt = requestHeader(req?.headers, 'x-appwrite-user-jwt');
  if (!jwt) throw new HttpError(401, 'Sign in before using Books.');
  let account;
  try {
    account = await appwriteJson({
      fetchImpl,
      failureMessage: 'KeepFlip could not verify your sign-in.',
      jwt,
      path: '/account',
      runtime,
    });
  } catch {
    throw new HttpError(401, 'Your sign-in could not be verified. Sign in and try again.');
  }
  const userId = text(account?.$id, 64);
  if (!userId) throw new HttpError(401, 'Your sign-in could not be verified. Sign in and try again.');
  return userId;
}

function stableId(namespace, ...parts) {
  return createHash('sha256')
    .update(['keepflip', namespace, 'v1', ...parts.map((part) => String(part ?? ''))].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 36);
}

function accountRowId(ownerId, accountCode) {
  return stableId('book-account', ownerId, accountCode);
}

function transactionRowId(ownerId, source, externalKey) {
  return stableId('book-transaction', ownerId, source, externalKey);
}

function sourceEventRowId(ownerId, source, externalKey) {
  return stableId('book-source-event', ownerId, source, externalKey);
}

function journalLineRowId(bookTransactionId, position) {
  return stableId('book-journal-line', bookTransactionId, position);
}

function payoutRowId(ownerId, payoutId) {
  return stableId('book-payout', ownerId, payoutId);
}

function connectionRowId(ownerId, environment) {
  return `e${createHash('sha256')
    .update(`${ownerId}:${environment}`, 'utf8')
    .digest('hex')
    .slice(0, 35)}`;
}

function dateValue(value, field = 'Date') {
  const date = new Date(text(value, 80));
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, `${field} must be a real date.`);
  return date.toISOString();
}

function integerCents(value, field = 'Amount') {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new HttpError(400, `${field} must be a positive whole number of cents.`);
  }
  return amount;
}

function optionalIntegerCents(value, field) {
  if (value == null || value === '') return undefined;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new HttpError(400, `${field} must be whole cents.`);
  }
  return amount;
}

function ownerIdFromRow(row) {
  return text(row?.ownerId, 64);
}

function storedInventoryQuantity(value, field, fallback = 1) {
  if (value == null || value === '') return fallback;
  const quantity = Number(value);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    quantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new HttpError(
      400,
      `${field} must be a whole number from 0 through ${MAX_INVENTORY_QUANTITY.toLocaleString()}.`,
    );
  }
  return quantity;
}

function saleQuantity(value) {
  if (value == null || value === '') return 1;
  const quantity = Number(value);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new HttpError(
      400,
      `Quantity sold must be a whole number from 1 through ${MAX_INVENTORY_QUANTITY.toLocaleString()}.`,
    );
  }
  return quantity;
}

/**
 * Apportions a saved lot's remaining cost in whole cents. Partial sales round
 * down; the final unit receives any remainder so total COGS always equals the
 * original cost of the lot exactly.
 */
export function inventorySaleState(item, requestedQuantity = 1) {
  const quantityBefore = storedInventoryQuantity(
    item?.quantityOnHand,
    'Stored item quantity',
  );
  if (quantityBefore < 1) {
    throw new HttpError(400, 'This inventory item has no units left to sell.');
  }

  const quantity = saleQuantity(requestedQuantity);
  if (quantity > quantityBefore) {
    throw new HttpError(
      400,
      `Only ${quantityBefore.toLocaleString()} unit${quantityBefore === 1 ? '' : 's'} remain for this item.`,
    );
  }

  const savedOnHandCost = optionalIntegerCents(
    item?.inventoryCostCentsOnHand,
    'Stored inventory cost',
  );
  const savedOriginalCost = optionalIntegerCents(
    item?.acquisitionCostCents,
    'Stored item cost',
  );
  const costBefore =
    savedOnHandCost === undefined ? savedOriginalCost : savedOnHandCost;
  const costCents =
    costBefore === undefined
      ? null
      : quantity === quantityBefore
        ? costBefore
        : Math.floor((costBefore * quantity) / quantityBefore);

  return {
    costCents,
    inventoryCostCentsOnHand:
      costBefore === undefined ? null : costBefore - (costCents ?? 0),
    quantityBefore,
    quantityOnHand: quantityBefore - quantity,
  };
}

function itemUpdateForSale({
  externalKey,
  occurredAt,
  orderId,
  ownerId,
  sale,
  source,
  now,
}) {
  const update = {
    bookSaleTransactionId: transactionRowId(ownerId, source, externalKey),
    inventoryCostCentsOnHand: sale.inventoryCostCentsOnHand,
    quantityOnHand: sale.quantityOnHand,
    updatedAt: now,
  };

  if (sale.quantityOnHand === 0) {
    return {
      ...update,
      resaleStatus: 'sold',
      soldAt: occurredAt,
      soldOrderId: orderId || null,
    };
  }

  return update;
}

async function getRowOrNull({ runtime, configuration, tableId, rowId, apiKey, fetchImpl }) {
  try {
    return await appwriteJson({
      apiKey,
      failureMessage: 'KeepFlip could not read the bookkeeping record.',
      fetchImpl,
      path: rowPath(configuration, tableId, rowId),
      runtime,
    });
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}

async function getOwnedItem({ runtime, configuration, apiKey, ownerId, itemId, fetchImpl }) {
  const row = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: text(itemId, 64),
    runtime,
    tableId: configuration.itemsTableId,
  });
  if (!row || ownerIdFromRow(row) !== ownerId) {
    throw new HttpError(404, 'That inventory item is unavailable.');
  }
  return row;
}

async function ensureBookAccounts({ runtime, configuration, apiKey, ownerId, now, fetchImpl }) {
  for (const [accountKey, displayName, accountType] of BOOK_ACCOUNT_SEEDS) {
    const accountCode = BOOK_ACCOUNT[accountKey];
    const rowId = accountRowId(ownerId, accountCode);
    const existing = await getRowOrNull({
      apiKey,
      configuration,
      fetchImpl,
      rowId,
      runtime,
      tableId: configuration.accountsTableId,
    });
    if (existing) continue;
    try {
      await appwriteJson({
        apiKey,
        body: {
          rowId,
          data: {
            accountCode,
            accountType,
            active: true,
            createdAt: now,
            displayName,
            ownerId,
          },
        },
        configuration,
        failureMessage: 'KeepFlip could not prepare your Books accounts.',
        fetchImpl,
        method: 'POST',
        path: tableRowsPath(configuration, configuration.accountsTableId),
        runtime,
      });
    } catch (error) {
      // A duplicate account from a concurrent request is safe to use.
      if (!(error instanceof UpstreamError) || error.status !== 409) throw error;
    }
  }
}

function digestForSource(event) {
  const safeSource = {
    amountCents: event.amountCents,
    currency: event.currency,
    eventType: event.eventType,
    externalKey: event.externalKey,
    itemId: event.itemId,
    occurredAt: event.occurredAt,
    orderId: event.orderId,
    payoutId: event.payoutId,
    source: event.source,
  };
  return createHash('sha256').update(JSON.stringify(safeSource), 'utf8').digest('hex');
}

function sourceEventData({ ownerId, source, externalKey, sourceType, eventStatus, occurredAt, amountCents, currency, itemId, orderId, payoutId, payloadDigest, now }) {
  return {
    amountCents,
    createdAt: now,
    currency,
    eventStatus,
    externalKey,
    itemId: itemId || null,
    occurredAt,
    orderId: orderId || null,
    ownerId,
    payloadDigest,
    payoutId: payoutId || null,
    source,
    sourceType,
  };
}

async function recordReviewEvent({ runtime, configuration, apiKey, ownerId, event, status, reason, fetchImpl, now }) {
  const rowId = sourceEventRowId(ownerId, event.source, event.externalKey);
  const data = sourceEventData({
    amountCents:
      Number.isSafeInteger(event.amountCents) && event.amountCents >= 0
        ? event.amountCents
        : 0,
    currency: event.currency || 'USD',
    eventStatus: status,
    event: undefined,
    externalKey: event.externalKey,
    itemId: event.itemId,
    now,
    occurredAt: event.occurredAt,
    orderId: event.orderId,
    ownerId,
    payloadDigest: digestForSource(event),
    payoutId: event.payoutId,
    source: event.source,
    sourceType: event.eventType || 'unknown',
  });
  // The limited reason is deliberately not stored as raw eBay text.
  data.eventStatus = status;
  data.sourceType = text(event.eventType || 'unknown', 60);
  void reason;

  const existing = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId,
    runtime,
    tableId: configuration.sourceEventsTableId,
  });
  if (existing) {
    await appwriteJson({
      apiKey,
      body: { data },
      failureMessage: 'KeepFlip could not update the eBay review item.',
      fetchImpl,
      method: 'PATCH',
      path: rowPath(configuration, configuration.sourceEventsTableId, rowId),
      runtime,
    });
    return { status: 'already_recorded' };
  }
  await appwriteJson({
    apiKey,
    body: { rowId, data },
    failureMessage: 'KeepFlip could not save the eBay review item.',
    fetchImpl,
    method: 'POST',
    path: tableRowsPath(configuration, configuration.sourceEventsTableId),
    runtime,
  });
  return { status };
}

export function sourceEventPersistenceOperation({
  configuration,
  existingSourceEvent,
  sourceData,
  sourceEventId,
}) {
  return {
    action: existingSourceEvent ? 'update' : 'create',
    data: {
      ...sourceData,
      createdAt: text(existingSourceEvent?.createdAt, 64) || sourceData.createdAt,
    },
    databaseId: configuration.databaseId,
    rowId: sourceEventId,
    tableId: configuration.sourceEventsTableId,
  };
}

async function persistEntry({
  runtime,
  configuration,
  apiKey,
  ownerId,
  entry,
  source,
  externalKey,
  itemUpdate,
  orderId,
  payoutId,
  payoutStatus,
  fetchImpl,
  now,
}) {
  const bookTransactionId = transactionRowId(ownerId, source, externalKey);
  const existing = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: bookTransactionId,
    runtime,
    tableId: configuration.transactionsTableId,
  });
  if (existing) return { bookTransactionId, status: 'already_recorded' };

  const sourceEventId = sourceEventRowId(ownerId, source, externalKey);
  // A prior sync may have safely held this event for review. If the seller
  // supplies the missing item link or cost later, promote that same source
  // record during the atomic posting instead of treating it as a duplicate.
  const existingSourceEvent = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: sourceEventId,
    runtime,
    tableId: configuration.sourceEventsTableId,
  });
  const sourceEventStatus = entry.needsCostReview ? 'needs_item_cost' : 'posted';
  const transactionData = {
    createdAt: now,
    currency: entry.currency,
    eventType: entry.eventType,
    externalKey,
    itemId: entry.itemId || null,
    memo: entry.notes || entry.summary || null,
    occurredAt: entry.occurredAt,
    orderId: orderId || null,
    ownerId,
    payoutId: payoutId || null,
    reversesTransactionId: null,
    source,
  };
  const sourceData = sourceEventData({
    amountCents: entry.amountCents,
    currency: entry.currency,
    eventStatus: sourceEventStatus,
    externalKey,
    itemId: entry.itemId,
    now,
    occurredAt: entry.occurredAt,
    orderId,
    ownerId,
    payloadDigest: digestForSource({
      amountCents: entry.amountCents,
      currency: entry.currency,
      eventType: entry.eventType,
      externalKey,
      itemId: entry.itemId,
      occurredAt: entry.occurredAt,
      orderId,
      payoutId,
      source,
    }),
    payoutId,
    source,
    sourceType: entry.eventType,
  });
  const operations = [
    {
      action: 'create',
      data: transactionData,
      databaseId: configuration.databaseId,
      rowId: bookTransactionId,
      tableId: configuration.transactionsTableId,
    },
    sourceEventPersistenceOperation({
      configuration,
      existingSourceEvent,
      sourceData,
      sourceEventId,
    }),
    ...entry.lines.map((line, index) => ({
      action: 'create',
      data: {
        accountCode: line.accountCode,
        amountCents: line.debitCents || line.creditCents,
        bookTransactionId,
        createdAt: now,
        currency: entry.currency,
        externalKey,
        itemId: entry.itemId || null,
        occurredAt: entry.occurredAt,
        orderId: orderId || null,
        ownerId,
        payoutId: payoutId || null,
        side: line.debitCents > 0 ? 'debit' : 'credit',
        source,
      },
      databaseId: configuration.databaseId,
      rowId: journalLineRowId(bookTransactionId, index),
      tableId: configuration.journalLinesTableId,
    })),
  ];

  if (itemUpdate && entry.itemId) {
    operations.push({
      action: 'update',
      data: itemUpdate,
      databaseId: configuration.databaseId,
      rowId: entry.itemId,
      tableId: configuration.itemsTableId,
    });
  }
  if (entry.eventType === 'payout' && payoutId) {
    operations.push({
      action: 'create',
      data: {
        amountCents: entry.amountCents,
        createdAt: now,
        currency: entry.currency,
        externalPayoutId: payoutId,
        ownerId,
        payoutDate: entry.occurredAt,
        reconciliationState: 'pending',
        status: payoutStatus || 'unknown',
        updatedAt: now,
      },
      databaseId: configuration.databaseId,
      rowId: payoutRowId(ownerId, payoutId),
      tableId: configuration.payoutsTableId,
    });
  }

  let transaction;
  try {
    transaction = await appwriteJson({
      apiKey,
      body: { ttl: 60 },
      failureMessage: 'KeepFlip could not begin the bookkeeping entry.',
      fetchImpl,
      method: 'POST',
      path: '/tablesdb/transactions',
      runtime,
    });
    const transactionId = text(transaction?.$id, 64);
    if (!transactionId) throw new Error('Appwrite transaction identity was missing.');

    await appwriteJson({
      apiKey,
      body: { operations },
      failureMessage: 'KeepFlip could not stage the bookkeeping entry.',
      fetchImpl,
      method: 'POST',
      path: `/tablesdb/transactions/${encodeURIComponent(transactionId)}/operations`,
      runtime,
    });
    await appwriteJson({
      apiKey,
      body: { commit: true },
      failureMessage: 'KeepFlip could not finish the bookkeeping entry.',
      fetchImpl,
      method: 'PATCH',
      path: `/tablesdb/transactions/${encodeURIComponent(transactionId)}`,
      runtime,
    });
  } catch (error) {
    const transactionId = text(transaction?.$id, 64);
    if (transactionId) {
      await appwriteJson({
        apiKey,
        body: { rollback: true },
        failureMessage: 'KeepFlip could not roll back the bookkeeping entry.',
        fetchImpl,
        method: 'PATCH',
        path: `/tablesdb/transactions/${encodeURIComponent(transactionId)}`,
        runtime,
      }).catch(() => undefined);
    }
    throw error;
  }

  return { bookTransactionId, status: sourceEventStatus };
}

function manualSourceKey(body, eventType) {
  const key = text(body.idempotencyKey, 120);
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(key)) {
    throw new HttpError(
      400,
      'This Books entry needs a unique save key. Close and try saving it again.',
    );
  }
  return key;
}

async function handleManualRecord({ req, res, runtime, fetchImpl, now }) {
  const body = requestBody(req);
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = tableConfiguration();
  const eventType = text(body.eventType, 60);
  const occurredAt = dateValue(body.occurredAt, 'Books date');
  const externalKey = manualSourceKey(body, eventType);
  const source = 'manual';
  const itemId = text(body.itemId, 64) || null;
  const notes = text(body.notes, 1_000) || null;
  let entry;
  let itemUpdate;

  try {
    if (eventType === 'sale') {
      if (!itemId) throw new HttpError(400, 'Choose the inventory item that sold.');
      const item = await getOwnedItem({
        apiKey,
        configuration,
        fetchImpl,
        itemId,
        ownerId,
        runtime,
      });
      const sale = inventorySaleState(item, body.quantity);
      entry = postBookkeepingEvent({
        costCents: sale.costCents,
        currency: 'USD',
        eventType,
        feeCents: optionalIntegerCents(body.feeCents, 'Marketplace fees') ?? 0,
        grossSaleCents: integerCents(body.grossSaleCents ?? body.amountCents, 'Sale amount'),
        itemId,
        marketplaceCollectedTaxCents: optionalIntegerCents(body.marketplaceCollectedTaxCents, 'Marketplace-collected tax') ?? 0,
        notes,
        occurredAt,
        sourceKey: `${source}:${eventType}:${externalKey}`,
        summary: 'Manual sale',
      });
      itemUpdate = itemUpdateForSale({
        externalKey,
        occurredAt,
        orderId: text(body.orderId, 180) || null,
        ownerId,
        sale,
        source,
        now,
      });
    } else {
      const amountCents = integerCents(body.amountCents);
      if (eventType === 'inventory_purchase' && !itemId) {
        throw new HttpError(400, 'Choose the inventory item for this purchase.');
      }
      if (itemId) {
        await getOwnedItem({ apiKey, configuration, fetchImpl, itemId, ownerId, runtime });
      }
      entry = postBookkeepingEvent({
        amountCents,
        currency: 'USD',
        eventType,
        itemId,
        notes,
        occurredAt,
        sourceKey: `${source}:${eventType}:${externalKey}`,
        summary: text(body.summary, 255) || undefined,
      });
      if (eventType === 'inventory_purchase' && itemId) {
        itemUpdate = {
          bookPurchaseTransactionId: transactionRowId(ownerId, source, externalKey),
          updatedAt: now,
        };
      }
    }
  } catch (error) {
    if (error instanceof HttpError || error instanceof BookkeepingValidationError) throw error;
    throw new HttpError(400, 'KeepFlip could not read that Books entry.');
  }

  await ensureBookAccounts({ apiKey, configuration, fetchImpl, now, ownerId, runtime });
  const result = await persistEntry({
    apiKey,
    configuration,
    entry,
    externalKey,
    fetchImpl,
    itemUpdate,
    now,
    orderId: text(body.orderId, 180) || null,
    ownerId,
    payoutId: text(body.payoutId, 180) || null,
    runtime,
    source,
  });
  return res.json({
    alreadyRecorded: result.status === 'already_recorded',
    bookTransactionId: result.bookTransactionId,
    needsItemCost: result.status === 'needs_item_cost',
    ok: true,
  });
}

function decryptSecret(value, key) {
  const [version, ivText, tagText, ciphertextText, ...extra] = String(value ?? '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText || extra.length > 0) {
    throw new HttpError(500, 'KeepFlip could not read the stored eBay connection.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new HttpError(500, 'KeepFlip could not read the stored eBay connection.');
  }
}

function encryptSecret(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function readTokenBundle(connection, configuration) {
  const ciphertext = text(connection?.tokenCiphertext) || text(connection?.encryptedTokens);
  let tokens;
  try {
    tokens = JSON.parse(decryptSecret(ciphertext, configuration.encryptionKey));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, 'KeepFlip could not read the stored eBay connection.');
  }
  if (
    !tokens ||
    !text(tokens.accessToken, 8_000) ||
    !text(tokens.refreshToken, 8_000) ||
    !text(tokens.accessTokenExpiresAt, 80) ||
    !text(tokens.refreshTokenExpiresAt, 80)
  ) {
    throw new HttpError(500, 'KeepFlip could not read the stored eBay connection.');
  }
  return tokens;
}

function ebayTokenEndpoint(environment) {
  return environment === 'production'
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

function addSeconds(date, seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) return date.toISOString();
  return new Date(date.getTime() + numeric * 1_000).toISOString();
}

async function refreshEbayToken({ runtime, configuration, apiKey, connection, fetchImpl, now }) {
  const tokenBundle = readTokenBundle(connection, configuration);
  const accessExpiresAt = Date.parse(tokenBundle.accessTokenExpiresAt);
  if (Number.isFinite(accessExpiresAt) && accessExpiresAt > Date.now() + 60_000) {
    return tokenBundle.accessToken;
  }
  if (Date.parse(tokenBundle.refreshTokenExpiresAt) <= Date.now()) {
    throw new HttpError(401, 'Your eBay authorization has expired. Reconnect eBay and try again.');
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenBundle.refreshToken,
    scope: configuration.scopeText,
  });
  let response;
  try {
    response = await fetchImpl(ebayTokenEndpoint(configuration.environment), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${configuration.clientId}:${configuration.clientSecret}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch {
    throw new HttpError(502, 'KeepFlip could not refresh the eBay authorization.');
  }
  const payload = await responseJson(response);
  if (!response.ok || !text(payload?.access_token, 8_000)) {
    throw new HttpError(502, 'KeepFlip could not refresh the eBay authorization.');
  }
  const clock = new Date(now);
  const next = {
    ...tokenBundle,
    accessToken: text(payload.access_token, 8_000),
    accessTokenExpiresAt: addSeconds(clock, payload.expires_in),
    refreshToken: text(payload.refresh_token, 8_000) || tokenBundle.refreshToken,
    refreshTokenExpiresAt: payload.refresh_token_expires_in
      ? addSeconds(clock, payload.refresh_token_expires_in)
      : tokenBundle.refreshTokenExpiresAt,
    scopeText: configuration.scopeText,
    updatedAt: clock.toISOString(),
  };
  const field = text(connection?.tokenCiphertext) ? 'tokenCiphertext' : 'encryptedTokens';
  await appwriteJson({
    apiKey,
    body: { data: { [field]: encryptSecret(JSON.stringify(next), configuration.encryptionKey), updatedAt: next.updatedAt } },
    failureMessage: 'KeepFlip could not save the refreshed eBay authorization.',
    fetchImpl,
    method: 'PATCH',
    path: rowPath(configuration, configuration.connectionsTableId, connectionRowId(connection.ownerId, configuration.environment)),
    runtime,
  });
  return next.accessToken;
}

function financesBase(environment) {
  return environment === 'production'
    ? 'https://apiz.ebay.com'
    : 'https://apiz.sandbox.ebay.com';
}

async function eBayFinanceJson({ configuration, accessToken, path, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(financesBase(configuration.environment) + path, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Accept-Language': 'en-US',
      },
    });
  } catch {
    throw new HttpError(502, 'KeepFlip could not reach eBay finance records.');
  }
  const payload = await responseJson(response);
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(
      401,
      'eBay did not authorize this finance sync. Reconnect eBay, then try again.',
    );
  }
  if (!response.ok && response.status !== 204) {
    throw new HttpError(
      502,
      'eBay finance sync needs attention. If this seller is in the EU or UK, finish the additional eBay security setup before retrying.',
    );
  }
  return payload;
}

function financeWindow(body, now) {
  const end = new Date(now);
  const requestedStart = text(body.startedAt, 80);
  const start = requestedStart ? new Date(requestedStart) : new Date(end.getTime() - 14 * 86_400_000);
  if (!Number.isFinite(start.getTime()) || start > end) {
    throw new HttpError(400, 'Choose a real eBay sync start date before today.');
  }
  const oldest = new Date(end.getTime() - MAX_EBAY_SYNC_DAYS * 86_400_000);
  return {
    end: end.toISOString(),
    start: (start < oldest ? oldest : start).toISOString(),
  };
}

async function fetchEbayTransactions({ configuration, accessToken, start, end, fetchImpl }) {
  const transactions = [];
  for (let offset = 0; transactions.length < MAX_EBAY_SYNC_ROWS; offset += 100) {
    const params = new URLSearchParams({
      filter: `transactionDate:[${start}..${end}]`,
      limit: '100',
      offset: String(offset),
    });
    const payload = await eBayFinanceJson({
      accessToken,
      configuration,
      fetchImpl,
      path: `/sell/finances/v1/transaction?${params.toString()}`,
    });
    const page = Array.isArray(payload?.transactions) ? payload.transactions : [];
    transactions.push(...page.slice(0, MAX_EBAY_SYNC_ROWS - transactions.length));
    if (page.length < 100) break;
  }
  return transactions;
}

async function fetchEbayPayouts({ configuration, accessToken, start, end, fetchImpl }) {
  const payouts = [];
  for (let offset = 0; payouts.length < MAX_EBAY_SYNC_ROWS; offset += 100) {
    const params = new URLSearchParams({
      filter: `payoutDate:[${start}..${end}]`,
      limit: '100',
      offset: String(offset),
    });
    const payload = await eBayFinanceJson({
      accessToken,
      configuration,
      fetchImpl,
      path: `/sell/finances/v1/payout?${params.toString()}`,
    });
    const page = Array.isArray(payload?.payouts) ? payload.payouts : [];
    payouts.push(...page.slice(0, MAX_EBAY_SYNC_ROWS - payouts.length));
    if (page.length < 100) break;
  }
  return payouts;
}

async function findItemForEbayEvent({ runtime, configuration, apiKey, ownerId, identifiers, fetchImpl }) {
  const unique = [...new Set((Array.isArray(identifiers) ? identifiers : []).map((value) => text(value, 180)).filter(Boolean))].slice(0, 20);
  for (const column of ['ebayListingId', 'ebaySku', 'ebayOfferId']) {
    for (const value of unique) {
      let payload;
      try {
        payload = await appwriteJson({
          apiKey,
          failureMessage: 'KeepFlip could not match this eBay sale to inventory.',
          fetchImpl,
          path: listRowsPath(configuration, configuration.itemsTableId, [
            createQuery('equal', 'ownerId', [ownerId]),
            createQuery('equal', column, [value]),
            createQuery('limit', '', [1]),
          ]),
          runtime,
        });
      } catch {
        // If the mapping columns have not been deployed yet, retain the raw
        // event as a review item rather than guessing an inventory match.
        return null;
      }
      const item = Array.isArray(payload?.rows) ? payload.rows[0] : null;
      if (item && ownerIdFromRow(item) === ownerId) return item;
    }
  }
  return null;
}

async function handleParsedEbayEvent({ runtime, configuration, apiKey, ownerId, event, fetchImpl, now }) {
  if (event.status !== 'ready' || !event.eventType || event.currency !== 'USD') {
    await recordReviewEvent({
      apiKey,
      configuration,
      event: {
        ...event,
        externalKey: event.externalId || event.sourceKey,
        source: 'ebay_finances',
      },
      fetchImpl,
      now,
      ownerId,
      reason: event.reviewReason || 'Unsupported currency or transaction shape.',
      runtime,
      status: 'needs_review',
    });
    return 'needs_review';
  }

  let itemId = null;
  let itemUpdate;
  let costCents = null;
  if (event.eventType === 'sale') {
    const item = await findItemForEbayEvent({
      apiKey,
      configuration,
      fetchImpl,
      identifiers: event.itemIdentifiers,
      ownerId,
      runtime,
    });
    if (!item) {
      await recordReviewEvent({
        apiKey,
        configuration,
        event: {
          ...event,
          amountCents: event.grossSaleCents,
          externalKey: event.externalId,
          source: 'ebay_finances',
        },
        fetchImpl,
        now,
        ownerId,
        reason: 'No KeepFlip item mapping was found for this eBay sale.',
        runtime,
        status: 'needs_item_match',
      });
      return 'needs_item_match';
    }
    const sale = inventorySaleState(item, 1);
    if (sale.quantityBefore > 1) {
      await recordReviewEvent({
        apiKey,
        configuration,
        event: {
          ...event,
          amountCents: event.grossSaleCents,
          externalKey: event.externalId,
          source: 'ebay_finances',
        },
        fetchImpl,
        now,
        ownerId,
        reason: 'This inventory item has multiple units. Confirm the sold quantity before moving cost out of inventory.',
        runtime,
        status: 'needs_review',
      });
      return 'needs_review';
    }
    itemId = text(item.$id, 64);
    costCents = sale.costCents;
    itemUpdate = itemUpdateForSale({
      externalKey: event.externalId,
      occurredAt: event.occurredAt,
      orderId: event.orderId || null,
      ownerId,
      sale,
      source: 'ebay_finances',
      now,
    });
  }

  let entry;
  try {
    entry = postBookkeepingEvent({
      ...event,
      costCents,
      itemId,
      notes: null,
      sourceKey: `ebay_finances:${event.externalId}`,
    });
  } catch (caught) {
    if (!(caught instanceof BookkeepingValidationError)) throw caught;
    await recordReviewEvent({
      apiKey,
      configuration,
      event: {
        ...event,
        amountCents:
          Number.isSafeInteger(event.amountCents)
            ? event.amountCents
            : Number.isSafeInteger(event.grossSaleCents)
              ? event.grossSaleCents
              : 0,
        externalKey: event.externalId || event.sourceKey,
        source: 'ebay_finances',
      },
      fetchImpl,
      now,
      ownerId,
      reason: 'The eBay event could not be posted safely.',
      runtime,
      status: 'needs_review',
    });
    return 'needs_review';
  }
  const result = await persistEntry({
    apiKey,
    configuration,
    entry,
    externalKey: event.externalId,
    fetchImpl,
    itemUpdate,
    now,
    orderId: event.orderId,
    ownerId,
    payoutId: event.eventType === 'payout' ? event.externalId : null,
    payoutStatus: event.payoutStatus || null,
    runtime,
    source: 'ebay_finances',
  });
  return result.status;
}

export function isSyncEligibleEbayConnection(connection, ownerId, environment) {
  const storedEnvironment = text(connection?.environment, 16).toLowerCase();
  // Older connection rows predate the optional environment column. Their
  // deterministic row ID already includes the owner and requested environment,
  // and this check still verifies the loaded row belongs to the signed-in user.
  return Boolean(
    connection &&
      ownerIdFromRow(connection) === ownerId &&
      (!storedEnvironment || storedEnvironment === environment) &&
      !connection.revokedAt &&
      text(connection.status, 32).toLowerCase() !== 'revoked'
  );
}

async function handleEbaySync({ req, res, runtime, fetchImpl, now }) {
  const body = requestBody(req);
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = ebayConfiguration(body.environment);
  const connection = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: connectionRowId(ownerId, configuration.environment),
    runtime,
    tableId: configuration.connectionsTableId,
  });
  if (!isSyncEligibleEbayConnection(connection, ownerId, configuration.environment)) {
    throw new HttpError(401, 'Reconnect eBay before syncing its financial activity.');
  }
  const window = financeWindow(body, now);
  const accessToken = await refreshEbayToken({
    apiKey,
    configuration,
    connection,
    fetchImpl,
    now,
    runtime,
  });
  await ensureBookAccounts({ apiKey, configuration, fetchImpl, now, ownerId, runtime });
  const [transactions, payouts] = await Promise.all([
    fetchEbayTransactions({ accessToken, configuration, end: window.end, fetchImpl, start: window.start }),
    fetchEbayPayouts({ accessToken, configuration, end: window.end, fetchImpl, start: window.start }),
  ]);
  const counts = { alreadyRecorded: 0, needsItemCost: 0, needsItemMatch: 0, needsReview: 0, posted: 0 };
  for (const raw of transactions) {
    const parsed = parseEbayFinanceTransaction(raw, {
      fallbackOccurredAt: now,
    });
    const outcome = await handleParsedEbayEvent({
      apiKey,
      configuration,
      event: parsed,
      fetchImpl,
      now,
      ownerId,
      runtime,
    });
    if (outcome === 'already_recorded') counts.alreadyRecorded += 1;
    else if (outcome === 'needs_item_cost') counts.needsItemCost += 1;
    else if (outcome === 'needs_item_match') counts.needsItemMatch += 1;
    else if (outcome === 'needs_review') counts.needsReview += 1;
    else counts.posted += 1;
  }
  for (const raw of payouts) {
    const parsed = parseEbayPayout(raw, { fallbackOccurredAt: now });
    parsed.payoutStatus = text(raw?.payoutStatus, 60) || 'unknown';
    const outcome = await handleParsedEbayEvent({
      apiKey,
      configuration,
      event: parsed,
      fetchImpl,
      now,
      ownerId,
      runtime,
    });
    if (outcome === 'already_recorded') counts.alreadyRecorded += 1;
    else if (outcome === 'needs_review') counts.needsReview += 1;
    else counts.posted += 1;
  }
  return res.json({
    ...counts,
    ok: true,
    syncedFrom: window.start,
    syncedTo: window.end,
    transactionCount: transactions.length,
    payoutCount: payouts.length,
  });
}

function overviewEventForLine(row) {
  const accountCode = text(row?.accountCode, 80);
  const side = text(row?.side, 16);
  const amountCents = Number(row?.amountCents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  const base = {
    amountCents,
    id: text(row?.$id, 64),
    itemId: text(row?.itemId, 64) || null,
    occurredAt: text(row?.occurredAt, 64),
  };
  if (side === 'credit' && accountCode === BOOK_ACCOUNT.resaleRevenue) {
    return { ...base, direction: 'income', entryType: 'sale_proceeds' };
  }
  if (side === 'credit' && accountCode === BOOK_ACCOUNT.ebayCredits) {
    return { ...base, direction: 'income', entryType: 'other_income' };
  }
  const expenseType = {
    [BOOK_ACCOUNT.inventory]: 'inventory_purchase',
    [BOOK_ACCOUNT.marketplaceFees]: 'marketplace_fee',
    [BOOK_ACCOUNT.shippingLabels]: 'shipping_label',
    [BOOK_ACCOUNT.salesReturns]: 'refund',
    [BOOK_ACCOUNT.repairs]: 'repair_parts',
    [BOOK_ACCOUNT.supplies]: 'supplies',
    [BOOK_ACCOUNT.software]: 'software',
    [BOOK_ACCOUNT.advertising]: 'advertising',
    [BOOK_ACCOUNT.storage]: 'storage',
    [BOOK_ACCOUNT.mileage]: 'mileage',
    [BOOK_ACCOUNT.otherExpense]: 'other_expense',
  }[accountCode];
  if (side === 'debit' && expenseType) {
    return { ...base, direction: 'expense', entryType: expenseType };
  }
  return null;
}

async function handleOverview({ req, res, runtime, fetchImpl }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = tableConfiguration();
  const payload = await appwriteJson({
    apiKey,
    failureMessage: 'KeepFlip could not load the Books overview.',
    fetchImpl,
    path: listRowsPath(configuration, configuration.journalLinesTableId, [
      createQuery('equal', 'ownerId', [ownerId]),
      createQuery('orderDesc', 'occurredAt'),
      createQuery('limit', '', [1000]),
    ]),
    runtime,
  });
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const moneyEvents = rows.map(overviewEventForLine).filter(Boolean);
  return res.json({
    moneyEvents,
    ok: true,
    truncated: rows.length >= 1000,
  });
}

function responseStatus(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof BookkeepingValidationError) return 422;
  if (error instanceof UpstreamError) return 502;
  return 500;
}

function safeError(log, error, method, path) {
  const status = responseStatus(error);
  const reason =
    error instanceof HttpError
      ? `HTTP_${error.status}`
      : error instanceof BookkeepingValidationError
        ? 'BOOKKEEPING_VALIDATION'
      : error instanceof UpstreamError
        ? `APPWRITE_${error.status || 'NETWORK'}`
        : `UNEXPECTED_${text(error?.name, 32).toUpperCase() || 'ERROR'}`;
  log(`KeepFlip Books ${method} ${path} failed with status ${status}. reason=${reason}`);
}

function jsonError(res, error) {
  const status = responseStatus(error);
  const message =
    error instanceof HttpError
      ? error.message
      : error instanceof BookkeepingValidationError
        ? 'One or more bookkeeping events need review.'
      : 'KeepFlip could not update Books. Please try again.';
  return res.json({ error: message, ok: false }, status);
}

export function createHandler({ error, log, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  return async ({ req, res, log = () => {} }) => {
    const method = text(req?.method, 16).toUpperCase();
    const path = requestPath(req);
    try {
      if (method !== 'POST') throw new HttpError(405, 'Use POST for Books requests.');
      const runtime = runtimeConfiguration();
      const nowValue = dateValue(now(), 'Clock');
      if (path === '/record') {
        return await handleManualRecord({ fetchImpl, now: nowValue, req, res, runtime });
      }
      if (path === '/ebay/sync') {
        return await handleEbaySync({ fetchImpl, now: nowValue, req, res, runtime });
      }
      if (path === '/overview') {
        return await handleOverview({ fetchImpl, req, res, runtime });
      }
      error(404, 'Books endpoint not found.');
    } catch (error) {
      safeError(log, error, method, path);
      return jsonError(res, error);
    }
  };
}

export default createHandler();
