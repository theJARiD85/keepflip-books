import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOK_ACCOUNT,
  BookkeepingValidationError,
  assertBalancedJournal,
  parseEbayFinanceTransaction,
  parseEbayPayout,
  postInventoryPurchase,
  postPayout,
  postSale,
} from '../src/bookkeeping-domain.js';
import { sourceEventPersistenceOperation } from '../src/main.js';

test('an inventory purchase creates a balanced two-sided entry', () => {
  const entry = postInventoryPurchase({
    amountCents: 1_000,
    occurredAt: '2026-08-20T12:00:00.000Z',
    sourceKey: 'manual:purchase:item-1:20260820',
  });

  assert.deepEqual(entry.journalTotals, { credits: 1_000, debits: 1_000 });
  assert.deepEqual(entry.lines, [
    {
      accountCode: BOOK_ACCOUNT.inventory,
      creditCents: 0,
      debitCents: 1_000,
      memo: 'Item cost saved in inventory',
    },
    {
      accountCode: BOOK_ACCOUNT.cash,
      creditCents: 1_000,
      debitCents: 0,
      memo: 'Money paid for inventory',
    },
  ]);
});

test('a sale moves the exact original cost to COGS and keeps tax out of revenue', () => {
  const entry = postSale({
    costCents: 1_000,
    feeCents: 700,
    grossSaleCents: 5_000,
    itemId: 'item-1',
    marketplaceCollectedTaxCents: 420,
    occurredAt: '2026-08-29T12:00:00.000Z',
    sourceKey: 'ebay:SALE:order-1',
  });

  assert.equal(entry.grossProfitCents, 3_300);
  assert.equal(entry.needsCostReview, false);
  assert.equal(entry.moneyInCents, 5_000);
  assert.equal(entry.moneyOutCents, 700);
  assert.equal(
    entry.lines.some(
      (line) =>
        line.accountCode === BOOK_ACCOUNT.costOfGoodsSold &&
        line.debitCents === 1_000,
    ),
    true,
  );
  assert.equal(
    entry.lines.some(
      (line) =>
        line.accountCode === BOOK_ACCOUNT.inventory &&
        line.creditCents === 1_000,
    ),
    true,
  );
  assert.deepEqual(entry.journalTotals, entry.journalTotals);
  assertBalancedJournal(entry.lines);
});

test('a sale without a stored cost remains balanced but is flagged for review', () => {
  const entry = postSale({
    feeCents: 500,
    grossSaleCents: 5_000,
    occurredAt: '2026-08-29T12:00:00.000Z',
    sourceKey: 'ebay:SALE:order-missing-cost',
  });

  assert.equal(entry.grossProfitCents, null);
  assert.equal(entry.needsCostReview, true);
  assert.equal(
    entry.lines.some((line) => line.accountCode === BOOK_ACCOUNT.costOfGoodsSold),
    false,
  );
});

test('payouts move money from marketplace clearing to cash without treating it as revenue', () => {
  const entry = postPayout({
    amountCents: 4_300,
    occurredAt: '2026-08-29T12:00:00.000Z',
    sourceKey: 'ebay:payout:payout-1',
  });

  assert.equal(entry.moneyInCents, 0);
  assert.equal(entry.moneyOutCents, 0);
  assert.deepEqual(entry.journalTotals, { credits: 4_300, debits: 4_300 });
});

test('unbalanced journal lines are rejected', () => {
  assert.throws(
    () =>
      assertBalancedJournal([
        { accountCode: 'cash', debitCents: 100, creditCents: 0 },
        { accountCode: 'sales', debitCents: 0, creditCents: 99 },
      ]),
    BookkeepingValidationError,
  );
});

test('eBay sale parsing uses fee basis as gross sale and isolates marketplace tax', () => {
  const parsed = parseEbayFinanceTransaction({
    eBayCollectedTaxAmount: { currency: 'USD', value: '4.20' },
    orderId: '12-34567-89012',
    totalFeeAmount: { currency: 'USD', value: '7.00' },
    totalFeeBasisAmount: { currency: 'USD', value: '50.00' },
    transactionDate: '2026-08-29T12:00:00.000Z',
    transactionId: 'txn-1',
    transactionType: 'SALE',
  });

  assert.deepEqual(
    {
      eventType: parsed.eventType,
      feeCents: parsed.feeCents,
      grossSaleCents: parsed.grossSaleCents,
      marketplaceCollectedTaxCents: parsed.marketplaceCollectedTaxCents,
      status: parsed.status,
    },
    {
      eventType: 'sale',
      feeCents: 700,
      grossSaleCents: 5_000,
      marketplaceCollectedTaxCents: 420,
      status: 'ready',
    },
  );
});

test('eBay fee and payout parsing never converts decimal money through floats', () => {
  const fee = parseEbayFinanceTransaction({
    amount: { currency: 'USD', value: '12.05' },
    transactionDate: '2026-08-29T12:00:00.000Z',
    transactionId: 'fee-1',
    transactionType: 'NON_SALE_CHARGE',
  });
  const payout = parseEbayPayout({
    amount: { currency: 'USD', value: '99.99' },
    payoutDate: '2026-08-29T12:00:00.000Z',
    payoutId: 'payout-1',
  });

  assert.equal(fee.amountCents, 1_205);
  assert.equal(payout.amountCents, 9_999);
});

test('an eBay transaction without an identity is held for review instead of aborting sync', () => {
  const parsed = parseEbayFinanceTransaction(
    { transactionType: 'SALE' },
    { fallbackOccurredAt: '2026-08-31T22:00:00.000Z' },
  );

  assert.equal(parsed.status, 'needs_review');
  assert.equal(parsed.eventType, null);
  assert.equal(parsed.occurredAt, '2026-08-31T22:00:00.000Z');
  assert.match(parsed.externalId, /^invalid-transaction-[a-f0-9]{24}$/);
  assert.equal(parsed.reviewReason, 'eBay transaction is missing its identity or date.');
});

test('an eBay payout without an identity is held for review instead of aborting sync', () => {
  const parsed = parseEbayPayout(
    {},
    { fallbackOccurredAt: '2026-08-31T22:00:00.000Z' },
  );

  assert.equal(parsed.status, 'needs_review');
  assert.equal(parsed.eventType, null);
  assert.equal(parsed.occurredAt, '2026-08-31T22:00:00.000Z');
  assert.match(parsed.externalId, /^invalid-payout-[a-f0-9]{24}$/);
  assert.equal(parsed.reviewReason, 'eBay payout is missing its identity or date.');
});

test('a multi-item eBay sale is held for review instead of assigning all COGS to one item', () => {
  const parsed = parseEbayFinanceTransaction({
    orderLineItems: [{ lineItemId: 'one' }, { lineItemId: 'two' }],
    totalFeeBasisAmount: { currency: 'USD', value: '50.00' },
    transactionDate: '2026-08-29T12:00:00.000Z',
    transactionId: 'multi-1',
    transactionType: 'SALE',
  });

  assert.equal(parsed.status, 'needs_review');
  assert.equal(parsed.eventType, null);
  assert.equal(parsed.amountCents, 5_000);
});
test('a reviewed eBay source event is promoted instead of creating a duplicate', () => {
  const operation = sourceEventPersistenceOperation({
    configuration: {
      databaseId: 'keepflip',
      sourceEventsTableId: 'book_source_events',
    },
    existingSourceEvent: {
      createdAt: '2026-08-20T12:00:00.000Z',
    },
    sourceData: {
      createdAt: '2026-08-29T12:00:00.000Z',
      eventStatus: 'posted',
    },
    sourceEventId: 'source-event-1',
  });

  assert.equal(operation.action, 'update');
  assert.equal(operation.data.createdAt, '2026-08-20T12:00:00.000Z');
  assert.equal(operation.data.eventStatus, 'posted');
  assert.equal(operation.rowId, 'source-event-1');
});
