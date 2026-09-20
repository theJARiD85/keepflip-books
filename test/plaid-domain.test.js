import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePlaidTransaction,
  plaidTransactionMemo,
  plaidTransactionSourceKey,
} from '../src/plaid-domain.js';

const now = '2026-09-20T12:00:00.000Z';

test('Plaid outgoing settled transactions are eligible for automated expense import', () => {
  const transaction = normalizePlaidTransaction(
    {
      account_id: 'account-1',
      amount: 18.5,
      date: '2026-09-19',
      iso_currency_code: 'USD',
      merchant_name: 'Shipping Store',
      name: 'Shipping Store #42',
      personal_finance_category: {
        detailed: 'GENERAL_SERVICES_POSTAGE_AND_SHIPPING',
        primary: 'GENERAL_SERVICES',
      },
      transaction_id: 'txn-1',
      transaction_code: null,
    },
    { id: 'account-1', mask: '1234', name: 'Business checking' },
    now,
  );

  assert.deepEqual(transaction, {
    accountId: 'account-1',
    accountMask: '1234',
    accountName: 'Business checking',
    amountCents: 1850,
    authorizedAt: null,
    categoryDetailed: 'GENERAL_SERVICES_POSTAGE_AND_SHIPPING',
    categoryPrimary: 'GENERAL_SERVICES',
    currency: 'USD',
    isExpenseCandidate: true,
    merchantName: 'Shipping Store',
    name: 'Shipping Store #42',
    occurredAt: '2026-09-19T12:00:00.000Z',
    pending: false,
    transactionCode: null,
    transactionId: 'txn-1',
  });
  assert.equal(
    plaidTransactionMemo(transaction),
    'Bank import · Shipping Store · Category: general services postage and shipping',
  );
  assert.equal(plaidTransactionSourceKey(transaction.transactionId), 'plaid:txn-1');
});

test('Plaid pending, inflow, and transfer transactions are not auto-posted as expenses', () => {
  const pending = normalizePlaidTransaction(
    {
      account_id: 'account-1',
      amount: 12,
      date: '2026-09-19',
      iso_currency_code: 'USD',
      name: 'Pending purchase',
      pending: true,
      transaction_id: 'txn-pending',
    },
    null,
    now,
  );
  const inflow = normalizePlaidTransaction(
    {
      account_id: 'account-1',
      amount: -1200,
      date: '2026-09-19',
      iso_currency_code: 'USD',
      name: 'Customer deposit',
      transaction_id: 'txn-inflow',
    },
    null,
    now,
  );
  const transfer = normalizePlaidTransaction(
    {
      account_id: 'account-1',
      amount: 400,
      date: '2026-09-19',
      iso_currency_code: 'USD',
      name: 'Transfer to savings',
      transaction_code: 'transfer',
      transaction_id: 'txn-transfer',
    },
    null,
    now,
  );

  assert.equal(pending.isExpenseCandidate, false);
  assert.equal(inflow.isExpenseCandidate, false);
  assert.equal(transfer.isExpenseCandidate, false);
});
