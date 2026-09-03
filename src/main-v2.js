import { createHash } from 'node:crypto';

import { BOOK_ACCOUNT } from './bookkeeping-domain.js';
import {
  createHandler as createExistingHandler,
  reviewItemForRow,
} from './main-existing.js';

const OPEN_REVIEW_STATUSES = new Set([
  'needs_item_match',
  'needs_item_cost',
  'needs_review',
]);
const CONFIRMED_REVIEW_PREFIX = '[KEEPFLIP_REVIEW_CONFIRMED]';

class ReviewHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ReviewHttpError';
    this.status = status;
  }
}

class ReviewUpstreamError extends Error {
  constructor(status, message, upstreamMessage = '') {
    super(message);
    this.name = 'ReviewUpstreamError';
    this.status = status;
    this.upstreamMessage = text(upstreamMessage, 1_000);
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
  return {
    endpoint: requiredEnvironment(['APPWRITE_FUNCTION_API_ENDPOINT']).replace(/\/+$/, ''),
    projectId: requiredEnvironment(['APPWRITE_FUNCTION_PROJECT_ID']),
  };
}

function tableConfiguration() {
  return {
    databaseId: firstEnvironment(['APPWRITE_BOOKS_DATABASE_ID', 'APPWRITE_DATABASE_ID'], 'keepflip'),
    sourceEventsTableId: firstEnvironment(['APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID'], 'book_source_events'),
    transactionsTableId: firstEnvironment(['APPWRITE_BOOK_TRANSACTIONS_TABLE_ID'], 'book_transactions'),
    journalLinesTableId: firstEnvironment(['APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID'], 'book_journal_lines'),
    itemsTableId: firstEnvironment(['APPWRITE_BOOK_ITEMS_TABLE_ID', 'APPWRITE_ITEMS_TABLE_ID'], 'items'),
  };
}

function dynamicApiKey(req) {
  const key = requestHeader(req?.headers, 'x-appwrite-key') || text(process.env.APPWRITE_FUNCTION_API_KEY);
  if (!key) throw new Error('Appwrite did not provide this Function a dynamic API key.');
  return key;
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
    const body = await response.text();
    return body ? JSON.parse(body) : {};
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
  fetchImpl,
}) {
  let response;
  try {
    response = await fetchImpl(runtime.endpoint + path, {
      method,
      headers: appwriteHeaders(runtime, { apiKey, jwt }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ReviewUpstreamError(0, failureMessage);
  }
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new ReviewUpstreamError(
      response.status,
      failureMessage,
      text(payload?.message, 1_000) || text(payload?.error, 1_000),
    );
  }
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
  const cleanedAttribute = text(attribute, 512);
  if (cleanedAttribute) query.attribute = cleanedAttribute;
  if (Array.isArray(values) && values.length) query.values = values;
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
  if (!jwt) throw new ReviewHttpError(401, 'Sign in before using Books.');
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
    throw new ReviewHttpError(401, 'Your sign-in could not be verified. Sign in and try again.');
  }
  const userId = text(account?.$id, 64);
  if (!userId) throw new ReviewHttpError(401, 'Your sign-in could not be verified. Sign in and try again.');
  return userId;
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
    if (error instanceof ReviewUpstreamError && error.status === 404) return null;
    throw error;
  }
}

function ownerIdFromRow(row) {
  return text(row?.ownerId, 64);
}

function stableId(namespace, ...parts) {
  return createHash('sha256')
    .update(['keepflip', namespace, 'v1', ...parts.map((part) => String(part ?? ''))].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 36);
}

function transactionRowId(ownerId, source, externalKey) {
  return stableId('book-transaction', ownerId, source, externalKey);
}

function reviewCostLineId(bookTransactionId, reviewId, side) {
  return stableId('book-cost-review-line', bookTransactionId, reviewId, side);
}

function reviewPurchaseLineId(bookTransactionId, reviewId, side) {
  return stableId('book-cost-review-purchase-line', bookTransactionId, reviewId, side);
}

function nonNegativeCents(value, field) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000) {
    throw new ReviewHttpError(400, `${field} must be a non-negative whole number of cents.`);
  }
  return amount;
}

function normalizedCurrency(value, fallback = '') {
  const currency = text(value, 8).toUpperCase() || text(fallback, 8).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ReviewHttpError(400, 'Currency must be a three-letter code such as USD.');
  }
  return currency;
}

function storedReviewReason(row) {
  const reason = text(row?.reviewReason, 1_000);
  return reason.startsWith(CONFIRMED_REVIEW_PREFIX)
    ? reason.slice(CONFIRMED_REVIEW_PREFIX.length).trim()
    : reason;
}

function isFallbackConfirmedReviewRow(row) {
  return Boolean(
    text(row?.reviewUpdatedAt, 80) &&
      text(row?.reviewReason, 1_000).startsWith(CONFIRMED_REVIEW_PREFIX),
  );
}

function fallbackConfirmedReviewReason(row) {
  const reason =
    storedReviewReason(row) ||
    reviewItemForRow(row).reason ||
    'Source transaction reviewed and confirmed by the user in Books.';
  return `${CONFIRMED_REVIEW_PREFIX} ${reason}`.slice(0, 1_000);
}

function reviewDetailForRow(row, item = null) {
  const base = reviewItemForRow(row);
  const storedReason = storedReviewReason(row);
  const fallbackConfirmed = isFallbackConfirmedReviewRow(row);
  return {
    ...base,
    status: fallbackConfirmed ? 'review_confirmed' : base.status,
    bookingEntry: text(row?.bookingEntry, 32).toUpperCase() || null,
    rawAmountValue: text(row?.rawAmountValue, 64) || null,
    rawCurrency: text(row?.rawCurrency, 8).toUpperCase() || null,
    rawTransactionType: text(row?.rawTransactionType, 80).toUpperCase() || null,
    reason: storedReason || base.reason,
    reviewUpdatedAt: text(row?.reviewUpdatedAt, 80) || null,
    transactionMemo: text(row?.transactionMemo, 1_000) || null,
    item: item
      ? {
          id: text(item?.$id, 64),
          title: text(item?.title, 255) || 'Inventory item',
          quantityOnHand: Number.isSafeInteger(Number(item?.quantityOnHand))
            ? Number(item.quantityOnHand)
            : null,
          acquisitionCostCents: Number.isSafeInteger(Number(item?.acquisitionCostCents))
            ? Number(item.acquisitionCostCents)
            : null,
        }
      : null,
  };
}

async function loadOwnedReview({ req, runtime, fetchImpl }) {
  const body = requestBody(req);
  const reviewId = text(body.reviewId, 64);
  if (!reviewId) throw new ReviewHttpError(400, 'Choose the transaction that needs review.');
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = tableConfiguration();
  const reviewRow = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: reviewId,
    runtime,
    tableId: configuration.sourceEventsTableId,
  });
  if (!reviewRow || ownerIdFromRow(reviewRow) !== ownerId) {
    throw new ReviewHttpError(404, 'That Books review transaction is no longer available.');
  }
  return { apiKey, body, configuration, ownerId, reviewId, reviewRow };
}

async function loadReviewItem({ runtime, configuration, apiKey, ownerId, reviewRow, fetchImpl }) {
  const itemId = text(reviewRow?.itemId, 64);
  if (!itemId) return null;
  const item = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: itemId,
    runtime,
    tableId: configuration.itemsTableId,
  });
  return item && ownerIdFromRow(item) === ownerId ? item : null;
}

async function handleReviewList({ req, res, runtime, fetchImpl }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = tableConfiguration();
  const payload = await appwriteJson({
    apiKey,
    failureMessage: 'KeepFlip could not load the money review queue.',
    fetchImpl,
    path: listRowsPath(configuration, configuration.sourceEventsTableId, [
      createQuery('equal', 'ownerId', [ownerId]),
      createQuery('limit', '', [500]),
    ]),
    runtime,
  });
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const items = rows
    .filter(
      (row) =>
        OPEN_REVIEW_STATUSES.has(text(row?.eventStatus, 40)) &&
        !isFallbackConfirmedReviewRow(row),
    )
    .sort((left, right) => {
      const leftTime = Date.parse(text(left?.occurredAt, 64)) || 0;
      const rightTime = Date.parse(text(right?.occurredAt, 64)) || 0;
      return rightTime - leftTime;
    })
    .map((row) => reviewDetailForRow(row));

  return res.json({
    items,
    ok: true,
    total: items.length,
  });
}

async function handleReviewDetail({ req, res, runtime, fetchImpl }) {
  const loaded = await loadOwnedReview({ fetchImpl, req, runtime });
  const item = await loadReviewItem({
    ...loaded,
    fetchImpl,
    runtime,
  });
  return res.json({
    item: reviewDetailForRow(loaded.reviewRow, item),
    ok: true,
  });
}

function bookTransactionData({ ownerId, source, externalKey, itemId, occurredAt, memo, now }) {
  return {
    createdAt: now,
    currency: 'USD',
    eventType: 'inventory_purchase',
    externalKey,
    itemId: itemId || null,
    memo,
    occurredAt,
    orderId: null,
    ownerId,
    payoutId: null,
    reversesTransactionId: null,
    source,
  };
}

function journalLineData({
  accountCode,
  amountCents,
  bookTransactionId,
  externalKey,
  itemId,
  occurredAt,
  ownerId,
  side,
  source,
  now,
  orderId = null,
}) {
  return {
    accountCode,
    amountCents,
    bookTransactionId,
    createdAt: now,
    currency: 'USD',
    externalKey,
    itemId: itemId || null,
    occurredAt,
    orderId,
    ownerId,
    payoutId: null,
    side,
    source,
  };
}

async function commitOperations({ runtime, apiKey, operations, fetchImpl }) {
  if (!operations.length) return;
  let transaction;
  try {
    transaction = await appwriteJson({
      apiKey,
      body: { ttl: 60 },
      failureMessage: 'KeepFlip could not begin the reviewed Books update.',
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
      failureMessage: 'KeepFlip could not stage the reviewed Books update.',
      fetchImpl,
      method: 'POST',
      path: `/tablesdb/transactions/${encodeURIComponent(transactionId)}/operations`,
      runtime,
    });
    await appwriteJson({
      apiKey,
      body: { commit: true },
      failureMessage: 'KeepFlip could not finish the reviewed Books update.',
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
        failureMessage: 'KeepFlip could not roll back the reviewed Books update.',
        fetchImpl,
        method: 'PATCH',
        path: `/tablesdb/transactions/${encodeURIComponent(transactionId)}`,
        runtime,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function confirmCostReview({ loaded, runtime, fetchImpl, now }) {
  const { apiKey, body, configuration, ownerId, reviewId, reviewRow } = loaded;
  const item = await loadReviewItem({
    ...loaded,
    fetchImpl,
    runtime,
  });
  if (!item) throw new ReviewHttpError(409, 'The inventory item for this sale is no longer available.');

  const costCents = nonNegativeCents(body.itemCostCents, 'Cost of the sold item');
  const itemId = text(item.$id, 64);
  const saleExternalKey = text(reviewRow.externalKey, 255);
  const saleBookTransactionId =
    text(item.bookSaleTransactionId, 64) ||
    transactionRowId(ownerId, 'ebay_finances', saleExternalKey);
  const saleTransaction = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: saleBookTransactionId,
    runtime,
    tableId: configuration.transactionsTableId,
  });
  if (!saleTransaction || ownerIdFromRow(saleTransaction) !== ownerId) {
    throw new ReviewHttpError(409, 'KeepFlip could not find the posted sale that needs this cost. Sync eBay money again before confirming it.');
  }

  const operations = [];
  let purchaseTransactionId = text(item.bookPurchaseTransactionId, 64) || null;
  if (costCents > 0 && !purchaseTransactionId) {
    const purchaseExternalKey = `cost-review:${reviewId}`;
    purchaseTransactionId = transactionRowId(ownerId, 'cost_reconciliation', purchaseExternalKey);
    const existingPurchase = await getRowOrNull({
      apiKey,
      configuration,
      fetchImpl,
      rowId: purchaseTransactionId,
      runtime,
      tableId: configuration.transactionsTableId,
    });
    if (!existingPurchase) {
      const purchaseDate =
        text(item.acquiredAt, 80) ||
        text(item.createdAt, 80) ||
        text(item.$createdAt, 80) ||
        text(reviewRow.occurredAt, 80) ||
        now;
      operations.push(
        {
          action: 'create',
          data: bookTransactionData({
            externalKey: purchaseExternalKey,
            itemId,
            memo: 'Original item cost confirmed during eBay sale review',
            now,
            occurredAt: purchaseDate,
            ownerId,
            source: 'cost_reconciliation',
          }),
          databaseId: configuration.databaseId,
          rowId: purchaseTransactionId,
          tableId: configuration.transactionsTableId,
        },
        {
          action: 'create',
          data: journalLineData({
            accountCode: BOOK_ACCOUNT.inventory,
            amountCents: costCents,
            bookTransactionId: purchaseTransactionId,
            externalKey: purchaseExternalKey,
            itemId,
            now,
            occurredAt: purchaseDate,
            ownerId,
            side: 'debit',
            source: 'cost_reconciliation',
          }),
          databaseId: configuration.databaseId,
          rowId: reviewPurchaseLineId(purchaseTransactionId, reviewId, 'inventory'),
          tableId: configuration.journalLinesTableId,
        },
        {
          action: 'create',
          data: journalLineData({
            accountCode: BOOK_ACCOUNT.cash,
            amountCents: costCents,
            bookTransactionId: purchaseTransactionId,
            externalKey: purchaseExternalKey,
            itemId,
            now,
            occurredAt: purchaseDate,
            ownerId,
            side: 'credit',
            source: 'cost_reconciliation',
          }),
          databaseId: configuration.databaseId,
          rowId: reviewPurchaseLineId(purchaseTransactionId, reviewId, 'cash'),
          tableId: configuration.journalLinesTableId,
        },
      );
    }
  }

  if (costCents > 0) {
    const cogsLineId = reviewCostLineId(saleBookTransactionId, reviewId, 'cogs');
    const existingCostLine = await getRowOrNull({
      apiKey,
      configuration,
      fetchImpl,
      rowId: cogsLineId,
      runtime,
      tableId: configuration.journalLinesTableId,
    });
    if (!existingCostLine) {
      const saleDate = text(reviewRow.occurredAt, 80) || now;
      const orderId = text(reviewRow.orderId, 180) || null;
      operations.push(
        {
          action: 'create',
          data: journalLineData({
            accountCode: BOOK_ACCOUNT.costOfGoodsSold,
            amountCents: costCents,
            bookTransactionId: saleBookTransactionId,
            externalKey: saleExternalKey,
            itemId,
            now,
            occurredAt: saleDate,
            orderId,
            ownerId,
            side: 'debit',
            source: 'cost_reconciliation',
          }),
          databaseId: configuration.databaseId,
          rowId: cogsLineId,
          tableId: configuration.journalLinesTableId,
        },
        {
          action: 'create',
          data: journalLineData({
            accountCode: BOOK_ACCOUNT.inventory,
            amountCents: costCents,
            bookTransactionId: saleBookTransactionId,
            externalKey: saleExternalKey,
            itemId,
            now,
            occurredAt: saleDate,
            orderId,
            ownerId,
            side: 'credit',
            source: 'cost_reconciliation',
          }),
          databaseId: configuration.databaseId,
          rowId: reviewCostLineId(saleBookTransactionId, reviewId, 'inventory'),
          tableId: configuration.journalLinesTableId,
        },
      );
    }
  }

  const quantityOnHand = Number(item.quantityOnHand);
  const itemPatch = {
    updatedAt: now,
    ...(Number.isSafeInteger(quantityOnHand) && quantityOnHand === 0
      ? {
          acquisitionCostCents: costCents,
          inventoryCostCentsOnHand: 0,
          ...(purchaseTransactionId ? { bookPurchaseTransactionId: purchaseTransactionId } : {}),
        }
      : {}),
  };
  operations.push(
    {
      action: 'update',
      data: itemPatch,
      databaseId: configuration.databaseId,
      rowId: itemId,
      tableId: configuration.itemsTableId,
    },
    {
      action: 'update',
      data: {
        eventStatus: 'posted',
        reviewReason: `Cost of goods sold confirmed by the user at ${costCents} cents.`,
        reviewUpdatedAt: now,
      },
      databaseId: configuration.databaseId,
      rowId: reviewId,
      tableId: configuration.sourceEventsTableId,
    },
  );

  await commitOperations({ apiKey, fetchImpl, operations, runtime });
  return {
    itemCostCents: costCents,
    status: 'posted',
  };
}

async function confirmGeneralReview({ loaded, runtime, fetchImpl, now }) {
  const { apiKey, body, configuration, reviewId, reviewRow } = loaded;
  const amountCents = nonNegativeCents(body.amountCents, 'Reviewed amount');
  const currency = normalizedCurrency(body.currency, reviewRow.currency);
  const transactionMemo = text(body.transactionMemo, 1_000) || null;
  const reviewReason =
    storedReviewReason(reviewRow) ||
    'Source transaction reviewed and confirmed by the user in Books.';
  const path = rowPath(configuration, configuration.sourceEventsTableId, reviewId);
  const commonData = {
    amountCents,
    currency,
    reviewUpdatedAt: now,
    transactionMemo,
  };

  try {
    await appwriteJson({
      apiKey,
      body: {
        data: {
          ...commonData,
          eventStatus: 'review_confirmed',
          reviewReason,
        },
      },
      failureMessage: 'KeepFlip could not confirm this transaction review.',
      fetchImpl,
      method: 'PATCH',
      path,
      runtime,
    });
  } catch (error) {
    if (!(error instanceof ReviewUpstreamError) || error.status !== 400) {
      throw error;
    }

    // Older book_source_events schemas may constrain eventStatus to the
    // original review values. Preserve that valid status and store an
    // explicit confirmation marker in the review audit fields instead.
    await appwriteJson({
      apiKey,
      body: {
        data: {
          ...commonData,
          eventStatus: text(reviewRow.eventStatus, 40) || 'needs_review',
          reviewReason: fallbackConfirmedReviewReason(reviewRow),
        },
      },
      failureMessage: 'KeepFlip could not confirm this transaction review.',
      fetchImpl,
      method: 'PATCH',
      path,
      runtime,
    });
  }

  return {
    amountCents,
    currency,
    status: 'review_confirmed',
  };
}

async function handleReviewConfirm({ req, res, runtime, fetchImpl, now }) {
  const loaded = await loadOwnedReview({ fetchImpl, req, runtime });
  if (isFallbackConfirmedReviewRow(loaded.reviewRow)) {
    return res.json({
      alreadyConfirmed: true,
      ok: true,
      status: 'review_confirmed',
    });
  }

  const status = text(loaded.reviewRow.eventStatus, 40);
  if (!OPEN_REVIEW_STATUSES.has(status)) {
    if (status === 'review_confirmed' || status === 'posted') {
      return res.json({ ok: true, status, alreadyConfirmed: true });
    }
    throw new ReviewHttpError(409, 'That transaction no longer needs review.');
  }
  if (status === 'needs_item_match') {
    throw new ReviewHttpError(409, 'Match this sale to its KeepFlip inventory item from the sale review before confirming it.');
  }

  const result = status === 'needs_item_cost'
    ? await confirmCostReview({ fetchImpl, loaded, now, runtime })
    : await confirmGeneralReview({ fetchImpl, loaded, now, runtime });
  return res.json({ ...result, ok: true, alreadyConfirmed: false });
}

async function listConfirmedReviews({ runtime, configuration, apiKey, ownerId, fetchImpl }) {
  const payload = await appwriteJson({
    apiKey,
    failureMessage: 'KeepFlip could not preserve confirmed transaction reviews.',
    fetchImpl,
    path: listRowsPath(configuration, configuration.sourceEventsTableId, [
      createQuery('equal', 'ownerId', [ownerId]),
      createQuery('limit', '', [500]),
    ]),
    runtime,
  });
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return rows.filter(
    (row) =>
      text(row?.source, 80) === 'ebay_finances' &&
      (
        text(row?.eventStatus, 40) === 'review_confirmed' ||
        isFallbackConfirmedReviewRow(row)
      ),
  );
}

async function restoreConfirmedReviews({ runtime, configuration, apiKey, snapshots, fetchImpl }) {
  for (const row of snapshots) {
    const rowId = text(row?.$id, 64);
    if (!rowId) continue;
    await appwriteJson({
      apiKey,
      body: {
        data: {
          amountCents: Number(row.amountCents),
          currency: text(row.currency, 8) || 'XXX',
          eventStatus: text(row.eventStatus, 40) || 'review_confirmed',
          reviewReason: text(row.reviewReason, 1_000) || null,
          reviewUpdatedAt: text(row.reviewUpdatedAt, 80) || null,
          sourceType: text(row.sourceType, 60) || 'unclassified',
          transactionMemo: text(row.transactionMemo, 1_000) || null,
        },
      },
      failureMessage: 'KeepFlip could not preserve a confirmed transaction review.',
      fetchImpl,
      method: 'PATCH',
      path: rowPath(configuration, configuration.sourceEventsTableId, rowId),
      runtime,
    });
  }
}

function captureResponse() {
  const result = { body: null, status: 200 };
  return {
    result,
    res: {
      json(body, status = 200) {
        result.body = body;
        result.status = status;
        return body;
      },
    },
  };
}

async function invokeExisting(handler, context) {
  const capture = captureResponse();
  await handler({ ...context, res: capture.res });
  return capture.result;
}

function statusForError(error) {
  if (error instanceof ReviewHttpError) return error.status;
  if (error instanceof ReviewUpstreamError) return 502;
  return 500;
}

function messageForError(error) {
  if (error instanceof ReviewHttpError) return error.message;
  if (error instanceof ReviewUpstreamError) {
    return error.upstreamMessage
      ? `${error.message} Appwrite reported: ${error.upstreamMessage}`
      : error.message;
  }
  return 'KeepFlip could not update this Books review. Please try again.';
}

export function createHandler(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowProvider = options.now ?? (() => new Date().toISOString());
  const existingHandler = createExistingHandler(options);

  return async (context) => {
    const method = text(context?.req?.method, 16).toUpperCase();
    const path = requestPath(context?.req);
    const runtime = runtimeConfiguration();

    try {
      if (method === 'POST' && path === '/review/detail') {
        return await handleReviewDetail({ ...context, fetchImpl, runtime });
      }
      if (method === 'POST' && path === '/review/list') {
        return await handleReviewList({ ...context, fetchImpl, runtime });
      }
      if (method === 'POST' && path === '/review/confirm') {
        const now = new Date(nowProvider()).toISOString();
        return await handleReviewConfirm({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/ebay/sync') {
        let snapshots = [];
        let auth = null;
        try {
          const ownerId = await authenticatedUserId({ fetchImpl, req: context.req, runtime });
          const apiKey = dynamicApiKey(context.req);
          const configuration = tableConfiguration();
          snapshots = await listConfirmedReviews({
            apiKey,
            configuration,
            fetchImpl,
            ownerId,
            runtime,
          });
          auth = { apiKey, configuration };
        } catch {
          snapshots = [];
        }

        const result = await invokeExisting(existingHandler, context);
        if (result.status === 200 && result.body?.ok === true && snapshots.length && auth) {
          try {
            await restoreConfirmedReviews({
              ...auth,
              fetchImpl,
              runtime,
              snapshots,
            });
          } catch (error) {
            context?.log?.(`[KeepFlip Books] Confirmed review preservation deferred: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        }
        return context.res.json(result.body, result.status);
      }
      return existingHandler(context);
    } catch (error) {
      const upstreamDetail = error instanceof ReviewUpstreamError && error.upstreamMessage
        ? ` upstream=${error.upstreamMessage}`
        : '';
      context?.log?.(`[KeepFlip Books] ${method} ${path} review workflow failed: ${error instanceof Error ? error.message : 'unknown error'}${upstreamDetail}`);
      return context.res.json(
        { error: messageForError(error), ok: false },
        statusForError(error),
      );
    }
  };
}

export default createHandler();
