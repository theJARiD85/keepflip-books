import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  BOOK_ACCOUNT,
  BookkeepingValidationError,
  isSyntheticInvalidTransactionExternalKey,
  postBookkeepingEvent,
} from './bookkeeping-domain.js';
import {
  normalizePlaidTransaction,
  plaidTransactionMemo,
  plaidTransactionSourceKey,
} from './plaid-domain.js';
import {
  ensureBookAccounts,
  getOwnedItem,
  itemUpdateForSale,
  persistEntry,
} from './main-core.js';
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
const REVIEW_POSTING_EVENT_TYPES = new Set([
  'advertising',
  'inventory_purchase',
  'marketplace_credit',
  'marketplace_fee',
  'mileage',
  'other_expense',
  'payout',
  'refund',
  'repair_parts',
  'sale',
  'shipping_label',
  'software',
  'storage',
  'supplies',
]);
const DEBIT_OR_CREDIT = new Set(['DEBIT', 'CREDIT']);
const REVIEW_MAX_QUANTITY = 100_000;
const PLAID_SYNC_MAX_PAGES = 8;
const PLAID_SOURCE = 'plaid';

// Keep the Books policy local to this deployment. Appwrite Functions run as
// isolated packages, so a protected Books request must not rely on a nested
// Subscription Police execution (or on a client-provided plan claim).
const BOOKS_CAPABILITY_BY_PATH = new Map([
  ['/overview', 'basic_books'],
  ['/record', 'basic_books'],
  ['/review/list', 'basic_books'],
  ['/review/detail', 'basic_books'],
  ['/review/resolve', 'basic_books'],
  ['/review/confirm', 'basic_books'],
  ['/review/post', 'basic_books'],
  ['/review/sourcing-trip', 'basic_books'],
  ['/ebay/sync', 'automated_books'],
  ['/plaid/link-token', 'automated_books'],
  ['/plaid/exchange', 'automated_books'],
  ['/plaid/status', 'automated_books'],
  ['/plaid/sync', 'automated_books'],
  ['/plaid/disconnect', 'automated_books'],
]);

const BOOKS_PLAN_FEATURES = {
  hobbyist: new Set(['basic_books']),
  serious: new Set(['basic_books', 'automated_books']),
  power: new Set(['basic_books', 'automated_books']),
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const PERIOD_ACCESS_STATUSES = new Set([
  'cancelled',
  'billing_issue',
  'grace_period',
]);

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
    accountsTableId: firstEnvironment(['APPWRITE_BOOK_ACCOUNTS_TABLE_ID'], 'book_accounts'),
    sourceEventsTableId: firstEnvironment(['APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID'], 'book_source_events'),
    sourcingTripsTableId: firstEnvironment(['APPWRITE_SOURCING_TRIPS_TABLE_ID'], 'sourcing_trips'),
    transactionsTableId: firstEnvironment(['APPWRITE_BOOK_TRANSACTIONS_TABLE_ID'], 'book_transactions'),
    journalLinesTableId: firstEnvironment(['APPWRITE_BOOK_JOURNAL_LINES_TABLE_ID'], 'book_journal_lines'),
    payoutsTableId: firstEnvironment(['APPWRITE_BOOK_PAYOUTS_TABLE_ID'], 'book_payouts'),
    itemsTableId: firstEnvironment(['APPWRITE_BOOK_ITEMS_TABLE_ID', 'APPWRITE_ITEMS_TABLE_ID'], 'items'),
    subscriptionsTableId: firstEnvironment(['APPWRITE_USER_SUBSCRIPTIONS_TABLE_ID'], 'user_subscriptions'),
    trialClaimsTableId: firstEnvironment(['APPWRITE_TRIAL_DEVICE_CLAIMS_TABLE_ID'], 'trial_device_claims'),
    plaidConnectionsTableId: firstEnvironment(['APPWRITE_PLAID_CONNECTIONS_TABLE_ID']),
    plaidTransactionsTableId: firstEnvironment(['APPWRITE_PLAID_TRANSACTIONS_TABLE_ID']),
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

function dateMs(value) {
  const parsed = Date.parse(text(value, 80));
  return Number.isFinite(parsed) ? parsed : 0;
}

function subscriptionAllowsBooksCapability(row, ownerId, capability, now = Date.now()) {
  if (ownerIdFromRow(row) !== ownerId) return false;

  const plan = text(row?.plan, 32).toLowerCase();
  const status = text(row?.status, 32).toLowerCase();
  const features = BOOKS_PLAN_FEATURES[plan];
  if (!features?.has(capability)) return false;

  const periodEnd = dateMs(row?.currentPeriodEndsAt);
  const active = ACTIVE_SUBSCRIPTION_STATUSES.has(status)
    ? !periodEnd || periodEnd > now
    : PERIOD_ACCESS_STATUSES.has(status)
      ? periodEnd > now
      : false;

  if (!active) return false;
  if (status === 'trialing' && row?.trialEndsAt && dateMs(row.trialEndsAt) <= now) {
    return false;
  }
  return true;
}

function trialClaimRowId(userId) {
  return (
    't' +
    createHash('sha256')
      .update(`keepflip|trial-device-claim|owner|${userId}`)
      .digest('hex')
      .slice(0, 35)
  );
}

async function requireBooksCapability({ capability, fetchImpl, now = Date.now(), req, runtime }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = tableConfiguration();
  const subscription = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: ownerId,
    runtime,
    tableId: configuration.subscriptionsTableId,
  });

  if (subscriptionAllowsBooksCapability(subscription, ownerId, capability, now)) {
    return ownerId;
  }

  // Profile trials are created by the authenticated /status request. Books
  // only reads that durable, server-owned claim; it can never create or extend
  // one while servicing a protected request.
  const trialClaim = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: trialClaimRowId(ownerId),
    runtime,
    tableId: configuration.trialClaimsTableId,
  });
  if (ownerIdFromRow(trialClaim) === ownerId && dateMs(trialClaim?.trialEndDate) > now) {
    return ownerId;
  }

  const featureLabel = capability === 'automated_books' ? 'Books automation' : 'Books';
  throw new ReviewHttpError(403, `An active KeepFlip subscription with ${featureLabel} is required.`);
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

function sourceEventRowId(ownerId, source, externalKey) {
  return stableId('book-source-event', ownerId, source, externalKey);
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

function positiveCents(value, field) {
  const amount = nonNegativeCents(value, field);
  if (amount === 0) {
    throw new ReviewHttpError(
      400,
      `${field} must be greater than zero before KeepFlip can create a Books record.`,
    );
  }
  return amount;
}

function reviewPostingEventType(value) {
  const eventType = text(value, 60).toLowerCase();
  if (!REVIEW_POSTING_EVENT_TYPES.has(eventType)) {
    throw new ReviewHttpError(
      400,
      'Choose how this transaction should be recorded before creating the Books record.',
    );
  }
  return eventType;
}

function reviewedDate(value) {
  const date = new Date(text(value, 80));
  if (!Number.isFinite(date.getTime())) {
    throw new ReviewHttpError(400, 'Transaction date and time must be a real date.');
  }
  return date.toISOString();
}

function reviewedBookingEntry(value) {
  const bookingEntry = text(value, 32).toUpperCase();
  if (!bookingEntry) return null;
  if (!DEBIT_OR_CREDIT.has(bookingEntry)) {
    throw new ReviewHttpError(400, 'Booking entry must be DEBIT, CREDIT, or left blank.');
  }
  return bookingEntry;
}

function reviewedTransactionType(value, fallback) {
  const transactionType = text(value, 80).toUpperCase() || text(fallback, 80).toUpperCase();
  if (!transactionType) {
    throw new ReviewHttpError(400, 'Enter the transaction type before creating the Books record.');
  }
  return transactionType;
}

function reviewedQuantity(value) {
  const quantity = value == null || value === '' ? 1 : Number(value);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > REVIEW_MAX_QUANTITY
  ) {
    throw new ReviewHttpError(
      400,
      `Quantity must be a whole number from 1 through ${REVIEW_MAX_QUANTITY.toLocaleString()}.`,
    );
  }
  return quantity;
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

function reviewDetailForRow(row, item = null, bookTransaction = null) {
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
    mileageMeters: base.mileageMeters,
    mileageRateCents: base.mileageRateCents,
    bookTransactionId: bookTransaction ? text(bookTransaction?.$id, 64) || null : null,
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

async function loadReviewBookTransaction({
  runtime,
  configuration,
  apiKey,
  ownerId,
  reviewRow,
  externalKey: externalKeyOverride,
  fetchImpl,
}) {
  const externalKey = text(externalKeyOverride, 255) || text(reviewRow?.externalKey, 255);
  if (!externalKey) return null;
  const source = text(reviewRow?.source, 80) || 'ebay_finances';
  const bookTransaction = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: transactionRowId(ownerId, source, externalKey),
    runtime,
    tableId: configuration.transactionsTableId,
  });
  return bookTransaction && ownerIdFromRow(bookTransaction) === ownerId
    ? bookTransaction
    : null;
}

async function deleteReviewSourceRow({ loaded, fetchImpl, runtime }) {
  const { apiKey, configuration, reviewId } = loaded;
  try {
    await appwriteJson({
      apiKey,
      failureMessage: 'KeepFlip could not remove the replaced invalid eBay review record.',
      fetchImpl,
      method: 'DELETE',
      path: rowPath(configuration, configuration.sourceEventsTableId, reviewId),
      runtime,
    });
    return true;
  } catch (error) {
    if (error instanceof ReviewUpstreamError && error.status === 404) return false;
    throw error;
  }
}

function plaidStorageConfiguration() {
  const configuration = tableConfiguration();
  const connectionsTableId = requiredEnvironment(
    ['APPWRITE_PLAID_CONNECTIONS_TABLE_ID'],
    'Missing APPWRITE_PLAID_CONNECTIONS_TABLE_ID for bank connections.',
  );
  const transactionsTableId = requiredEnvironment(
    ['APPWRITE_PLAID_TRANSACTIONS_TABLE_ID'],
    'Missing APPWRITE_PLAID_TRANSACTIONS_TABLE_ID for bank transactions.',
  );
  const encodedKey = requiredEnvironment(
    ['PLAID_TOKEN_ENCRYPTION_KEY'],
    'Missing PLAID_TOKEN_ENCRYPTION_KEY for bank connections.',
  );

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
    throw new ReviewHttpError(500, 'PLAID_TOKEN_ENCRYPTION_KEY must be a Base64 32-byte key.');
  }
  const encryptionKey = Buffer.from(encodedKey, 'base64');
  if (encryptionKey.length !== 32) {
    throw new ReviewHttpError(500, 'PLAID_TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  }

  return {
    ...configuration,
    encryptionKey,
    plaidConnectionsTableId: connectionsTableId,
    plaidTransactionsTableId: transactionsTableId,
  };
}

function plaidApiConfiguration() {
  const environment = firstEnvironment(['PLAID_ENV'], 'sandbox').toLowerCase();
  const baseUrl = {
    sandbox: 'https://sandbox.plaid.com',
    development: 'https://development.plaid.com',
    production: 'https://production.plaid.com',
  }[environment];
  if (!baseUrl) {
    throw new ReviewHttpError(500, 'PLAID_ENV must be sandbox, development, or production.');
  }

  const countryCodes = firstEnvironment(['PLAID_COUNTRY_CODES'], 'US')
    .split(',')
    .map((value) => text(value, 8).toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value));
  const daysRequestedValue = Number(firstEnvironment(['PLAID_TRANSACTIONS_DAYS_REQUESTED'], '90'));
  const daysRequested = Number.isSafeInteger(daysRequestedValue)
    ? Math.min(Math.max(daysRequestedValue, 30), 730)
    : 90;
  return {
    ...plaidStorageConfiguration(),
    androidPackageName: text(process.env.PLAID_ANDROID_PACKAGE_NAME, 255),
    baseUrl,
    clientId: requiredEnvironment(['PLAID_CLIENT_ID'], 'Missing PLAID_CLIENT_ID.'),
    countryCodes: countryCodes.length ? countryCodes : ['US'],
    daysRequested,
    environment,
    secret: requiredEnvironment(['PLAID_SECRET'], 'Missing PLAID_SECRET.'),
    webhookSecret: text(process.env.PLAID_WEBHOOK_SECRET, 255),
    webhookUrl: text(process.env.PLAID_WEBHOOK_URL, 1_000),
  };
}

function plaidWebRedirectUri(configuration) {
  const redirectUri = requiredEnvironment(
    ['PLAID_WEB_REDIRECT_URI'],
    'Missing PLAID_WEB_REDIRECT_URI for web Link sessions.',
  );
  let parsedRedirectUri;
  try {
    parsedRedirectUri = new URL(redirectUri);
  } catch {
    throw new ReviewHttpError(500, 'PLAID_WEB_REDIRECT_URI must be a valid absolute URI.');
  }
  if (parsedRedirectUri.search || parsedRedirectUri.hash || parsedRedirectUri.username || parsedRedirectUri.password) {
    throw new ReviewHttpError(500, 'PLAID_WEB_REDIRECT_URI must not contain query, fragment, or credentials.');
  }
  if (configuration.environment === 'production' && parsedRedirectUri.protocol !== 'https:') {
    throw new ReviewHttpError(500, 'PLAID_WEB_REDIRECT_URI must use HTTPS in production.');
  }
  return redirectUri;
}

async function plaidJson({ configuration, path, body, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${configuration.baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': configuration.clientId,
        'PLAID-SECRET': configuration.secret,
      },
      method: 'POST',
    });
  } catch {
    throw new ReviewUpstreamError(0, 'KeepFlip could not reach Plaid.');
  }

  const payload = await responseJson(response);
  if (!response.ok) {
    throw new ReviewUpstreamError(
      response.status,
      'Plaid could not complete that bank request.',
      text(payload?.error_code, 120),
    );
  }
  return payload;
}

function encryptPlaidSecret(value, key) {
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

function decryptPlaidSecret(value, key) {
  const [version, ivText, tagText, ciphertextText, ...extra] = String(value ?? '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText || extra.length > 0) {
    throw new ReviewHttpError(500, 'KeepFlip could not read the stored bank connection.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ReviewHttpError(500, 'KeepFlip could not read the stored bank connection.');
  }
}

function plaidConnectionRowId(ownerId, itemId) {
  return stableId('plaid-connection', ownerId, itemId);
}

function plaidTransactionRowId(ownerId, transactionId) {
  return stableId('plaid-transaction', ownerId, transactionId);
}

function jsonValue(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function safePlaidAccounts(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .slice(0, 50)
    .map((account) => ({
      id: text(account?.id, 180),
      mask: text(account?.mask, 8) || null,
      name: text(account?.name, 255) || null,
      subtype: text(account?.subtype, 80) || null,
      type: text(account?.type, 80) || null,
    }))
    .filter((account) => account.id);
}

function webhookUrlWithSecret(url, secret) {
  if (!url || !secret) return url;
  return `${url}${url.includes('?') ? '&' : '?'}secret=${encodeURIComponent(secret)}`;
}

function requestQuery(req, name) {
  const raw = text(req?.path || req?.url || '/', 4_000);
  try {
    return text(new URL(raw, 'https://keepflip.invalid').searchParams.get(name), 255);
  } catch {
    return '';
  }
}

function webhookSecretMatches(expected, received) {
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function listPlaidConnections({ apiKey, configuration, fetchImpl, ownerId, runtime }) {
  const payload = await appwriteJson({
    apiKey,
    failureMessage: 'KeepFlip could not read your connected bank accounts.',
    fetchImpl,
    path: listRowsPath(configuration, configuration.plaidConnectionsTableId, [
      createQuery('equal', 'ownerId', [ownerId]),
      createQuery('limit', '', [100]),
    ]),
    runtime,
  });
  return (Array.isArray(payload?.rows) ? payload.rows : []).filter(
    (row) => ownerIdFromRow(row) === ownerId && text(row?.status, 40) !== 'disconnected',
  );
}

async function findPlaidConnectionByItemId({ apiKey, configuration, fetchImpl, itemId, runtime }) {
  const payload = await appwriteJson({
    apiKey,
    failureMessage: 'KeepFlip could not find the bank connection.',
    fetchImpl,
    path: listRowsPath(configuration, configuration.plaidConnectionsTableId, [
      createQuery('equal', 'itemId', [itemId]),
      createQuery('limit', '', [1]),
    ]),
    runtime,
  });
  return Array.isArray(payload?.rows) ? payload.rows[0] || null : null;
}

function plaidConnectionSummary(row) {
  return {
    accounts: safePlaidAccounts(jsonValue(row?.accountsJson, [])),
    connectionId: text(row?.$id, 64),
    institutionId: text(row?.institutionId, 180) || null,
    institutionName: text(row?.institutionName, 255) || 'Connected bank',
    itemId: text(row?.itemId, 180),
    lastError: text(row?.lastSyncError, 500) || null,
    lastSyncedAt: text(row?.lastSyncedAt, 80) || null,
    status: text(row?.status, 40) || 'connected',
  };
}

async function savePlaidConnection({ apiKey, configuration, data, existing, fetchImpl, rowId, runtime }) {
  if (existing) {
    await appwriteJson({
      apiKey,
      body: { data },
      failureMessage: 'KeepFlip could not update the bank connection.',
      fetchImpl,
      method: 'PATCH',
      path: rowPath(configuration, configuration.plaidConnectionsTableId, rowId),
      runtime,
    });
    return;
  }

  await appwriteJson({
    apiKey,
    body: { data, rowId },
    failureMessage: 'KeepFlip could not save the bank connection.',
    fetchImpl,
    method: 'POST',
    path: tableRowsPath(configuration, configuration.plaidConnectionsTableId),
    runtime,
  });
}

async function savePlaidTransaction({ apiKey, configuration, data, existing, fetchImpl, rowId, runtime }) {
  if (existing) {
    await appwriteJson({
      apiKey,
      body: { data },
      failureMessage: 'KeepFlip could not update an imported bank transaction.',
      fetchImpl,
      method: 'PATCH',
      path: rowPath(configuration, configuration.plaidTransactionsTableId, rowId),
      runtime,
    });
    return;
  }

  await appwriteJson({
    apiKey,
    body: { data, rowId },
    failureMessage: 'KeepFlip could not save an imported bank transaction.',
    fetchImpl,
    method: 'POST',
    path: tableRowsPath(configuration, configuration.plaidTransactionsTableId),
    runtime,
  });
}

async function handlePlaidLinkToken({ req, res, runtime, fetchImpl }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const configuration = plaidApiConfiguration();
  const platform = text(requestBody(req).platform, 20);
  if (platform !== 'android' && platform !== 'web') {
    throw new ReviewHttpError(400, 'Plaid Link platform must be android or web.');
  }
  let platformParameters;
  if (platform === 'android') {
    if (!configuration.androidPackageName) {
      throw new ReviewHttpError(500, 'Missing PLAID_ANDROID_PACKAGE_NAME for Android Link sessions.');
    }
    platformParameters = { android_package_name: configuration.androidPackageName };
  } else {
    platformParameters = { redirect_uri: plaidWebRedirectUri(configuration) };
  }
  const payload = await plaidJson({
    body: {
      client_name: 'KeepFlip',
      country_codes: configuration.countryCodes,
      language: 'en',
      products: ['transactions'],
      ...platformParameters,
      transactions: { days_requested: configuration.daysRequested },
      user: { client_user_id: ownerId },
      ...(configuration.webhookUrl
        ? { webhook: webhookUrlWithSecret(configuration.webhookUrl, configuration.webhookSecret) }
        : {}),
    },
    configuration,
    fetchImpl,
    path: '/link/token/create',
  });
  const linkToken = text(payload?.link_token, 4_096);
  if (!linkToken) {
    throw new ReviewHttpError(502, 'Plaid did not return a bank-link token.');
  }

  return res.json({
    automationEnabled: Boolean(configuration.webhookUrl),
    expiration: text(payload?.expiration, 80) || null,
    linkToken,
    ok: true,
  });
}

async function handlePlaidExchange({ req, res, runtime, fetchImpl, now }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = plaidApiConfiguration();
  const body = requestBody(req);
  const publicToken = text(body.publicToken, 4_096);
  if (!publicToken) throw new ReviewHttpError(400, 'Plaid did not return a public token.');

  const payload = await plaidJson({
    body: { public_token: publicToken },
    configuration,
    fetchImpl,
    path: '/item/public_token/exchange',
  });
  const accessToken = text(payload?.access_token, 8_000);
  const itemId = text(payload?.item_id, 180);
  if (!accessToken || !itemId) {
    throw new ReviewHttpError(502, 'Plaid did not return a usable bank connection.');
  }

  const institution = body.institution && typeof body.institution === 'object'
    ? body.institution
    : {};
  const institutionId = text(institution.id, 180) || null;
  const institutionName = text(institution.name, 255) || 'Connected bank';
  const accounts = safePlaidAccounts(body.accounts);
  const rowId = plaidConnectionRowId(ownerId, itemId);
  const existing = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId,
    runtime,
    tableId: configuration.plaidConnectionsTableId,
  });
  const data = {
    accountsJson: JSON.stringify(accounts),
    createdAt: text(existing?.createdAt, 80) || now,
    cursor: text(existing?.cursor, 4_096) || null,
    institutionId,
    institutionName,
    itemId,
    lastSyncError: null,
    lastSyncedAt: text(existing?.lastSyncedAt, 80) || null,
    ownerId,
    status: 'connected',
    tokenCiphertext: encryptPlaidSecret(accessToken, configuration.encryptionKey),
    updatedAt: now,
  };
  await savePlaidConnection({
    apiKey,
    configuration,
    data,
    existing,
    fetchImpl,
    rowId,
    runtime,
  });

  return res.json({
    accounts,
    connection: {
      accounts,
      connectionId: rowId,
      institutionId,
      institutionName,
      itemId,
      lastSyncedAt: data.lastSyncedAt,
      status: 'connected',
    },
    ok: true,
  });
}

async function handlePlaidStatus({ req, res, runtime, fetchImpl }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = plaidStorageConfiguration();
  const rows = await listPlaidConnections({
    apiKey,
    configuration,
    fetchImpl,
    ownerId,
    runtime,
  });
  return res.json({
    automationEnabled: Boolean(text(process.env.PLAID_WEBHOOK_URL, 1_000)),
    connections: rows.map(plaidConnectionSummary),
    ok: true,
  });
}

function plaidTransactionData({ connection, existing, normalized, status, bookTransactionId, now, removedAt = null }) {
  return {
    accountId: normalized.accountId || text(existing?.accountId, 180) || null,
    accountMask: normalized.accountMask || text(existing?.accountMask, 8) || null,
    accountName: normalized.accountName || text(existing?.accountName, 255) || null,
    amountCents: normalized.amountCents,
    authorizedAt: normalized.authorizedAt || text(existing?.authorizedAt, 80) || null,
    categoryDetailed: normalized.categoryDetailed || text(existing?.categoryDetailed, 160) || null,
    categoryPrimary: normalized.categoryPrimary || text(existing?.categoryPrimary, 120) || null,
    connectionId: text(connection?.$id, 64),
    createdAt: text(existing?.createdAt, 80) || now,
    currency: normalized.currency,
    merchantName: normalized.merchantName || text(existing?.merchantName, 255) || null,
    name: normalized.name || text(existing?.name, 255) || 'Bank transaction',
    occurredAt: normalized.occurredAt,
    ownerId: text(connection?.ownerId, 64),
    pending: normalized.pending,
    plaidTransactionId: normalized.transactionId,
    removedAt,
    syncStatus: status,
    transactionCode: normalized.transactionCode || text(existing?.transactionCode, 80) || null,
    bookTransactionId: bookTransactionId || text(existing?.bookTransactionId, 64) || null,
    updatedAt: now,
  };
}

async function processPlaidTransaction({ apiKey, configuration, connection, fetchImpl, now, raw, runtime }) {
  const accounts = safePlaidAccounts(jsonValue(connection?.accountsJson, []));
  const account = accounts.find((candidate) => candidate.id === text(raw?.account_id, 180)) || null;
  const normalized = normalizePlaidTransaction(raw, account, now);
  if (!normalized) return { imported: 0, needsReview: 0, pending: 0, ignored: 1, updated: 0 };

  const rowId = plaidTransactionRowId(connection.ownerId, normalized.transactionId);
  const existing = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId,
    runtime,
    tableId: configuration.plaidTransactionsTableId,
  });
  let bookTransactionId = text(existing?.bookTransactionId, 64) || null;
  let status = normalized.pending ? 'pending' : 'ignored';
  let imported = 0;
  let needsReview = 0;

  if (bookTransactionId && !normalized.isExpenseCandidate) {
    status = 'needs_review';
    needsReview = 1;
  } else if (normalized.isExpenseCandidate) {
    if (bookTransactionId) {
      const amountChanged = Number(existing?.amountCents) !== normalized.amountCents;
      const currencyChanged = text(existing?.currency, 8).toUpperCase() !== normalized.currency;
      status = amountChanged || currencyChanged ? 'needs_review' : 'posted';
      needsReview = status === 'needs_review' ? 1 : 0;
    } else {
      await ensureBookAccounts({
        apiKey,
        configuration,
        fetchImpl,
        now,
        ownerId: connection.ownerId,
        runtime,
      });
      const memo = plaidTransactionMemo(normalized);
      const entry = postBookkeepingEvent({
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        eventType: 'other_expense',
        notes: memo,
        occurredAt: normalized.occurredAt,
        sourceKey: plaidTransactionSourceKey(normalized.transactionId),
        summary: normalized.merchantName || normalized.name,
      });
      const result = await persistEntry({
        apiKey,
        configuration,
        entry,
        externalKey: normalized.transactionId,
        fetchImpl,
        now,
        ownerId: connection.ownerId,
        runtime,
        source: PLAID_SOURCE,
      });
      bookTransactionId = result.bookTransactionId;
      status = 'posted';
      imported = result.status === 'already_recorded' ? 0 : 1;
    }
  }

  await savePlaidTransaction({
    apiKey,
    configuration,
    data: plaidTransactionData({
      bookTransactionId,
      connection,
      existing,
      normalized,
      now,
      status,
    }),
    existing,
    fetchImpl,
    rowId,
    runtime,
  });
  return {
    ignored: status === 'ignored' ? 1 : 0,
    imported,
    needsReview,
    pending: status === 'pending' ? 1 : 0,
    updated: existing ? 1 : 0,
  };
}

async function processPlaidRemovedTransaction({ apiKey, configuration, connection, fetchImpl, now, raw, runtime }) {
  const transactionId = text(raw?.transaction_id, 180);
  if (!transactionId) return { needsReview: 0, removed: 0 };
  const rowId = plaidTransactionRowId(connection.ownerId, transactionId);
  const existing = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId,
    runtime,
    tableId: configuration.plaidTransactionsTableId,
  });
  if (!existing) return { needsReview: 0, removed: 0 };

  const hasPostedBookTransaction = Boolean(text(existing.bookTransactionId, 64));
  await savePlaidTransaction({
    apiKey,
    configuration,
    data: {
      removedAt: now,
      syncStatus: hasPostedBookTransaction ? 'needs_review' : 'removed',
      updatedAt: now,
    },
    existing,
    fetchImpl,
    rowId,
    runtime,
  });
  return {
    needsReview: hasPostedBookTransaction ? 1 : 0,
    removed: 1,
  };
}

async function syncPlaidConnection({ apiKey, configuration, connection, fetchImpl, now, runtime }) {
  const encryptedToken = text(connection?.tokenCiphertext, 12_000);
  const accessToken = decryptPlaidSecret(encryptedToken, configuration.encryptionKey);
  let cursor = text(connection?.cursor, 4_096) || null;
  let hasMore = true;
  let pages = 0;
  const totals = {
    ignored: 0,
    imported: 0,
    needsReview: 0,
    pending: 0,
    removed: 0,
    updated: 0,
  };

  while (hasMore && pages < PLAID_SYNC_MAX_PAGES) {
    const payload = await plaidJson({
      body: {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
      },
      configuration,
      fetchImpl,
      path: '/transactions/sync',
    });
    const added = Array.isArray(payload?.added) ? payload.added : [];
    const modified = Array.isArray(payload?.modified) ? payload.modified : [];
    const removed = Array.isArray(payload?.removed) ? payload.removed : [];
    for (const raw of [...added, ...modified]) {
      const result = await processPlaidTransaction({
        apiKey,
        configuration,
        connection,
        fetchImpl,
        now,
        raw,
        runtime,
      });
      for (const key of Object.keys(totals)) totals[key] += result[key] || 0;
    }
    for (const raw of removed) {
      const result = await processPlaidRemovedTransaction({
        apiKey,
        configuration,
        connection,
        fetchImpl,
        now,
        raw,
        runtime,
      });
      totals.needsReview += result.needsReview;
      totals.removed += result.removed;
    }
    const nextCursor = text(payload?.next_cursor, 4_096);
    hasMore = payload?.has_more === true;
    if (hasMore && !nextCursor) {
      throw new ReviewHttpError(502, 'Plaid returned an incomplete transaction cursor.');
    }
    cursor = nextCursor || cursor;
    pages += 1;
  }

  await appwriteJson({
    apiKey,
    body: {
      data: {
        cursor,
        lastSyncError: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    },
    failureMessage: 'KeepFlip could not save the bank sync cursor.',
    fetchImpl,
    method: 'PATCH',
    path: rowPath(configuration, configuration.plaidConnectionsTableId, connection.$id),
    runtime,
  });
  return { ...totals, hasMore, pages };
}

async function handlePlaidSync({ req, res, runtime, fetchImpl, now }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = plaidApiConfiguration();
  const requestedConnectionId = text(requestBody(req).connectionId, 64);
  const rows = await listPlaidConnections({
    apiKey,
    configuration,
    fetchImpl,
    ownerId,
    runtime,
  });
  const connections = requestedConnectionId
    ? rows.filter((row) => text(row?.$id, 64) === requestedConnectionId)
    : rows;
  if (requestedConnectionId && !connections.length) {
    throw new ReviewHttpError(404, 'That bank connection is no longer available.');
  }

  const totals = {
    connections: 0,
    failedConnections: 0,
    hasMore: false,
    ignored: 0,
    imported: 0,
    needsReview: 0,
    pending: 0,
    removed: 0,
    updated: 0,
  };
  const errors = [];
  for (const connection of connections) {
    try {
      const result = await syncPlaidConnection({
        apiKey,
        configuration,
        connection,
        fetchImpl,
        now,
        runtime,
      });
      totals.connections += 1;
      totals.hasMore ||= result.hasMore;
      for (const key of ['ignored', 'imported', 'needsReview', 'pending', 'removed', 'updated']) {
        totals[key] += result[key] || 0;
      }
    } catch (error) {
      totals.failedConnections += 1;
      errors.push(text(error instanceof Error ? error.message : 'Bank sync failed.', 255));
      await appwriteJson({
        apiKey,
        body: { data: { lastSyncError: errors[errors.length - 1], updatedAt: now } },
        failureMessage: 'KeepFlip could not record the bank sync error.',
        fetchImpl,
        method: 'PATCH',
        path: rowPath(configuration, configuration.plaidConnectionsTableId, connection.$id),
        runtime,
      }).catch(() => undefined);
    }
  }
  return res.json({ ...totals, errors, ok: true });
}

async function handlePlaidDisconnect({ req, res, runtime, fetchImpl, now }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = plaidApiConfiguration();
  const body = requestBody(req);
  const requestedConnectionId = text(body.connectionId, 64);
  const rows = await listPlaidConnections({
    apiKey,
    configuration,
    fetchImpl,
    ownerId,
    runtime,
  });
  const connection = rows.find((row) =>
    requestedConnectionId
      ? text(row?.$id, 64) === requestedConnectionId
      : text(row?.itemId, 180) === text(body.itemId, 180),
  );
  if (!connection) throw new ReviewHttpError(404, 'That bank connection is no longer available.');

  const accessToken = decryptPlaidSecret(text(connection.tokenCiphertext, 12_000), configuration.encryptionKey);
  await plaidJson({
    body: { access_token: accessToken },
    configuration,
    fetchImpl,
    path: '/item/remove',
  });
  await appwriteJson({
    apiKey,
    body: {
      data: {
        disconnectedAt: now,
        lastSyncError: null,
        status: 'disconnected',
        tokenCiphertext: '',
        updatedAt: now,
      },
    },
    failureMessage: 'KeepFlip could not save the disconnected bank state.',
    fetchImpl,
    method: 'PATCH',
    path: rowPath(configuration, configuration.plaidConnectionsTableId, connection.$id),
    runtime,
  });
  return res.json({ connectionId: connection.$id, ok: true });
}

async function handlePlaidWebhook({ req, res, runtime, fetchImpl, now }) {
  const configuration = plaidApiConfiguration();
  if (!webhookSecretMatches(configuration.webhookSecret, requestQuery(req, 'secret'))) {
    throw new ReviewHttpError(401, 'Plaid webhook verification failed.');
  }

  const itemId = text(requestBody(req).item_id, 180);
  if (!itemId) return res.json({ ignored: true, ok: true });
  const apiKey = dynamicApiKey(req);
  const connection = await findPlaidConnectionByItemId({
    apiKey,
    configuration,
    fetchImpl,
    itemId,
    runtime,
  });
  if (!connection || text(connection.status, 40) === 'disconnected') {
    return res.json({ ignored: true, ok: true });
  }
  const result = await syncPlaidConnection({
    apiKey,
    configuration,
    connection,
    fetchImpl,
    now,
    runtime,
  });
  return res.json({ ...result, ok: true });
}

function positiveMileageRateCents(value) {
  const rateCents = positiveCents(value, 'Mileage rate');
  if (rateCents > 100_000) {
    throw new ReviewHttpError(400, 'Mileage rate must be no more than $1,000.00 per mile.');
  }
  return rateCents;
}

function mileageExpenseCents(mileageMeters, mileageRateCents) {
  // 1 mile is 1,609.344 meters. Keep the calculation in integer arithmetic
  // until the final cent is rounded so a client-provided amount cannot change
  // the recorded trip distance or introduce floating-point money values.
  const amountCents = Math.round((mileageMeters * mileageRateCents * 1_000) / 1_609_344);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new ReviewHttpError(
      400,
      'The recorded mileage and rate must produce a positive Books amount.',
    );
  }
  return amountCents;
}

function sourcingTripMiles(mileageMeters) {
  return (mileageMeters / 1_609.344).toFixed(1);
}

function sourcingTripReviewReason(mileageMeters) {
  return `This sourcing trip recorded ${sourcingTripMiles(mileageMeters)} miles. Choose the applicable mileage rate before posting it to Books.`;
}

async function handleSourcingTripReview({ req, res, runtime, fetchImpl, now }) {
  const ownerId = await authenticatedUserId({ fetchImpl, req, runtime });
  const apiKey = dynamicApiKey(req);
  const configuration = tableConfiguration();
  const body = requestBody(req);
  const sourceTripId = text(body.sourceTripId, 64);
  if (!sourceTripId) {
    throw new ReviewHttpError(400, 'Choose the sourcing trip whose mileage needs review.');
  }

  const trip = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: sourceTripId,
    runtime,
    tableId: configuration.sourcingTripsTableId,
  });
  if (!trip || ownerIdFromRow(trip) !== ownerId) {
    throw new ReviewHttpError(404, 'That sourcing trip is no longer available.');
  }
  if (text(trip.status, 32) !== 'closed') {
    throw new ReviewHttpError(409, 'Close the sourcing trip before reviewing its mileage.');
  }

  const mileageMeters = Number(trip.mileageMeters);
  if (!Number.isSafeInteger(mileageMeters) || mileageMeters <= 0) {
    throw new ReviewHttpError(409, 'This sourcing trip does not contain usable recorded mileage.');
  }

  const source = 'sourcing_trip';
  const sourceType = 'sourcing_trip_mileage';
  const reviewId = sourceEventRowId(ownerId, source, sourceTripId);
  const existing = await getRowOrNull({
    apiKey,
    configuration,
    fetchImpl,
    rowId: reviewId,
    runtime,
    tableId: configuration.sourceEventsTableId,
  });
  if (existing) {
    return res.json({
      alreadyQueued: true,
      mileageMeters,
      ok: true,
      reviewId,
      sourceTripId,
      status: text(existing.eventStatus, 40) || 'needs_review',
    });
  }

  const occurredAt = text(trip.closedAt, 80) || text(trip.startedAt, 80) || now;
  const sourceName = text(trip.label, 160) || text(trip.sourceName, 120) || 'Sourcing trip';
  const transactionMemo = `Sourcing trip: ${sourceName} · ${sourcingTripMiles(mileageMeters)} miles tracked. Choose a rate before posting.`;
  const data = {
    amountCents: 0,
    createdAt: now,
    currency: 'USD',
    eventStatus: 'needs_review',
    externalKey: sourceTripId,
    itemId: null,
    occurredAt,
    orderId: null,
    ownerId,
    payloadDigest: createHash('sha256')
      .update(JSON.stringify({ mileageMeters, occurredAt, ownerId, source, sourceTripId }), 'utf8')
      .digest('hex'),
    payoutId: null,
    rawTransactionType: 'SOURCING_TRIP_MILEAGE',
    reviewReason: sourcingTripReviewReason(mileageMeters),
    source,
    sourceType,
    transactionMemo,
    mileageMeters,
  };

  try {
    await appwriteJson({
      apiKey,
      body: { data, rowId: reviewId },
      failureMessage: 'KeepFlip could not queue the sourcing-trip mileage review.',
      fetchImpl,
      method: 'POST',
      path: tableRowsPath(configuration, configuration.sourceEventsTableId),
      runtime,
    });
  } catch (error) {
    // A retry can race with the original close request. The deterministic row
    // ID makes that safe; return the row that won the race if Appwrite rejects
    // the duplicate create.
    if (error instanceof ReviewUpstreamError && error.status === 409) {
      const raced = await getRowOrNull({
        apiKey,
        configuration,
        fetchImpl,
        rowId: reviewId,
        runtime,
        tableId: configuration.sourceEventsTableId,
      });
      if (raced) {
        return res.json({
          alreadyQueued: true,
          mileageMeters,
          ok: true,
          reviewId,
          sourceTripId,
          status: text(raced.eventStatus, 40) || 'needs_review',
        });
      }
    }
    throw error;
  }

  return res.json({
    alreadyQueued: false,
    mileageMeters,
    ok: true,
    reviewId,
    sourceTripId,
    status: 'needs_review',
  });
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
    .filter((row) => {
      const eventStatus = text(row?.eventStatus, 40);
      const recoverableConfirmedEbayImport =
        text(row?.source, 80) === 'ebay_finances' &&
        (eventStatus === 'review_confirmed' || isFallbackConfirmedReviewRow(row));

      // Earlier Function versions treated a review confirmation as completion,
      // even though they did not create a Books transaction or journal lines.
      // Keep those legacy eBay imports reachable so the user can post one
      // linked, idempotent Books record after checking its details.
      return OPEN_REVIEW_STATUSES.has(eventStatus) || recoverableConfirmedEbayImport;
    })
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
  const [item, bookTransaction] = await Promise.all([
    loadReviewItem({
      ...loaded,
      fetchImpl,
      runtime,
    }),
    loadReviewBookTransaction({
      ...loaded,
      fetchImpl,
      runtime,
    }),
  ]);
  return res.json({
    item: reviewDetailForRow(loaded.reviewRow, item, bookTransaction),
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

async function postReviewedSourcingTripMileage({ loaded, runtime, fetchImpl, now }) {
  const { apiKey, body, configuration, ownerId, reviewId, reviewRow } = loaded;
  const source = text(reviewRow?.source, 80);
  const sourceType = text(reviewRow?.sourceType, 80).toLowerCase();
  if (source !== 'sourcing_trip' || sourceType !== 'sourcing_trip_mileage') {
    throw new ReviewHttpError(409, 'This is not a sourcing-trip mileage review.');
  }

  const status = text(reviewRow?.eventStatus, 40);
  if (!OPEN_REVIEW_STATUSES.has(status) && status !== 'review_confirmed') {
    throw new ReviewHttpError(409, 'That sourcing-trip mileage review can no longer be posted.');
  }

  const sourceTripId = text(reviewRow?.externalKey, 255);
  if (!sourceTripId) {
    throw new ReviewHttpError(409, 'This sourcing-trip mileage review has no trip ID to link to Books.');
  }

  const existingTransaction = await loadReviewBookTransaction({
    ...loaded,
    fetchImpl,
    runtime,
  });
  if (existingTransaction) {
    return {
      alreadyRecorded: true,
      bookTransactionId: text(existingTransaction.$id, 64),
      replacedInvalidReview: false,
      status: 'posted',
    };
  }

  const mileageMeters = Number(reviewRow?.mileageMeters);
  if (!Number.isSafeInteger(mileageMeters) || mileageMeters <= 0) {
    throw new ReviewHttpError(409, 'The saved sourcing trip does not contain usable mileage.');
  }
  if (text(body.eventType, 60).toLowerCase() !== 'mileage') {
    throw new ReviewHttpError(400, 'Record this sourcing-trip review as mileage.');
  }

  const mileageRateCents = positiveMileageRateCents(body.mileageRateCents);
  const amountCents = mileageExpenseCents(mileageMeters, mileageRateCents);
  const currency = normalizedCurrency(body.currency, 'USD');
  if (currency !== 'USD') {
    throw new ReviewHttpError(400, 'Sourcing-trip mileage must be posted in USD.');
  }
  const occurredAt = reviewedDate(body.occurredAt || reviewRow?.occurredAt);
  const defaultMemo = `Sourcing trip mileage · ${sourcingTripMiles(mileageMeters)} miles at $${(mileageRateCents / 100).toFixed(2)} per mile`;
  const transactionMemo = text(body.transactionMemo, 1_000) || defaultMemo;

  let entry;
  try {
    entry = postBookkeepingEvent({
      amountCents,
      currency,
      eventType: 'mileage',
      notes: transactionMemo,
      occurredAt,
      sourceKey: `sourcing_trip:reviewed:${sourceTripId}`,
      summary: 'Sourcing trip mileage',
    });
  } catch (error) {
    if (error instanceof BookkeepingValidationError) {
      throw new ReviewHttpError(400, error.message);
    }
    throw error;
  }

  await ensureBookAccounts({ apiKey, configuration, fetchImpl, now, ownerId, runtime });
  const result = await persistEntry({
    apiKey,
    configuration,
    entry,
    externalKey: sourceTripId,
    fetchImpl,
    now,
    ownerId,
    runtime,
    source,
    sourceEventPatch: {
      bookingEntry: 'DEBIT',
      mileageMeters,
      mileageRateCents,
      rawTransactionType: 'SOURCING_TRIP_MILEAGE',
      reviewReason: `User reviewed and posted ${sourcingTripMiles(mileageMeters)} sourcing-trip miles at $${(mileageRateCents / 100).toFixed(2)} per mile.`,
      reviewUpdatedAt: now,
      sourceType,
      transactionMemo,
    },
  });

  return {
    alreadyRecorded: result.status === 'already_recorded',
    bookTransactionId: result.bookTransactionId,
    replacedInvalidReview: false,
    status: 'posted',
  };
}

function reviewPostingSummary(eventType) {
  return `Reviewed eBay ${eventType.replace(/_/g, ' ')}`;
}

async function postReviewedEbayRecord({ loaded, runtime, fetchImpl, now }) {
  const { apiKey, body, configuration, ownerId, reviewRow } = loaded;
  const source = text(reviewRow?.source, 80);
  if (source !== 'ebay_finances') {
    throw new ReviewHttpError(409, 'Only imported eBay transactions can be posted from this review.');
  }

  const importedExternalKey = text(reviewRow?.externalKey, 255);
  if (!importedExternalKey) {
    throw new ReviewHttpError(409, 'This eBay import has no transaction ID to link to a Books record.');
  }
  const replacingInvalidImport = isSyntheticInvalidTransactionExternalKey(importedExternalKey);
  const replacementExternalKey = replacingInvalidImport
    ? text(body.replacementExternalKey, 180)
    : '';
  if (replacingInvalidImport && (!replacementExternalKey || isSyntheticInvalidTransactionExternalKey(replacementExternalKey))) {
    throw new ReviewHttpError(
      409,
      'This eBay import is missing its real transaction ID. Run Money Sync again, or enter the corrected eBay transaction ID before posting it.',
    );
  }
  const externalKey = replacingInvalidImport ? replacementExternalKey : importedExternalKey;

  const status = isFallbackConfirmedReviewRow(reviewRow)
    ? 'review_confirmed'
    : text(reviewRow?.eventStatus, 40);
  if (status === 'needs_item_cost') {
    throw new ReviewHttpError(
      409,
      'This sale already has a Books record. Confirm its original item cost instead of rewriting the posted sale.',
    );
  }
  if (!['needs_item_match', 'needs_review', 'review_confirmed'].includes(status)) {
    throw new ReviewHttpError(409, 'That transaction can no longer be posted from review.');
  }

  const existingTransaction = await loadReviewBookTransaction({
    ...loaded,
    externalKey,
    fetchImpl,
    runtime,
  });
  if (existingTransaction) {
    if (replacingInvalidImport) {
      const removed = await deleteReviewSourceRow({ fetchImpl, loaded, runtime });
      if (!removed) {
        throw new ReviewHttpError(
          409,
          'The corrected Books record already exists, but the invalid review placeholder is no longer available to remove.',
        );
      }
    }
    return {
      alreadyRecorded: true,
      bookTransactionId: text(existingTransaction.$id, 64),
      replacedInvalidReview: replacingInvalidImport,
      status: 'posted',
    };
  }

  const eventType = reviewPostingEventType(body.eventType);
  const amountCents = positiveCents(body.amountCents, 'Transaction amount');
  const currency = normalizedCurrency(body.currency, reviewRow?.currency);
  const occurredAt = reviewedDate(body.occurredAt || reviewRow?.occurredAt);
  const transactionType = reviewedTransactionType(
    body.transactionType,
    reviewRow?.rawTransactionType || reviewRow?.sourceType,
  );
  const bookingEntry = reviewedBookingEntry(body.bookingEntry);
  const orderId = text(body.orderId, 180) || null;
  const requestedPayoutId = text(body.payoutId, 180) || null;
  const payoutId = eventType === 'payout' ? requestedPayoutId || externalKey : requestedPayoutId;
  const transactionMemo = text(body.transactionMemo, 1_000) || null;
  const requestedItemId = text(body.itemId, 64) || null;
  let entry;
  let itemUpdate;

  try {
    if (eventType === 'sale') {
      if (!requestedItemId) {
        throw new ReviewHttpError(400, 'Choose the KeepFlip inventory item that actually sold.');
      }
      const item = await getOwnedItem({
        apiKey,
        configuration,
        fetchImpl,
        itemId: requestedItemId,
        ownerId,
        runtime,
      });
      const sale = inventorySaleState(item, reviewedQuantity(body.quantity));
      entry = postBookkeepingEvent({
        costCents: sale.costCents,
        currency,
        eventType,
        feeCents: nonNegativeCents(body.feeCents ?? 0, 'Marketplace fees'),
        grossSaleCents: amountCents,
        itemId: requestedItemId,
        marketplaceCollectedTaxCents: nonNegativeCents(
          body.marketplaceCollectedTaxCents ?? 0,
          'Marketplace-collected tax',
        ),
        notes: transactionMemo,
        occurredAt,
        sourceKey: `ebay_finances:reviewed:${externalKey}`,
        summary: reviewPostingSummary(eventType),
      });
      itemUpdate = itemUpdateForSale({
        externalKey,
        occurredAt,
        orderId,
        ownerId,
        sale,
        source,
        now,
      });
    } else {
      if (eventType === 'inventory_purchase' && !requestedItemId) {
        throw new ReviewHttpError(400, 'Choose the KeepFlip inventory item for this purchase.');
      }
      if (requestedItemId) {
        await getOwnedItem({
          apiKey,
          configuration,
          fetchImpl,
          itemId: requestedItemId,
          ownerId,
          runtime,
        });
      }
      entry = postBookkeepingEvent({
        amountCents,
        currency,
        eventType,
        itemId: requestedItemId,
        notes: transactionMemo,
        occurredAt,
        sourceKey: `ebay_finances:reviewed:${externalKey}`,
        summary: reviewPostingSummary(eventType),
      });
      if (eventType === 'inventory_purchase' && requestedItemId) {
        itemUpdate = {
          bookPurchaseTransactionId: transactionRowId(ownerId, source, externalKey),
          updatedAt: now,
        };
      }
    }
  } catch (error) {
    if (error instanceof ReviewHttpError) throw error;
    if (error instanceof BookkeepingValidationError) {
      throw new ReviewHttpError(400, error.message);
    }
    throw error;
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
    orderId,
    ownerId,
    payoutId,
    runtime,
    source,
    sourceEventPatch: {
      bookingEntry,
      rawTransactionType: transactionType,
      reviewReason: `User corrected and posted this eBay import as ${eventType.replace(/_/g, ' ')}.`,
      reviewUpdatedAt: now,
      transactionMemo,
    },
  });
  if (replacingInvalidImport) {
    const removed = await deleteReviewSourceRow({ fetchImpl, loaded, runtime });
    if (!removed) {
      throw new ReviewHttpError(
        409,
        'The corrected Books record was created, but the invalid review placeholder is no longer available to remove. Please contact support with the corrected eBay transaction ID.',
      );
    }
  }
  return {
    alreadyRecorded: result.status === 'already_recorded',
    bookTransactionId: result.bookTransactionId,
    replacedInvalidReview: replacingInvalidImport,
    status: result.status,
  };
}

async function handleReviewPost({ req, res, runtime, fetchImpl, now }) {
  const loaded = await loadOwnedReview({ fetchImpl, req, runtime });
  const result = text(loaded.reviewRow?.source, 80) === 'sourcing_trip'
    ? await postReviewedSourcingTripMileage({ fetchImpl, loaded, now, runtime })
    : await postReviewedEbayRecord({ fetchImpl, loaded, now, runtime });
  return res.json({ ...result, ok: true });
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
  const authorizeBooksCapability =
    typeof options.authorizeBooksCapability === 'function'
      ? options.authorizeBooksCapability
      : requireBooksCapability;

  return async (context) => {
    const method = text(context?.req?.method, 16).toUpperCase();
    const path = requestPath(context?.req);

    try {
      const runtime = runtimeConfiguration();
      const capability = method === 'POST' ? BOOKS_CAPABILITY_BY_PATH.get(path) : null;
      if (capability) {
        await authorizeBooksCapability({
          capability,
          fetchImpl,
          now: new Date(nowProvider()).getTime(),
          req: context.req,
          runtime,
        });
      }
      if (method === 'POST' && path === '/plaid/webhook') {
        const now = new Date(nowProvider()).toISOString();
        return await handlePlaidWebhook({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/plaid/link-token') {
        return await handlePlaidLinkToken({ ...context, fetchImpl, runtime });
      }
      if (method === 'POST' && path === '/plaid/exchange') {
        const now = new Date(nowProvider()).toISOString();
        return await handlePlaidExchange({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/plaid/status') {
        return await handlePlaidStatus({ ...context, fetchImpl, runtime });
      }
      if (method === 'POST' && path === '/plaid/sync') {
        const now = new Date(nowProvider()).toISOString();
        return await handlePlaidSync({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/plaid/disconnect') {
        const now = new Date(nowProvider()).toISOString();
        return await handlePlaidDisconnect({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/review/detail') {
        return await handleReviewDetail({ ...context, fetchImpl, runtime });
      }
      if (method === 'POST' && path === '/review/list') {
        return await handleReviewList({ ...context, fetchImpl, runtime });
      }
      if (method === 'POST' && path === '/review/sourcing-trip') {
        const now = new Date(nowProvider()).toISOString();
        return await handleSourcingTripReview({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/review/confirm') {
        const now = new Date(nowProvider()).toISOString();
        return await handleReviewConfirm({ ...context, fetchImpl, now, runtime });
      }
      if (method === 'POST' && path === '/review/post') {
        const now = new Date(nowProvider()).toISOString();
        return await handleReviewPost({ ...context, fetchImpl, now, runtime });
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
