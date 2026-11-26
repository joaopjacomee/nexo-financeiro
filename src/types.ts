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
export interface Transaction {
  id: ID; type: 'income' | 'expense'; description: string; amountCents: number; date: string; month: string;
  categoryId?: ID; expenseClass?: ExpenseClass; status: TxStatus; paymentMode: 'pix' | 'cash' | 'card-debit' | 'card-credit' | 'other';
  accountId?: ID; notes?: string; createdAt: string;
}
export interface Purchase {
  id: ID; description: string; totalCents: number; cardId: ID; categoryId?: ID; expenseClass?: ExpenseClass; purchaseDate: string;
  firstDueMonth: string; installmentsCount: number; createdAt: string; notes?: string;
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
  categoryId?: ID; originalPayment?: string; originAccountId?: ID; notes?: string; linkedTransactionId?: ID; createdAt: string;
}
export interface DebtorPayment {
  id: ID; debtorId: ID; accountId: ID; amountCents: number; date: string; linkedTransactionId?: ID; notes?: string;
}
export interface Reserve {
  id: ID; name: string; targetCents: number; createdAt: string; targetDate?: string; notes?: string; closed?: boolean;
  annualYieldPercent?: number; lastYieldDate?: string; yieldRemainderCents?: number;
}
export interface ReserveMovement {
  id: ID; reserveId: ID; type: 'deposit' | 'withdrawal' | 'yield'; amountCents: number; date: string; notes?: string;
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

export type PageKey = 'dashboard' | 'months' | 'transactions' | 'categories' | 'accounts' | 'cards' | 'invoices' | 'installments' | 'debtors' | 'reserves' | 'reports' | 'calendar' | 'forecast' | 'patrimony' | 'settings';
