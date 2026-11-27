import Dexie, { type Table } from 'dexie';
import { firstUsageMonth } from './format';
import type {
  Account, Card, Category, CdiAccrual, CdiRate, Debtor, DebtorPayment, Installment, Investment,
  InvestmentMovement, InvoicePayment, MonthRecord, MonthlyBudget, Purchase, Reserve, ReserveClosing, ReserveMovement,
  Setting, Transaction, Transfer, WishlistPurchase,
} from '../types';

class NexoDatabase extends Dexie {
  categories!: Table<Category, string>;
  accounts!: Table<Account, string>;
  cards!: Table<Card, string>;
  transactions!: Table<Transaction, string>;
  purchases!: Table<Purchase, string>;
  installments!: Table<Installment, string>;
  invoicePayments!: Table<InvoicePayment, string>;
  transfers!: Table<Transfer, string>;
  debtors!: Table<Debtor, string>;
  debtorPayments!: Table<DebtorPayment, string>;
  reserves!: Table<Reserve, string>;
  reserveMovements!: Table<ReserveMovement, string>;
  reserveClosings!: Table<ReserveClosing, string>;
  monthlyBudgets!: Table<MonthlyBudget, string>;
  months!: Table<MonthRecord, string>;
  investments!: Table<Investment, string>;
  investmentMovements!: Table<InvestmentMovement, string>;
  cdiRates!: Table<CdiRate, string>;
  cdiAccruals!: Table<CdiAccrual, string>;
  settings!: Table<Setting, string>;
  wishlistPurchases!: Table<WishlistPurchase, string>;

  constructor() {
    super('NexoFinanceiro');
    this.version(1).stores({
      categories: 'id, name, parentId, sortOrder',
      accounts: 'id, name, institution, type',
      cards: 'id, name, institution',
      transactions: 'id, type, date, month, categoryId, status, accountId, paymentMode',
      purchases: 'id, cardId, purchaseDate, firstDueMonth, categoryId',
      installments: 'id, purchaseId, cardId, dueMonth, [cardId+dueMonth]',
      invoicePayments: 'id, cardId, accountId, month, date',
      transfers: 'id, fromAccountId, toAccountId, date',
      debtors: 'id, person, dueDate, linkedTransactionId',
      debtorPayments: 'id, debtorId, accountId, date',
      reserves: 'id, name, closed',
      reserveMovements: 'id, reserveId, date, type',
      monthlyBudgets: 'id, month, categoryId, [month+categoryId]',
      months: 'id, month',
      investments: 'id, name, institution',
      investmentMovements: 'id, investmentId, date, type',
      cdiRates: 'id, date',
      cdiAccruals: 'id, investmentId, date, [investmentId+date]',
      settings: 'key',
    });
    this.version(2).stores({
      debtors: 'id, person, dueDate, linkedTransactionId, categoryId, originAccountId, sharedExpenseId, sharedPurchaseId',
      wishlistPurchases: 'id, date',
    });
    this.version(3).stores({
      reserveClosings: 'id, reserveId, month, [reserveId+month]',
    });
  }
}

export const db = new NexoDatabase();

const defaultCategoryNames = [
  'Alimentação', 'Assinaturas', 'Beleza', 'Contas', 'Diversos', 'Doação', 'Educação',
  'Entretenimento', 'Investimentos', 'Lazer', 'Moradia', 'Pets', 'Presentes', 'Roupas', 'Saúde',
  'Trabalho', 'Transporte', 'Viagens',
];
const defaultInstitutions = ['MercadoPago', 'Bradesco', 'Inter', 'NuBank'];

export async function initializeDatabase() {
  const count = await db.categories.count();
  if (count === 0) {
    await db.categories.bulkPut(defaultCategoryNames.map((name, index) => ({
      id: `default-category-${index + 1}`, name, color: ['#7c3aed', '#a78bfa', '#c4b5fd'][index % 3], icon: 'circle', sortOrder: index,
    })));
  }
  // Remove the old built-in "Devedores" category without touching custom categories.
  const legacyDebtorCategory = await db.categories.get('default-category-5');
  if (legacyDebtorCategory?.name === 'Devedores') {
    await db.transaction('rw', db.categories, db.transactions, db.purchases, db.debtors, db.monthlyBudgets, async () => {
      await db.transactions.where('categoryId').equals(legacyDebtorCategory.id).modify({ categoryId: undefined });
      await db.purchases.where('categoryId').equals(legacyDebtorCategory.id).modify({ categoryId: undefined });
      await db.debtors.where('categoryId').equals(legacyDebtorCategory.id).modify({ categoryId: undefined });
      await db.monthlyBudgets.where('categoryId').equals(legacyDebtorCategory.id).delete();
      await db.categories.delete(legacyDebtorCategory.id);
    });
  }
  const accountCount = await db.accounts.count();
  if (accountCount === 0) {
    await db.accounts.bulkPut([
      ...defaultInstitutions.map((institution) => ({
        id: `default-account-${institution.toLowerCase()}`, name: institution, institution, type: 'payment' as const, initialBalanceCents: 0, createdAt: new Date().toISOString(),
      })),
      { id: 'default-account-cash', name: 'Dinheiro', institution: 'Dinheiro', type: 'cash' as const, initialBalanceCents: 0, createdAt: new Date().toISOString() },
    ]);
  }
  const cardCount = await db.cards.count();
  if (cardCount === 0) {
    const banks = await db.accounts.toArray();
    const initialCards = [
      { name: 'Cartão MP', institution: 'MercadoPago', color: '#6d28d9' },
      { name: 'Cartão Inter', institution: 'Inter', color: '#f97316' },
      { name: 'Cartão NuBank', institution: 'NuBank', color: '#7c3aed' },
    ];
    await db.cards.bulkPut(initialCards.map((card) => ({
      id: `default-card-${card.institution.toLowerCase()}`, ...card, brand: 'Não informada', kind: 'credit' as const, limitCents: 0, closingDay: 1, dueDay: 10, createdAt: new Date().toISOString(),
    })).filter((card) => banks.some((bank) => bank.institution === card.institution)));
  }
  const currentMonth = firstUsageMonth();
  if (!(await db.months.get(currentMonth))) {
    await db.months.put({ id: currentMonth, month: currentMonth, createdAt: new Date().toISOString() });
  }
  if (!(await db.settings.get('privacyNoticeDismissed'))) await db.settings.put({ key: 'privacyNoticeDismissed', value: false });

  // Preserve the reserve balance that already existed when this accounting rule
  // was introduced. Only deposits made after this one-time migration reduce free cash.
  if (!(await db.settings.get('reserveBalanceTrackingInitialized'))) {
    await db.transaction('rw', db.settings, db.reserveMovements, async () => {
      const existingMovements = await db.reserveMovements.toArray();
      for (const movement of existingMovements) {
        await db.reserveMovements.update(movement.id, { availableBalanceImpactCents: 0 });
      }
      await db.settings.put({ key: 'reserveBalanceTrackingInitialized', value: true });
    });
  }
}
