/**
 * KeepFlip's bookkeeping rules live in this dependency-free module so the
 * financial logic can be checked independently from Appwrite and eBay.
 *
 * Every amount is an integer number of cents. Never pass floating-point money
 * through this boundary.
 */

import { createHash } from 'node:crypto';

export const BOOK_ACCOUNT = Object.freeze({
  cash: 'cash_on_hand',
  marketplaceClearing: 'marketplace_clearing',
  inventory: 'inventory_asset',
  salesTaxHeld: 'marketplace_tax_passthrough',
  resaleRevenue: 'resale_revenue',
  salesReturns: 'refunds_and_returns',
  costOfGoodsSold: 'cost_of_goods_sold',
  marketplaceFees: 'marketplace_fees',
  shippingLabels: 'shipping_expense',
  repairs: 'repairs',
  supplies: 'supplies',
  software: 'software',
  advertising: 'advertising',
  storage: 'storage',
  mileage: 'mileage',
  otherExpense: 'other_expense',
  ebayCredits: 'ebay_credits',
});

export class BookkeepingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BookkeepingValidationError';
  }
}

function text(value, maximum = 240) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maximum);
}

function reviewOccurredAt(value) {
  const date = new Date(text(value, 80));
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : '1970-01-01T00:00:00.000Z';
}

function invalidEbayExternalId(source, kind) {
  const safeIdentity = {
    kind,
    payoutDate: text(source?.payoutDate, 64),
    payoutId: text(source?.payoutId, 180),
    transactionDate: text(source?.transactionDate, 64),
    transactionId: text(source?.transactionId, 180),
    transactionType: text(source?.transactionType, 80).toUpperCase(),
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(safeIdentity), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `invalid-${kind}-${digest}`;
}

export function assertCents(value, label = 'Amount') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BookkeepingValidationError(
      `${label} must be a positive whole number of cents.`,
    );
  }
  return value;
}

function parseMoneyToCents(money, label, { allowZero = false } = {}) {
  const source = money && typeof money === 'object' ? money : null;
  const currency = text(source?.currency, 8).toUpperCase();
  const value = text(source?.value, 48);

  if (!currency || !value) {
    throw new BookkeepingValidationError(`${label} is missing its amount.`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BookkeepingValidationError(`${label} has an unsupported currency.`);
  }

  // eBay returns decimal strings. Parse them directly instead of converting
  // through JavaScript floating point.
  const match = /^(\+?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new BookkeepingValidationError(`${label} has an unsupported amount.`);
  }

  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0') || '0');
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents) || cents < 0 || (!allowZero && cents === 0)) {
    throw new BookkeepingValidationError(
      allowZero
        ? `${label} must be a non-negative whole number of cents.`
        : `${label} must be a positive whole number of cents.`,
    );
  }

  return { cents, currency };
}

export function moneyToCents(money, label = 'Money') {
  return parseMoneyToCents(money, label);
}

function debit(accountCode, amountCents, memo = '') {
  return {
    accountCode,
    creditCents: 0,
    debitCents: assertCents(amountCents),
    memo: text(memo, 400) || null,
  };
}

function credit(accountCode, amountCents, memo = '') {
  return {
    accountCode,
    creditCents: assertCents(amountCents),
    debitCents: 0,
    memo: text(memo, 400) || null,
  };
}

export function totalsForLines(lines) {
  return lines.reduce(
    (totals, line) => {
      totals.debits += Number(line?.debitCents) || 0;
      totals.credits += Number(line?.creditCents) || 0;
      return totals;
    },
    { credits: 0, debits: 0 },
  );
}

export function assertBalancedJournal(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new BookkeepingValidationError(
      'A bookkeeping entry needs at least two journal lines.',
    );
  }

  for (const line of lines) {
    const debitCents = Number(line?.debitCents) || 0;
    const creditCents = Number(line?.creditCents) || 0;
    if (
      !text(line?.accountCode, 80) ||
      !Number.isSafeInteger(debitCents) ||
      !Number.isSafeInteger(creditCents) ||
      debitCents < 0 ||
      creditCents < 0 ||
      (debitCents === 0 && creditCents === 0) ||
      (debitCents > 0 && creditCents > 0)
    ) {
      throw new BookkeepingValidationError(
        'A journal line must affect one valid account on one side.',
      );
    }
  }

  const totals = totalsForLines(lines);
  if (totals.debits !== totals.credits) {
    throw new BookkeepingValidationError(
      `Journal entry is not balanced (${totals.debits} debits, ${totals.credits} credits).`,
    );
  }

  return totals;
}

function buildEntry({
  amountCents,
  currency = 'USD',
  eventType,
  grossProfitCents = null,
  itemId = null,
  moneyInCents = 0,
  moneyOutCents = 0,
  needsCostReview = false,
  notes = null,
  occurredAt,
  sourceKey,
  summary,
  lines,
}) {
  assertCents(amountCents);
  const normalizedCurrency = text(currency, 8).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new BookkeepingValidationError('Currency must be a three-letter code.');
  }
  if (!text(eventType, 60) || !text(sourceKey, 255) || !text(summary, 255)) {
    throw new BookkeepingValidationError(
      'Bookkeeping entries need an event type, source key, and summary.',
    );
  }
  if (!Number.isSafeInteger(moneyInCents) || moneyInCents < 0) {
    throw new BookkeepingValidationError('Money in must be whole cents.');
  }
  if (!Number.isSafeInteger(moneyOutCents) || moneyOutCents < 0) {
    throw new BookkeepingValidationError('Money out must be whole cents.');
  }
  if (
    grossProfitCents != null &&
    (!Number.isSafeInteger(grossProfitCents) || !Number.isFinite(grossProfitCents))
  ) {
    throw new BookkeepingValidationError('Gross profit must be whole cents.');
  }

  const journalTotals = assertBalancedJournal(lines);
  return {
    amountCents,
    currency: normalizedCurrency,
    eventType: text(eventType, 60),
    grossProfitCents,
    itemId: text(itemId, 64) || null,
    journalTotals,
    lines,
    moneyInCents,
    moneyOutCents,
    needsCostReview: Boolean(needsCostReview),
    notes: text(notes, 1_000) || null,
    occurredAt: text(occurredAt, 64),
    sourceKey: text(sourceKey, 255),
    summary: text(summary, 255),
  };
}

export function postInventoryPurchase(input) {
  const amountCents = assertCents(input?.amountCents, 'Purchase amount');
  return buildEntry({
    ...input,
    amountCents,
    eventType: 'inventory_purchase',
    moneyOutCents: amountCents,
    summary: input?.summary || 'Inventory purchase',
    lines: [
      debit(BOOK_ACCOUNT.inventory, amountCents, 'Item cost saved in inventory'),
      credit(BOOK_ACCOUNT.cash, amountCents, 'Money paid for inventory'),
    ],
  });
}

export function postSale(input) {
  const grossSaleCents = assertCents(input?.grossSaleCents, 'Sale amount');
  const feeCents = input?.feeCents == null ? 0 : Number(input.feeCents);
  const taxCents = input?.marketplaceCollectedTaxCents == null
    ? 0
    : Number(input.marketplaceCollectedTaxCents);
  const costCents = input?.costCents == null ? null : Number(input.costCents);

  if (!Number.isSafeInteger(feeCents) || feeCents < 0) {
    throw new BookkeepingValidationError('Marketplace fees must be whole cents.');
  }
  if (!Number.isSafeInteger(taxCents) || taxCents < 0) {
    throw new BookkeepingValidationError('Marketplace-collected tax must be whole cents.');
  }
  if (costCents != null && (!Number.isSafeInteger(costCents) || costCents < 0)) {
    throw new BookkeepingValidationError('Item cost must be whole cents.');
  }

  const lines = [
    debit(
      BOOK_ACCOUNT.marketplaceClearing,
      grossSaleCents + taxCents,
      'Gross customer payment received by marketplace',
    ),
    credit(BOOK_ACCOUNT.resaleRevenue, grossSaleCents, 'Resale revenue'),
  ];

  if (taxCents > 0) {
    // eBay collects and remits this amount. Record the pass-through without
    // treating it as the seller's revenue or the seller's cash balance.
    lines.push(
      credit(BOOK_ACCOUNT.salesTaxHeld, taxCents, 'Tax collected by marketplace'),
      debit(BOOK_ACCOUNT.salesTaxHeld, taxCents, 'Tax remitted by marketplace'),
      credit(
        BOOK_ACCOUNT.marketplaceClearing,
        taxCents,
        'Marketplace tax remittance',
      ),
    );
  }

  if (feeCents > 0) {
    lines.push(
      debit(BOOK_ACCOUNT.marketplaceFees, feeCents, 'Marketplace selling fees'),
      credit(BOOK_ACCOUNT.marketplaceClearing, feeCents, 'Fees withheld by marketplace'),
    );
  }

  if (costCents != null && costCents > 0) {
    lines.push(
      debit(BOOK_ACCOUNT.costOfGoodsSold, costCents, 'Original item cost'),
      credit(BOOK_ACCOUNT.inventory, costCents, 'Item moved out of inventory'),
    );
  }

  return buildEntry({
    ...input,
    amountCents: grossSaleCents,
    eventType: 'sale',
    grossProfitCents:
      costCents == null ? null : grossSaleCents - feeCents - costCents,
    moneyInCents: grossSaleCents,
    moneyOutCents: feeCents,
    needsCostReview: costCents == null,
    summary: input?.summary || 'Marketplace sale',
    lines,
  });
}

function expenseAccountFor(eventType) {
  return {
    marketplace_fee: BOOK_ACCOUNT.marketplaceFees,
    repair_parts: BOOK_ACCOUNT.repairs,
    supplies: BOOK_ACCOUNT.supplies,
    software: BOOK_ACCOUNT.software,
    advertising: BOOK_ACCOUNT.advertising,
    storage: BOOK_ACCOUNT.storage,
    mileage: BOOK_ACCOUNT.mileage,
  }[eventType] ?? BOOK_ACCOUNT.otherExpense;
}

export function postCashExpense(input) {
  const amountCents = assertCents(input?.amountCents, 'Expense amount');
  const eventType = text(input?.eventType, 60) || 'other_expense';
  return buildEntry({
    ...input,
    amountCents,
    eventType,
    moneyOutCents: amountCents,
    summary: input?.summary || 'Business cost',
    lines: [
      debit(expenseAccountFor(eventType), amountCents, 'Business cost'),
      credit(BOOK_ACCOUNT.cash, amountCents, 'Money paid'),
    ],
  });
}

export function postMarketplaceCharge(input) {
  const amountCents = assertCents(input?.amountCents, 'Marketplace charge');
  const eventType = text(input?.eventType, 60) || 'marketplace_fee';
  const account =
    eventType === 'shipping_label'
      ? BOOK_ACCOUNT.shippingLabels
      : eventType === 'refund'
        ? BOOK_ACCOUNT.salesReturns
        : BOOK_ACCOUNT.marketplaceFees;
  return buildEntry({
    ...input,
    amountCents,
    eventType,
    moneyOutCents: amountCents,
    summary:
      input?.summary ||
      (eventType === 'shipping_label' ? 'eBay shipping label' : 'Marketplace charge'),
    lines: [
      debit(account, amountCents, 'Marketplace charge'),
      credit(BOOK_ACCOUNT.marketplaceClearing, amountCents, 'Deducted from marketplace balance'),
    ],
  });
}

export function postMarketplaceCredit(input) {
  const amountCents = assertCents(input?.amountCents, 'Marketplace credit');
  return buildEntry({
    ...input,
    amountCents,
    eventType: 'marketplace_credit',
    moneyInCents: amountCents,
    summary: input?.summary || 'Marketplace credit',
    lines: [
      debit(BOOK_ACCOUNT.marketplaceClearing, amountCents, 'Credit added by marketplace'),
      credit(BOOK_ACCOUNT.ebayCredits, amountCents, 'Marketplace credit'),
    ],
  });
}

export function postPayout(input) {
  const amountCents = assertCents(input?.amountCents, 'Payout amount');
  return buildEntry({
    ...input,
    amountCents,
    eventType: 'payout',
    summary: input?.summary || 'Marketplace payout deposited',
    lines: [
      debit(BOOK_ACCOUNT.cash, amountCents, 'Payout deposited'),
      credit(BOOK_ACCOUNT.marketplaceClearing, amountCents, 'Marketplace balance transferred'),
    ],
  });
}

export function postBookkeepingEvent(input) {
  const eventType = text(input?.eventType, 60);
  switch (eventType) {
    case 'inventory_purchase':
      return postInventoryPurchase(input);
    case 'sale':
      return postSale(input);
    case 'shipping_label':
    case 'refund':
    case 'marketplace_fee':
      return postMarketplaceCharge(input);
    case 'marketplace_credit':
      return postMarketplaceCredit(input);
    case 'payout':
      return postPayout(input);
    case 'repair_parts':
    case 'supplies':
    case 'software':
    case 'advertising':
    case 'storage':
    case 'mileage':
    case 'other_expense':
      return postCashExpense(input);
    default:
      throw new BookkeepingValidationError(`Unsupported bookkeeping event: ${eventType || 'unknown'}.`);
  }
}

function firstMoney(source, keys, label, options = {}) {
  for (const key of keys) {
    const value = source?.[key];
    if (value && typeof value === 'object') {
      return parseMoneyToCents(value, label, options);
    }
  }
  throw new BookkeepingValidationError(`${label} was not supplied by eBay.`);
}

function optionalMoney(source, keys, label, options = {}) {
  for (const key of keys) {
    const value = source?.[key];
    if (value && typeof value === 'object') {
      return parseMoneyToCents(value, label, options);
    }
  }
  return null;
}

function safeOptionalMoney(source, keys, label, options = {}) {
  try {
    return optionalMoney(source, keys, label, options);
  } catch {
    return null;
  }
}

function identifiersFromEbayTransaction(raw) {
  const values = new Set();
  const add = (value) => {
    const cleaned = text(value, 180);
    if (cleaned) values.add(cleaned);
  };

  add(raw?.orderId);
  add(raw?.legacyItemId);
  add(raw?.itemId);
  add(raw?.sku);
  for (const reference of Array.isArray(raw?.references) ? raw.references : []) {
    if (reference && typeof reference === 'object') {
      add(reference.value);
      add(reference.referenceId);
      add(reference.referenceValue);
    }
  }
  for (const lineItem of Array.isArray(raw?.orderLineItems)
    ? raw.orderLineItems
    : []) {
    if (lineItem && typeof lineItem === 'object') {
      add(lineItem.lineItemId);
      add(lineItem.itemId);
      add(lineItem.legacyItemId);
      add(lineItem.sku);
    }
  }
  return [...values];
}

function reviewType(transactionType, suffix = '') {
  const raw = text(transactionType, 80).toLowerCase() || 'unclassified';
  return suffix ? `${raw}_${suffix}`.slice(0, 60) : raw;
}

function bookingMismatchReason(transactionType, bookingEntry, expected) {
  const actual = bookingEntry || 'MISSING';
  return `eBay reported ${transactionType} with booking entry ${actual}; KeepFlip expected ${expected} and held it instead of guessing.`;
}

/**
 * Converts a raw eBay Finances transaction into a no-PII posting request.
 * Unknown or insufficient data is returned as a review item, not guessed.
 */
export function parseEbayFinanceTransaction(raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const transactionType = text(source.transactionType, 80).toUpperCase();
  const transactionId = text(source.transactionId, 180);
  const occurredAt = text(source.transactionDate, 64);
  const bookingEntry = text(source.bookingEntry, 32).toUpperCase();
  const reportedAmount = safeOptionalMoney(
    source,
    ['amount'],
    'eBay transaction amount',
    { allowZero: true },
  );
  const reviewSourceType = reviewType(transactionType);

  if (!transactionType || !transactionId || !occurredAt) {
    const externalId = invalidEbayExternalId(source, 'transaction');
    return {
      ...(reportedAmount
        ? { amountCents: reportedAmount.cents, currency: reportedAmount.currency }
        : {}),
      bookingEntry: bookingEntry || null,
      eventType: null,
      externalId,
      itemIdentifiers: [],
      occurredAt: occurredAt || reviewOccurredAt(options?.fallbackOccurredAt),
      orderId: text(source.orderId, 180) || null,
      reviewReason: 'eBay transaction is missing its identity or date.',
      reviewSourceType,
      sourceKey: `ebay:invalid:${externalId}`,
      status: 'needs_review',
    };
  }

  const sourceKey = `ebay:${transactionType}:${transactionId}`;
  const common = {
    ...(reportedAmount
      ? { amountCents: reportedAmount.cents, currency: reportedAmount.currency }
      : {}),
    bookingEntry: bookingEntry || null,
    occurredAt,
    sourceKey,
    externalId: transactionId,
    itemIdentifiers: identifiersFromEbayTransaction(source),
    orderId: text(source.orderId, 180) || null,
    reviewSourceType,
  };

  try {
    if (transactionType === 'SALE') {
      const gross = firstMoney(
        source,
        ['totalFeeBasisAmount'],
        'eBay gross sale',
        { allowZero: true },
      );
      if (gross.cents === 0) {
        return {
          ...common,
          amountCents: 0,
          currency: gross.currency,
          eventType: null,
          reviewReason: 'eBay itself reported a zero gross sale amount, so KeepFlip held the sale instead of posting a fabricated value.',
          reviewSourceType: reviewType(transactionType, 'zero_amount'),
          status: 'needs_review',
        };
      }
      if (bookingEntry !== 'CREDIT') {
        return {
          ...common,
          amountCents: gross.cents,
          currency: gross.currency,
          eventType: null,
          reviewReason: bookingMismatchReason(transactionType, bookingEntry, 'CREDIT'),
          reviewSourceType: reviewType(transactionType, bookingEntry ? bookingEntry.toLowerCase() : 'booking_unknown'),
          status: 'needs_review',
        };
      }
      const lineItemCount = Array.isArray(source.orderLineItems)
        ? source.orderLineItems.length
        : 0;
      if (lineItemCount > 1) {
        return {
          ...common,
          amountCents: gross.cents,
          currency: gross.currency,
          eventType: null,
          reviewReason:
            'This eBay sale contains more than one item and needs an item-by-item review.',
          reviewSourceType: reviewType(transactionType, 'multi_item'),
          status: 'needs_review',
        };
      }
      const fees = optionalMoney(
        source,
        ['totalFeeAmount'],
        'eBay selling fees',
        { allowZero: true },
      );
      const salesTax = optionalMoney(
        source,
        ['eBayCollectedTaxAmount'],
        'eBay-collected tax',
        { allowZero: true },
      );
      return {
        ...common,
        currency: gross.currency,
        eventType: 'sale',
        grossSaleCents: gross.cents,
        marketplaceCollectedTaxCents: salesTax?.cents ?? 0,
        feeCents: fees?.cents ?? 0,
        reviewSourceType: 'sale',
        status: 'ready',
        summary: 'eBay sale',
      };
    }

    const amount = firstMoney(
      source,
      ['amount'],
      `eBay ${transactionType}`,
      { allowZero: true },
    );
    const base = {
      ...common,
      amountCents: amount.cents,
      currency: amount.currency,
    };

    if (amount.cents === 0) {
      return {
        ...base,
        eventType: null,
        reviewReason: `eBay itself reported this ${transactionType} transaction as 0.00 ${amount.currency}; KeepFlip preserved that value and held the record instead of inventing money movement.`,
        status: 'needs_review',
      };
    }

    if (transactionType === 'SHIPPING_LABEL') {
      if (bookingEntry === 'DEBIT') {
        return {
          ...base,
          eventType: 'shipping_label',
          reviewSourceType: 'shipping_label',
          status: 'ready',
          summary: 'eBay shipping label',
        };
      }
      return {
        ...base,
        eventType: null,
        reviewReason: bookingMismatchReason(transactionType, bookingEntry, 'DEBIT'),
        reviewSourceType: reviewType(
          transactionType,
          bookingEntry === 'CREDIT' ? 'credit' : 'booking_unknown',
        ),
        status: 'needs_review',
      };
    }

    if (transactionType === 'REFUND') {
      if (bookingEntry === 'DEBIT') {
        return {
          ...base,
          eventType: 'refund',
          reviewSourceType: 'refund',
          status: 'ready',
          summary: 'eBay customer refund',
        };
      }
      return {
        ...base,
        eventType: null,
        reviewReason: bookingMismatchReason(transactionType, bookingEntry, 'DEBIT'),
        reviewSourceType: reviewType(
          transactionType,
          bookingEntry === 'CREDIT' ? 'credit' : 'booking_unknown',
        ),
        status: 'needs_review',
      };
    }

    if (transactionType === 'CREDIT') {
      if (bookingEntry === 'CREDIT') {
        return {
          ...base,
          eventType: 'marketplace_credit',
          reviewSourceType: 'credit',
          status: 'ready',
          summary: 'eBay credit',
        };
      }
      return {
        ...base,
        eventType: null,
        reviewReason: bookingMismatchReason(transactionType, bookingEntry, 'CREDIT'),
        reviewSourceType: reviewType(
          transactionType,
          bookingEntry === 'DEBIT' ? 'debit' : 'booking_unknown',
        ),
        status: 'needs_review',
      };
    }

    if (transactionType === 'NON_SALE_CHARGE') {
      if (bookingEntry === 'DEBIT') {
        return {
          ...base,
          eventType: 'marketplace_fee',
          reviewSourceType: 'non_sale_charge',
          status: 'ready',
          summary: 'eBay account charge',
        };
      }
      return {
        ...base,
        eventType: null,
        reviewReason:
          bookingEntry === 'CREDIT'
            ? 'eBay reported a NON_SALE_CHARGE credit. KeepFlip held it because a fee credit should not be posted as a new marketplace expense or generic income.'
            : bookingMismatchReason(transactionType, bookingEntry, 'DEBIT'),
        reviewSourceType: reviewType(
          transactionType,
          bookingEntry === 'CREDIT' ? 'credit' : 'booking_unknown',
        ),
        status: 'needs_review',
      };
    }

    return {
      ...base,
      eventType: null,
      reviewReason: `eBay transaction type ${transactionType}${bookingEntry ? ` (${bookingEntry})` : ''} needs a dedicated accounting rule before KeepFlip can post it safely.`,
      reviewSourceType,
      status: 'needs_review',
    };
  } catch (error) {
    return {
      ...common,
      eventType: null,
      reviewReason:
        error instanceof Error
          ? error.message
          : 'eBay transaction could not be read safely.',
      reviewSourceType,
      status: 'needs_review',
    };
  }
}

export function parseEbayPayout(raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const payoutId = text(source.payoutId, 180);
  const occurredAt =
    text(source.payoutDate, 64) || text(source.transactionDate, 64);
  const reportedAmount = safeOptionalMoney(
    source,
    ['amount'],
    'eBay payout',
    { allowZero: true },
  );

  if (!payoutId || !occurredAt) {
    const externalId = invalidEbayExternalId(source, 'payout');
    return {
      ...(reportedAmount
        ? { amountCents: reportedAmount.cents, currency: reportedAmount.currency }
        : {}),
      eventType: null,
      externalId,
      occurredAt: occurredAt || reviewOccurredAt(options?.fallbackOccurredAt),
      reviewReason: 'eBay payout is missing its identity or date.',
      reviewSourceType: 'payout',
      sourceKey: `ebay:invalid:${externalId}`,
      status: 'needs_review',
    };
  }
  try {
    const amount = firstMoney(
      source,
      ['amount'],
      'eBay payout',
      { allowZero: true },
    );
    if (amount.cents === 0) {
      return {
        amountCents: 0,
        currency: amount.currency,
        eventType: null,
        externalId: payoutId,
        occurredAt,
        reviewReason: `eBay itself reported this payout as 0.00 ${amount.currency}; KeepFlip held it instead of creating a zero-dollar transfer.`,
        reviewSourceType: 'payout',
        sourceKey: `ebay:payout:${payoutId}`,
        status: 'needs_review',
      };
    }
    return {
      amountCents: amount.cents,
      currency: amount.currency,
      eventType: 'payout',
      externalId: payoutId,
      occurredAt,
      reviewSourceType: 'payout',
      sourceKey: `ebay:payout:${payoutId}`,
      status: 'ready',
      summary: 'eBay payout deposited',
    };
  } catch (error) {
    return {
      ...(reportedAmount
        ? { amountCents: reportedAmount.cents, currency: reportedAmount.currency }
        : {}),
      eventType: null,
      externalId: payoutId,
      occurredAt,
      reviewReason:
        error instanceof Error ? error.message : 'eBay payout could not be read safely.',
      reviewSourceType: 'payout',
      sourceKey: `ebay:payout:${payoutId}`,
      status: 'needs_review',
    };
  }
}
