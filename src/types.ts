export type ID = string;
export type TxStatus = 'paid' | 'pending' | 'received' | 'receivable' | 'cancelled';
export type ExpenseClass = 'Investimento' | 'Essencial' | 'Supérfluo';
export type AccountType = 'checking' | 'savings' | 'cash' | 'payment' | 'other';

export interface Category {
  id: ID; name: string; color: string; icon: string; parentId?: ID; sortOrder: number; archived?: boolean;
}
export interface Account {
  id: ID; name: string; institution: string; type: AccountType; initialBalanceCents: number; identifier?: string; createdAt: string;
}
export interface Card {
  id: ID; name: string; institution: string; brand: string; limitCents: number; closingDay: number; dueDay: number; color: string; createdAt: string; kind?: 'credit';
}
export type RecurringFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export interface RecurringTransaction {
  id: ID; type: 'income' | 'expense'; description: string; amountCents: number; frequency: RecurringFrequency;
  startDate: string; endDate?: string; categoryId?: ID; expenseClass?: ExpenseClass;
  paymentMode: 'pix' | 'cash' | 'card-debit' | 'other'; accountId?: ID; notes?: string;
  active: boolean; excludedDates?: string[]; createdAt: string;
}
export interface TransactionTemplate {
  id: ID; name: string; type: 'income' | 'expense'; description: string; amountCents: number;
  categoryId?: ID; expenseClass?: ExpenseClass; paymentMode: 'pix' | 'cash' | 'card-debit' | 'other';
  accountId?: ID; notes?: string; createdAt: string;
}

export interface Transaction {
  id: ID; type: 'income' | 'expense'; description: string; amountCents: number; date: string; month: string;
  categoryId?: ID; expenseClass?: ExpenseClass; status: TxStatus; paymentMode: 'pix' | 'cash' | 'card-debit' | 'card-credit' | 'other' | 'reserve-plans';
  accountId?: ID; reserveId?: ID; notes?: string; recurringId?: ID; recurringDate?: string; createdAt: string;
}
export interface Purchase {
  id: ID; description: string; totalCents: number; cardId: ID; categoryId?: ID; expenseClass?: ExpenseClass; purchaseDate: string;
  firstDueMonth: string; installmentsCount: number; createdAt: string; notes?: string;
  /** Purchases created from a debt entry are linked to that debtor record. */
  isDebtorCredit?: boolean;
  /** Family card purchases use the card limit but are excluded from personal expenses and patrimony. */
  isFamilyDebt?: boolean;
}
export interface Installment {
  id: ID; purchaseId: ID; cardId: ID; number: number; count: number; amountCents: number; paidCents: number;
  dueMonth: string; dueDate: string;
}
export interface InvoicePayment {
  id: ID; cardId: ID; accountId: ID; month: string; amountCents: number; date: string; allocations: { installmentId: ID; amountCents: number }[];
}
export interface Transfer {
  id: ID; fromAccountId: ID; toAccountId: ID; amountCents: number; date: string; description?: string;
}
export interface Debtor {
  id: ID; person: string; description: string; originalCents: number; originDate: string; dueDate?: string;
  categoryId?: ID; originalPayment?: string; originAccountId?: ID; notes?: string; linkedTransactionId?: ID; sharedExpenseId?: ID; sharedPurchaseId?: ID; createdAt: string;
}
export interface DebtorPayment {
  id: ID; debtorId: ID; accountId: ID; amountCents: number; date: string; linkedTransactionId?: ID; notes?: string;
}
export interface Reserve {
  id: ID; name: string; targetCents: number; createdAt: string; targetDate?: string; notes?: string; closed?: boolean;
  annualYieldPercent?: number; lastYieldDate?: string; yieldRemainderCents?: number;
}
export interface ReserveMovement {
  id: ID; reserveId: ID; type: 'deposit' | 'withdrawal' | 'yield' | 'adjustment'; amountCents: number; date: string; notes?: string;
  /** Only the amount added to the reserve after this feature was enabled affects free bank cash. */
  availableBalanceImpactCents?: number; linkedTransactionId?: ID; linkedClosingId?: ID;
}
export interface ReserveClosing {
  id: ID; reserveId: ID; month: string; estimatedBalanceCents: number; actualBalanceCents: number;
  differenceCents: number; closedAt: string;
}
export interface WishlistPurchase {
  id: ID; description: string; amountCents: number; date: string; notes?: string; createdAt: string;
}
export interface MonthlyBudget { id: ID; month: string; categoryId: ID; budgetCents: number; }
export interface MonthRecord { id: string; month: string; createdAt: string; }
export interface Investment {
  id: ID; name: string; institution: string; initialCents: number; balanceCents: number; cdiPercent: number;
  initialDate: string; lastAccrualDate?: string; createdAt: string;
}
export interface InvestmentMovement {
  id: ID; investmentId: ID; accountId: ID; type: 'contribution' | 'withdrawal'; amountCents: number; date: string; notes?: string;
}
export interface CdiRate { id: string; date: string; annualRate: number; source: string; }
export interface CdiAccrual { id: string; investmentId: ID; date: string; rateDaily: number; amountCents: number; balanceAfterCents: number; }
export interface Setting { key: string; value: unknown; }

export type PageKey = 'dashboard' | 'months' | 'calendar' | 'transactions' | 'recurring' | 'comparison' | 'templates' | 'categories' | 'accounts' | 'cards' | 'invoices' | 'installments' | 'debtors' | 'reserves' | 'reports' | 'forecast' | 'patrimony' | 'settings' | 'wishlist';
