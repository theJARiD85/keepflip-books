const EXCLUDED_TRANSACTION_CODES = new Set([
  'cash_withdrawal',
  'credit_card_payment',
  'deposit',
  'income',
  'loan_payment',
  'refund',
  'transfer',
]);

function text(value, maximum = 8_000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maximum);
}

function normalizedCurrency(value) {
  const currency = text(value, 8).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

function occurredAtFor(value, fallback) {
  const raw = text(value, 80);
  if (!raw) return fallback;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00.000Z`)
    : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function centsFor(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 1_000_000_000
    ? cents
    : 0;
}

export function normalizePlaidTransaction(raw, account, fallbackNow) {
  const transactionId = text(raw?.transaction_id, 180);
  if (!transactionId) return null;

  const amountCents = centsFor(raw?.amount);
  const transactionCode = text(raw?.transaction_code, 80).toLowerCase() || null;
  const pending = raw?.pending === true;
  const merchantName = text(raw?.merchant_name, 255) || null;
  const name = text(raw?.name, 255) || merchantName || 'Bank transaction';
  const primaryCategory = text(raw?.personal_finance_category?.primary, 120) || null;
  const detailedCategory = text(raw?.personal_finance_category?.detailed, 160) || null;
  const accountInfo = account && typeof account === 'object' ? account : {};
  const autoExpenseCandidate =
    amountCents > 0 &&
    !pending &&
    !EXCLUDED_TRANSACTION_CODES.has(transactionCode || '');

  return {
    accountId: text(raw?.account_id, 180),
    accountMask: text(accountInfo.mask, 8) || null,
    accountName: text(accountInfo.name, 255) || null,
    amountCents,
    authorizedAt: occurredAtFor(raw?.authorized_date, null),
    categoryDetailed: detailedCategory,
    categoryPrimary: primaryCategory,
    currency: normalizedCurrency(raw?.iso_currency_code || raw?.unofficial_currency_code),
    isExpenseCandidate: autoExpenseCandidate,
    merchantName,
    name,
    occurredAt: occurredAtFor(raw?.date || raw?.authorized_date, fallbackNow),
    pending,
    transactionCode,
    transactionId,
  };
}

export function plaidTransactionMemo(transaction) {
  const merchant = text(transaction?.merchantName, 160) || text(transaction?.name, 160);
  const category = text(transaction?.categoryDetailed, 120);
  return [
    'Bank import',
    merchant,
    category ? `Category: ${category.replace(/_/g, ' ').toLowerCase()}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 1_000);
}

export function plaidTransactionSourceKey(transactionId) {
  return `plaid:${text(transactionId, 180)}`;
}

export function excludedPlaidTransactionCodes() {
  return new Set(EXCLUDED_TRANSACTION_CODES);
}
