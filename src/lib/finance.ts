import type { Account, Card, Debtor, Installment, Reserve, Transaction } from '../types';
import { db } from './db';
import { calculateAvailableCardLimit, calculateMonthlyFreeCents } from './calculations';
import { thisMonth, today } from './format';

export interface AccountBalance { account: Account; balanceCents: number; }
export interface CardMetrics { card: Card; usedCents: number; availableCents: number; nextInvoiceCents: number; }
export interface MonthSummary {
  incomeCents: number; pendingIncomeCents: number; cashExpensesCents: number; pendingExpensesCents: number;
  installmentsCents: number; reserveDepositsCents: number; freeCents: number; actualNetCents: number;
  receivedCents: number; paidCashExpensesCents: number;
}

export async function getAccountBalances(): Promise<AccountBalance[]> {
  const [accounts, transactions, transfers, debtorPayments, invoicePayments, investmentMovements] = await Promise.all([
    db.accounts.toArray(), db.transactions.toArray(), db.transfers.toArray(), db.debtorPayments.toArray(), db.invoicePayments.toArray(), db.investmentMovements.toArray(),
  ]);
  return accounts.map((account) => {
    let balance = account.initialBalanceCents;
    for (const tx of transactions) {
      if (tx.accountId !== account.id || tx.status === 'cancelled') continue;
      const isActual = tx.type === 'income' ? tx.status === 'received' || tx.status === 'paid' : tx.status === 'paid';
      if (!isActual) continue;
      balance += tx.type === 'income' ? tx.amountCents : -tx.amountCents;
    }
    for (const transfer of transfers) {
      if (transfer.fromAccountId === account.id) balance -= transfer.amountCents;
      if (transfer.toAccountId === account.id) balance += transfer.amountCents;
    }
    for (const payment of debtorPayments) if (payment.accountId === account.id) balance += payment.amountCents;
    for (const payment of invoicePayments) if (payment.accountId === account.id) balance -= payment.amountCents;
    for (const movement of investmentMovements) {
      if (movement.accountId !== account.id) continue;
      balance += movement.type === 'withdrawal' ? movement.amountCents : -movement.amountCents;
    }
    return { account, balanceCents: balance };
  });
}

export async function getCardMetrics(): Promise<CardMetrics[]> {
  const [cards, installments] = await Promise.all([db.cards.toArray(), db.installments.toArray()]);
  const currentMonth = thisMonth();
  return cards.map((card) => {
    const related = installments.filter((item) => item.cardId === card.id);
    const usedCents = related.reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
    const nextInvoiceCents = related.filter((item) => item.dueMonth === currentMonth).reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
    return { card, usedCents, availableCents: calculateAvailableCardLimit(card.limitCents, usedCents), nextInvoiceCents };
  });
}

export async function getMonthSummary(month: string): Promise<MonthSummary> {
  const [transactions, installments, reserveMovements] = await Promise.all([
    db.transactions.where('month').equals(month).toArray(),
    db.installments.where('dueMonth').equals(month).toArray(),
    db.reserveMovements.where('date').between(`${month}-01`, `${month}-31`, true, true).toArray(),
  ]);
  const valid = transactions.filter((tx) => tx.status !== 'cancelled');
  const incomes = valid.filter((tx) => tx.type === 'income');
  const expenses = valid.filter((tx) => tx.type === 'expense');
  const receivedCents = incomes.filter((tx) => tx.status === 'received' || tx.status === 'paid').reduce((sum, tx) => sum + tx.amountCents, 0);
  const pendingIncomeCents = incomes.filter((tx) => tx.status === 'pending' || tx.status === 'receivable').reduce((sum, tx) => sum + tx.amountCents, 0);
  const paidCashExpensesCents = expenses.filter((tx) => tx.status === 'paid').reduce((sum, tx) => sum + tx.amountCents, 0);
  const pendingExpensesCents = expenses.filter((tx) => tx.status === 'pending' || tx.status === 'receivable').reduce((sum, tx) => sum + tx.amountCents, 0);
  const installmentTotal = installments.reduce((sum, item) => sum + item.amountCents, 0);
  const reserveDepositsCents = reserveMovements.filter((item) => item.type === 'deposit').reduce((sum, item) => sum + item.amountCents, 0);
  const reserveWithdrawalsCents = reserveMovements.filter((item) => item.type === 'withdrawal').reduce((sum, item) => sum + item.amountCents, 0);
  const allCashExpenses = expenses.reduce((sum, tx) => sum + tx.amountCents, 0);
  const allIncome = incomes.reduce((sum, tx) => sum + tx.amountCents, 0);
  const freeCents = calculateMonthlyFreeCents({ incomeCents: allIncome, cashExpensesCents: allCashExpenses, installmentsCents: installmentTotal, reserveDepositsCents, reserveWithdrawalsCents });
  return {
    incomeCents: allIncome, pendingIncomeCents, cashExpensesCents: allCashExpenses, pendingExpensesCents,
    installmentsCents: installmentTotal, reserveDepositsCents: Math.max(0, reserveDepositsCents - reserveWithdrawalsCents),
    freeCents, actualNetCents: receivedCents - paidCashExpensesCents, receivedCents, paidCashExpensesCents,
  };
}

export async function getReserveBalances(): Promise<Array<{ reserve: Reserve; balanceCents: number }>> {
  const [reserves, movements] = await Promise.all([db.reserves.toArray(), db.reserveMovements.toArray()]);
  return reserves.map((reserve) => ({
    reserve,
    balanceCents: movements.filter((move) => move.reserveId === reserve.id).reduce((sum, move) => sum + (move.type === 'deposit' ? move.amountCents : -move.amountCents), 0),
  }));
}

export async function getDebtorMetrics() {
  const [debtors, payments] = await Promise.all([db.debtors.toArray(), db.debtorPayments.toArray()]);
  return debtors.map((debtor: Debtor) => {
    const received = payments.filter((payment) => payment.debtorId === debtor.id).reduce((sum, payment) => sum + payment.amountCents, 0);
    const remaining = Math.max(0, debtor.originalCents - received);
    return { debtor, receivedCents: received, remainingCents: remaining, status: remaining === 0 ? 'Quitado' : debtor.dueDate && debtor.dueDate < new Date().toISOString().slice(0, 10) ? 'Atrasado' : received > 0 ? 'Parcialmente pago' : 'Em aberto' };
  });
}

export async function getPatrimony() {
  const [balances, cardMetrics, investments, debtorMetrics, reserves] = await Promise.all([
    getAccountBalances(), getCardMetrics(), db.investments.toArray(), getDebtorMetrics(), getReserveBalances(),
  ]);
  const cash = balances.reduce((sum, item) => sum + item.balanceCents, 0);
  const investmentsTotal = investments.reduce((sum, item) => sum + item.balanceCents, 0);
  const receivable = debtorMetrics.reduce((sum, item) => sum + item.remainingCents, 0);
  const cardCommitments = cardMetrics.reduce((sum, item) => sum + item.usedCents, 0);
  const reserved = reserves.reduce((sum, item) => sum + item.balanceCents, 0);
  return { cash, investmentsTotal, receivable, cardCommitments, reserved, netWorth: cash + investmentsTotal + receivable - cardCommitments, freeCash: cash - reserved };
}

export async function getCategorySpend(month: string) {
  const [categories, transactions, installments, purchases] = await Promise.all([
    db.categories.toArray(), db.transactions.where('month').equals(month).toArray(), db.installments.where('dueMonth').equals(month).toArray(), db.purchases.toArray(),
  ]);
  return categories.map((category) => {
    const direct = transactions.filter((tx) => tx.type === 'expense' && tx.status !== 'cancelled' && tx.categoryId === category.id).reduce((sum, tx) => sum + tx.amountCents, 0);
    const purchaseIds = new Set(purchases.filter((purchase) => purchase.categoryId === category.id).map((purchase) => purchase.id));
    const credit = installments.filter((item) => purchaseIds.has(item.purchaseId)).reduce((sum, item) => sum + item.amountCents, 0);
    return { category, spentCents: direct + credit };
  }).filter((item) => item.spentCents > 0);
}

export async function getTransactionsForMonth(month: string): Promise<Transaction[]> {
  return db.transactions.where('month').equals(month).reverse().sortBy('date');
}

export async function getInstallmentsForMonth(month: string): Promise<Installment[]> {
  return db.installments.where('dueMonth').equals(month).toArray();
}
