import { createDecipheriv, createHash } from 'node:crypto';

import {
  parseEbayFinanceTransaction,
  parseEbayPayout,
} from './bookkeeping-domain.js';
import {
  createHandler as createCoreHandler,
  inventorySaleState,
  isSyncEligibleEbayConnection,
  reviewItemForRow,
  sourceEventPersistenceOperation,
} from './main-core.js';

export {
  inventorySaleState,
  isSyncEligibleEbayConnection,
  reviewItemForRow,
  sourceEventPersistenceOperation,
};

const MAX_EBAY_SYNC_DAYS = 90;
const MAX_EBAY_SYNC_ROWS = 500;
const REVIEW_STATUSES = new Set([
  'needs_item_match',
  'needs_item_cost',
  'needs_review',
]);

class RepairUpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RepairUpstreamError';
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
  return {
    endpoint: requiredEnvironment(['APPWRITE_FUNCTION_API_ENDPOINT']).replace(/\/+$/, ''),
    projectId: requiredEnvironment(['APPWRITE_FUNCTION_PROJECT_ID']),
  };
}

function tableConfiguration() {
  return {
    databaseId: firstEnvironment(['APPWRITE_BOOKS_DATABASE_ID', 'APPWRITE_DATABASE_ID'], 'keepflip'),
    sourceEventsTableId: firstEnvironment(['APPWRITE_BOOK_SOURCE_EVENTS_TABLE_ID'], 'book_source_events'),
    connectionsTableId: firstEnvironment([
      'APPWRITE_EBAY_CONNECTIONS_TABLE_ID',
      'APPWRITE_CONNECTIONS_TABLE_ID',
    ], 'ebay_connections'),
  };
}

function normalizeEnvironment(value) {
  const environment = text(value, 16).toLowerCase();
  if (environment === 'sandbox' || environment === 'production') return environment;
  throw new Error('eBay environment must be sandbox or production.');
}

function decodeEncryptionKey() {
  const encoded = requiredEnvironment(['EBAY_TOKEN_ENCRYPTION_KEY']);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('EBAY_TOKEN_ENCRYPTION_KEY must be Base64.');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('EBAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  return key;
}

function repairConfiguration(environment) {
  return {
    ...tableConfiguration(),
    encryptionKey: decodeEncryptionKey(),
    environment: normalizeEnvironment(environment),
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

async function appwriteJson({ runtime, path, method = 'GET', apiKey, jwt, body, failureMessage, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(runtime.endpoint + path, {
      method,
      headers: appwriteHeaders(runtime, { apiKey, jwt }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RepairUpstreamError(0, failureMessage);
  }
  const payload = await responseJson(response);
  if (!response.ok) throw new RepairUpstreamError(response.status, failureMessage);
  return payload;
}

function createQuery(method, attribute = '', values = []) {
  const query = { method: text(method, 64) };
  const cleanedAttribute = text(attribute, 512);
  if (cleanedAttribute) query.attribute = cleanedAttribute;
  if (Array.isArray(values) && values.length) query.values = values;
  return JSON.stringify(query);
}

function tableRowsPath(configuration, tableId) {
  return `/tablesdb/${encodeURIComponent(configuration.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
}

function rowPath(configuration, tableId, rowId) {
  return `${tableRowsPath(configuration, tableId)}/${encodeURIComponent(rowId)}`;
}

function listRowsPath(configuration, tableId, queries) {
  const params = new URLSearchParams();
  for (const query of queries) params.append('queries[]', query);
  const suffix = params.toString();
  return `${tableRowsPath(configuration, tableId)}${suffix ? `?${suffix}` : ''}`;
}

async function authenticatedUserId({ req, runtime, fetchImpl }) {
  const jwt = requestHeader(req?.headers, 'x-appwrite-user-jwt');
  if (!jwt) throw new Error('Sign in before using Books.');
  const account = await appwriteJson({
    fetchImpl,
    failureMessage: 'KeepFlip could not verify your sign-in.',
    jwt,
    path: '/account',
    runtime,
  });
  const userId = text(account?.$id, 64);
  if (!userId) throw new Error('KeepFlip could not verify your sign-in.');
  return userId;
}

function connectionRowId(ownerId, environment) {
  return `e${createHash('sha256')
    .update(`${ownerId}:${environment}`, 'utf8')
    .digest('hex')
    .slice(0, 35)}`;
}

function decryptSecret(value, key) {
  const [version, ivText, tagText, ciphertextText, ...extra] = String(value ?? '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText || extra.length > 0) {
    throw new Error('KeepFlip could not read the stored eBay connection.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function readAccessToken(connection, configuration) {
  const ciphertext = text(connection?.tokenCiphertext) || text(connection?.encryptedTokens);
  const tokens = JSON.parse(decryptSecret(ciphertext, configuration.encryptionKey));
  const accessToken = text(tokens?.accessToken, 8_000);
  if (!accessToken) throw new Error('KeepFlip could not read the active eBay access token.');
  return accessToken;
}

function financesBase(environment) {
  return environment === 'production'
    ? 'https://apiz.ebay.com'
    : 'https://apiz.sandbox.ebay.com';
}

async function ebayFinanceJson({ configuration, accessToken, path, fetchImpl }) {
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
    throw new RepairUpstreamError(0, 'KeepFlip could not reach eBay finance records for review repair.');
  }
  const payload = await responseJson(response);
  if (!response.ok && response.status !== 204) {
    throw new RepairUpstreamError(response.status, 'KeepFlip could not reload eBay finance records for review repair.');
  }
  return payload;
}

async function fetchEbayTransactions({ configuration, accessToken, start, end, fetchImpl }) {
  const transactions = [];
  for (let offset = 0; transactions.length < MAX_EBAY_SYNC_ROWS; offset += 100) {
    const params = new URLSearchParams({
      filter: `transactionDate:[${start}..${end}]`,
      limit: '100',
      offset: String(offset),
    });
    const payload = await ebayFinanceJson({
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
    const payload = await ebayFinanceJson({
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

async function listSourceEvents({ runtime, configuration, apiKey, ownerId, fetchImpl }) {
  const payload = await appwriteJson({
    apiKey,
    failureMessage: 'KeepFlip could not load source events for review repair.',
    fetchImpl,
    path: listRowsPath(configuration, configuration.sourceEventsTableId, [
      createQuery('equal', 'ownerId', [ownerId]),
      createQuery('limit', '', [500]),
    ]),
    runtime,
  });
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function isLegacyReviewRow(row) {
  return Boolean(
    text(row?.source, 80) === 'ebay_finances' &&
      REVIEW_STATUSES.has(text(row?.eventStatus, 40)) &&
      text(row?.sourceType, 60).toLowerCase() === 'unknown' &&
      Number(row?.amountCents) === 0 &&
      text(row?.currency, 8).toUpperCase() === 'USD' &&
      !text(row?.rawTransactionType, 80)
  );
}

function recoverableLegacyStart(rows, now) {
  const clock = new Date(now);
  const oldest = new Date(clock.getTime() - MAX_EBAY_SYNC_DAYS * 86_400_000);
  let earliest = null;
  for (const row of rows) {
    if (!isLegacyReviewRow(row)) continue;
    const date = new Date(text(row?.occurredAt, 80));
    if (!Number.isFinite(date.getTime()) || date < oldest || date > clock) continue;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest ? earliest.toISOString() : null;
}

function rawMoneyAudit(raw, fallbackMoney) {
  const amount = record(raw?.amount);
  const fallback = record(fallbackMoney);
  return {
    rawAmountValue: text(amount?.value, 64) || text(fallback?.value, 64) || null,
    rawCurrency:
      (text(amount?.currency, 8) || text(fallback?.currency, 8)).toUpperCase() || null,
  };
}

function amountForParsed(parsed) {
  const direct = Number(parsed?.amountCents);
  const gross = Number(parsed?.grossSaleCents);
  const currency = text(parsed?.currency, 8).toUpperCase();
  if (Number.isSafeInteger(direct) && direct >= 0 && /^[A-Z]{3}$/.test(currency)) {
    return { amountCents: direct, currency };
  }
  if (Number.isSafeInteger(gross) && gross >= 0 && /^[A-Z]{3}$/.test(currency)) {
    return { amountCents: gross, currency };
  }
  return { amountCents: 0, currency: 'XXX' };
}

function sourceTypeForParsed(parsed, rawType) {
  let sourceType =
    text(parsed?.reviewSourceType, 60).toLowerCase() ||
    text(parsed?.eventType, 60).toLowerCase() ||
    text(rawType, 60).toLowerCase() ||
    'unclassified';
  const currency = text(parsed?.currency, 8).toUpperCase();
  if (currency && currency !== 'USD' && !sourceType.endsWith('_foreign_currency')) {
    sourceType = `${sourceType}_foreign_currency`.slice(0, 60);
  }
  return sourceType;
}

function transactionMatch(raw, now) {
  const parsed = parseEbayFinanceTransaction(raw, { fallbackOccurredAt: now });
  const rawType = text(raw?.transactionType, 80).toUpperCase();
  const moneyAudit = rawMoneyAudit(raw, raw?.totalFeeBasisAmount);
  return {
    keys: [
      text(raw?.transactionId, 180),
      text(parsed?.externalId, 180),
      text(parsed?.sourceKey, 255),
    ].filter(Boolean),
    patch: {
      ...amountForParsed(parsed),
      bookingEntry:
        text(raw?.bookingEntry, 32).toUpperCase() ||
        text(parsed?.bookingEntry, 32).toUpperCase() ||
        null,
      rawTransactionType: rawType || null,
      reviewReason: text(parsed?.reviewReason, 1_000) || null,
      reviewUpdatedAt: now,
      sourceType: sourceTypeForParsed(parsed, rawType),
      transactionMemo: text(raw?.transactionMemo, 1_000) || null,
      ...moneyAudit,
    },
  };
}

function payoutMatch(raw, now) {
  const parsed = parseEbayPayout(raw, { fallbackOccurredAt: now });
  const moneyAudit = rawMoneyAudit(raw, null);
  return {
    keys: [
      text(raw?.payoutId, 180),
      text(parsed?.externalId, 180),
      text(parsed?.sourceKey, 255),
    ].filter(Boolean),
    patch: {
      ...amountForParsed(parsed),
      bookingEntry: null,
      rawTransactionType: 'PAYOUT',
      reviewReason: text(parsed?.reviewReason, 1_000) || null,
      reviewUpdatedAt: now,
      sourceType: sourceTypeForParsed(parsed, 'PAYOUT'),
      transactionMemo: null,
      ...moneyAudit,
    },
  };
}

function buildSourceIndex(transactions, payouts, now) {
  const index = new Map();
  for (const raw of transactions) {
    const match = transactionMatch(raw, now);
    for (const key of match.keys) index.set(key, match);
  }
  for (const raw of payouts) {
    const match = payoutMatch(raw, now);
    for (const key of match.keys) index.set(key, match);
  }
  return index;
}

async function patchSourceRow({ runtime, configuration, apiKey, rowId, data, fetchImpl }) {
  try {
    await appwriteJson({
      apiKey,
      body: { data },
      failureMessage: 'KeepFlip could not update the eBay source audit record.',
      fetchImpl,
      method: 'PATCH',
      path: rowPath(configuration, configuration.sourceEventsTableId, rowId),
      runtime,
    });
    return true;
  } catch (error) {
    if (error instanceof RepairUpstreamError && error.status === 404) return false;
    throw error;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

async function auditAndRepair({
  req,
  runtime,
  configuration,
  apiKey,
  ownerId,
  accessToken,
  start,
  end,
  initialLegacyIds,
  fetchImpl,
  now,
}) {
  const [transactions, payouts] = await Promise.all([
    fetchEbayTransactions({ accessToken, configuration, end, fetchImpl, start }),
    fetchEbayPayouts({ accessToken, configuration, end, fetchImpl, start }),
  ]);
  const complete =
    transactions.length < MAX_EBAY_SYNC_ROWS && payouts.length < MAX_EBAY_SYNC_ROWS;
  const sourceIndex = buildSourceIndex(transactions, payouts, now);
  const rows = await listSourceEvents({
    apiKey,
    configuration,
    fetchImpl,
    ownerId,
    runtime,
  });
  const openRows = rows.filter((row) => REVIEW_STATUSES.has(text(row?.eventStatus, 40)));

  await mapWithConcurrency(openRows, 8, async (row) => {
    const externalKey = text(row?.externalKey, 255);
    const match = sourceIndex.get(externalKey);
    if (!match) return;
    await patchSourceRow({
      apiKey,
      configuration,
      data: match.patch,
      fetchImpl,
      rowId: text(row?.$id, 64),
      runtime,
    });
  });

  const afterAuditRows = await listSourceEvents({
    apiKey,
    configuration,
    fetchImpl,
    ownerId,
    runtime,
  });
  const remainingLegacy = afterAuditRows.filter(isLegacyReviewRow);
  const auditStart = Date.parse(start);
  const auditEnd = Date.parse(end);
  const clock = new Date(now);
  const oldestRecoverable = new Date(clock.getTime() - MAX_EBAY_SYNC_DAYS * 86_400_000);
  const archivedIds = new Set();

  await mapWithConcurrency(remainingLegacy, 8, async (row) => {
    const occurredAt = new Date(text(row?.occurredAt, 80));
    const validDate = Number.isFinite(occurredAt.getTime());
    const insideAuditWindow =
      validDate && occurredAt.getTime() >= auditStart && occurredAt.getTime() <= auditEnd;
    const outsideRecoveryHorizon =
      !validDate || occurredAt < oldestRecoverable || occurredAt > clock;

    if (!outsideRecoveryHorizon && (!insideAuditWindow || !complete)) return;

    const archived = await patchSourceRow({
      apiKey,
      configuration,
      data: {
        eventStatus: 'legacy_unresolved',
        reviewReason:
          outsideRecoveryHorizon
            ? 'Archived legacy sync artifact. This row predates KeepFlip source-audit fields and falls outside the safe eBay recovery window. No Books entry was created from this fallback row.'
            : 'Archived legacy sync artifact. KeepFlip re-read the complete eBay finance window and could not match this older Unknown / $0.00 fallback row to a real eBay transaction. No Books entry was created from it.',
        reviewUpdatedAt: now,
        sourceType: 'legacy_unresolved',
      },
      fetchImpl,
      rowId: text(row?.$id, 64),
      runtime,
    });
    if (archived) archivedIds.add(text(row?.$id, 64));
  });

  const finalRows = await listSourceEvents({
    apiKey,
    configuration,
    fetchImpl,
    ownerId,
    runtime,
  });
  const remainingLegacyIds = new Set(
    finalRows.filter(isLegacyReviewRow).map((row) => text(row?.$id, 64)),
  );
  let repaired = 0;
  for (const id of initialLegacyIds) {
    if (!remainingLegacyIds.has(id) && !archivedIds.has(id)) repaired += 1;
  }

  return {
    legacyArchived: archivedIds.size,
    legacyDeferred: remainingLegacyIds.size,
    legacyRepaired: repaired,
    reviewAuditWindowComplete: complete,
  };
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

async function invokeCore(coreHandler, context, bodyOverride) {
  const capture = captureResponse();
  const req = bodyOverride
    ? { ...context.req, bodyJson: bodyOverride }
    : context.req;
  await coreHandler({ ...context, req, res: capture.res });
  return capture.result;
}

function earlierStart(candidate, current) {
  if (!candidate) return current;
  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (!Number.isFinite(candidateTime)) return current;
  if (!Number.isFinite(currentTime) || candidateTime < currentTime) return candidate;
  return current;
}

export function createHandler(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowProvider = options.now ?? (() => new Date().toISOString());
  const coreHandler = createCoreHandler(options);

  return async (context) => {
    const method = text(context?.req?.method, 16).toUpperCase();
    const path = requestPath(context?.req);
    if (method !== 'POST' || path !== '/ebay/sync') {
      return coreHandler(context);
    }

    const first = await invokeCore(coreHandler, context);
    if (first.status !== 200 || first.body?.ok !== true) {
      return context.res.json(first.body, first.status);
    }

    const responseBody = { ...first.body };
    try {
      const now = new Date(nowProvider()).toISOString();
      const runtime = runtimeConfiguration();
      const body = requestBody(context.req);
      const configuration = repairConfiguration(body.environment);
      const apiKey = dynamicApiKey(context.req);
      const ownerId = await authenticatedUserId({
        fetchImpl,
        req: context.req,
        runtime,
      });

      let rows = await listSourceEvents({
        apiKey,
        configuration,
        fetchImpl,
        ownerId,
        runtime,
      });
      const initialLegacyIds = new Set(
        rows.filter(isLegacyReviewRow).map((row) => text(row?.$id, 64)),
      );
      const legacyStart = recoverableLegacyStart(rows, now);
      let auditStart = earlierStart(legacyStart, text(first.body?.syncedFrom, 80));
      const auditEnd = text(first.body?.syncedTo, 80) || now;

      if (
        legacyStart &&
        Number.isFinite(Date.parse(first.body?.syncedFrom)) &&
        Date.parse(legacyStart) < Date.parse(first.body.syncedFrom)
      ) {
        const expanded = await invokeCore(coreHandler, context, {
          ...body,
          startedAt: legacyStart,
        });
        if (expanded.status === 200 && expanded.body?.ok === true) {
          auditStart = earlierStart(text(expanded.body?.syncedFrom, 80), auditStart);
        } else {
          responseBody.legacyRepairWarning =
            'KeepFlip could not expand the eBay sync far enough to repair every older review row yet.';
        }
      }

      const connection = await appwriteJson({
        apiKey,
        failureMessage: 'KeepFlip could not load the eBay connection for review repair.',
        fetchImpl,
        path: rowPath(
          configuration,
          configuration.connectionsTableId,
          connectionRowId(ownerId, configuration.environment),
        ),
        runtime,
      });
      const accessToken = readAccessToken(connection, configuration);
      const repair = await auditAndRepair({
        accessToken,
        apiKey,
        configuration,
        end: auditEnd,
        fetchImpl,
        initialLegacyIds,
        now,
        ownerId,
        req: context.req,
        runtime,
        start: auditStart,
      });
      Object.assign(responseBody, repair);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'KeepFlip could not finish the legacy review cleanup.';
      responseBody.legacyRepairWarning = message;
      context?.log?.(`[KeepFlip Books] eBay review repair deferred: ${message}`);
    }

    return context.res.json(responseBody, first.status);
  };
}

export default createHandler();
