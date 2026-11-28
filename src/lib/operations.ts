import { db, initializeDatabase } from './db';
import { daysInMonth, makeId, monthOffset, today } from './format';
import { allocateInvoicePayment, calculateDailyCdiRate, calculateDailyReserveRate, calculateReserveWithdrawalImpactCents, calculateUnpaidCardCommitmentCents, isBrazilBankBusinessDay, isMonthInAccountingPeriod, mergeBackupRecords, splitInstallmentCents, FINANCIAL_START_MONTH, isTransactionVisibleByDate } from './calculations';
import type { Account, Card, CdiRate, Debtor, Investment, Reserve, ReserveClosing, Transaction, RecurringTransaction, RecurringFrequency, TransactionTemplate } from '../types';

type SharedDebtInput = { id?: string; person: string; amountCents: number };
function normalizeSharedDebtInputs(value?: SharedDebtInput | SharedDebtInput[]): SharedDebtInput[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => ({
    id: item.id,
    person: typeof item.person === 'string' ? item.person.trim() : '',
    amountCents: Number(item.amountCents),
  }));
}
function validateSharedDebtInputs(links: SharedDebtInput[], totalCents: number) {
  const people = new Set<string>();
  let allocatedCents = 0;
  for (const link of links) {
    const key = link.person.trim().toLocaleLowerCase('pt-BR');
    if (!key) throw new Error('Informe o nome de cada pessoa vinculada.');
    if (people.has(key)) throw new Error('Cada pessoa só pode aparecer uma vez nesta divisão.');
    people.add(key);
    if (!Number.isSafeInteger(link.amountCents) || link.amountCents <= 0) {
      throw new Error('Informe um valor válido para cada pessoa vinculada.');
    }
    allocatedCents += link.amountCents;
    if (!Number.isSafeInteger(allocatedCents) || allocatedCents > totalCents) {
      throw new Error('A soma dos valores vinculados não pode superar o total da compra ou despesa.');
    }
  }
}


export async function saveTransaction(input: Omit<Transaction, 'id' | 'createdAt' | 'month'> & {
  id?: string;
  sharedWith?: SharedDebtInput | SharedDebtInput[];
}) {
  const { sharedWith, ...transactionInput } = input;
  const sharedLinks = normalizeSharedDebtInputs(sharedWith);
  if (!transactionInput.description.trim()) throw new Error('Informe uma descrição.');
  if (!Number.isSafeInteger(transactionInput.amountCents) || transactionInput.amountCents <= 0) throw new Error('Informe um valor válido maior que zero.');
  if (transactionInput.status !== 'cancelled' && !['other', 'reserve-plans'].includes(transactionInput.paymentMode) && !transactionInput.accountId) throw new Error('Selecione a conta utilizada.');
  if (transactionInput.paymentMode === 'reserve-plans' && transactionInput.type !== 'expense') throw new Error('Reserva de planos só pode ser usada em despesas.');
  if (sharedLinks.length && transactionInput.type !== 'expense') throw new Error('Somente despesas podem ter valores vinculados a receber.');
  if (sharedLinks.length && transactionInput.paymentMode === 'card-credit') throw new Error('Registre compras no crédito pela opção de parcelamento.');
  validateSharedDebtInputs(sharedLinks, transactionInput.amountCents);

  const value: Transaction = {
    ...transactionInput,
    id: transactionInput.id ?? makeId(),
    month: transactionInput.date.slice(0, 7),
    createdAt: new Date().toISOString(),
  };
  const existingShared = transactionInput.id
    ? await db.debtors.where('sharedExpenseId').equals(transactionInput.id).toArray()
    : [];
  const allDebtorPayments = existingShared.length ? await db.debtorPayments.toArray() : [];
  const normalizePerson = (name: string) => name.trim().toLocaleLowerCase('pt-BR');
  const retainedDebtorIds = new Set<string>();
  const sharedDebtorRows: Debtor[] = [];

  for (const link of sharedLinks) {
    const existingById = link.id ? existingShared.find((item) => item.id === link.id) : undefined;
    if (link.id && !existingById) throw new Error('Uma das dívidas vinculadas não pertence a esta despesa.');
    const existing = existingById ?? existingShared.find((item) =>
      !retainedDebtorIds.has(item.id) && normalizePerson(item.person) === normalizePerson(link.person)
    );
    const receivedCents = existing
      ? allDebtorPayments.filter((payment) => payment.debtorId === existing.id).reduce((sum, payment) => sum + payment.amountCents, 0)
      : 0;
    if (existing && receivedCents > link.amountCents) {
      throw new Error('O valor devido a ' + existing.person + ' não pode ser menor que o que já foi recebido.');
    }
    if (existing && receivedCents > 0 && normalizePerson(existing.person) !== normalizePerson(link.person)) {
      throw new Error('Esta pessoa já recebeu parte da dívida. Não é possível trocar seu nome neste vínculo.');
    }
    const id = existing?.id ?? makeId();
    retainedDebtorIds.add(id);
    sharedDebtorRows.push({
      id,
      person: link.person,
      description: 'Divisão da conta: ' + value.description.trim(),
      originalCents: link.amountCents,
      originDate: value.date,
      categoryId: value.categoryId,
      originalPayment: 'Conta dividida',
      originAccountId: value.accountId,
      notes: value.notes,
      sharedExpenseId: value.id,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  for (const existing of existingShared) {
    if (retainedDebtorIds.has(existing.id)) continue;
    const receivedCents = allDebtorPayments.filter((payment) => payment.debtorId === existing.id).reduce((sum, payment) => sum + payment.amountCents, 0);
    if (receivedCents > 0) {
      throw new Error('A dívida de ' + existing.person + ' já recebeu pagamentos. Não é possível removê-la desta despesa.');
    }
  }

  const existingReserveMovement = transactionInput.id
    ? await db.reserveMovements.filter((item) => item.linkedTransactionId === transactionInput.id).first()
    : undefined;
  let plansReserve = undefined;
  if (transactionInput.paymentMode === 'reserve-plans') {
    plansReserve = await db.reserves.filter((item) => item.name.trim().toLocaleLowerCase('pt-BR') === 'planos' && !item.closed).first();
    if (!plansReserve) throw new Error('Crie ou reabra a caixinha Planos antes de usar esta forma de pagamento.');
    const reserveMoves = await db.reserveMovements.where('reserveId').equals(plansReserve.id).toArray();
    const balance = reserveMoves.reduce((sum, item) => sum + (item.type === 'withdrawal' ? -item.amountCents : item.amountCents), 0);
    const restored = existingReserveMovement?.reserveId === plansReserve.id ? existingReserveMovement.amountCents : 0;
    if (transactionInput.amountCents > balance + restored) throw new Error('O saldo da caixinha Planos é insuficiente.');
  }

  await db.transaction('rw', [db.transactions, db.months, db.debtors, db.debtorPayments, db.reserves, db.reserveMovements], async () => {
    if (existingReserveMovement) await db.reserveMovements.delete(existingReserveMovement.id);
    const transactionValue: Transaction = {
      ...value,
      accountId: transactionInput.paymentMode === 'reserve-plans' ? undefined : value.accountId,
      reserveId: plansReserve?.id,
    };
    await db.transactions.put(transactionValue);
    if (plansReserve) await db.reserveMovements.add({
      id: makeId(), reserveId: plansReserve.id, type: 'withdrawal', amountCents: transactionInput.amountCents,
      date: transactionInput.date, notes: 'Despesa: ' + transactionInput.description.trim(), linkedTransactionId: transactionValue.id,
      availableBalanceImpactCents: -transactionInput.amountCents,
    });
    await db.months.put({ id: value.month, month: value.month, createdAt: new Date().toISOString() });
    if (sharedDebtorRows.length) await db.debtors.bulkPut(sharedDebtorRows);
    const removedIds = existingShared.filter((item) => !retainedDebtorIds.has(item.id)).map((item) => item.id);
    if (removedIds.length) {
      await db.debtors.bulkDelete(removedIds);
      await db.debtorPayments.where('debtorId').anyOf(removedIds).delete();
    }
  });

  return value;
}


function recurringDateAtIndex(startDate: string, frequency: RecurringFrequency, index: number): string {
  const [year, month, day] = startDate.split('-').map(Number);
  if (frequency === 'daily' || frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : 14;
    return new Date(Date.UTC(year, month - 1, day + index * step)).toISOString().slice(0, 10);
  }
  if (frequency === 'monthly') {
    const target = new Date(Date.UTC(year, month - 1 + index, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10);
  }
  const targetYear = year + index;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
function firstRecurringIndex(startDate: string, minDate: string, frequency: RecurringFrequency): number {
  if (minDate <= startDate) return 0;
  const [sy, sm] = startDate.split('-').map(Number);
  const [my, mm] = minDate.split('-').map(Number);
  const monthGap = (my - sy) * 12 + mm - sm;
  const dayGap = Math.floor((Date.parse(minDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000);
  if (frequency === 'daily') return Math.max(0, dayGap);
  if (frequency === 'weekly') return Math.max(0, Math.ceil(dayGap / 7));
  if (frequency === 'biweekly') return Math.max(0, Math.ceil(dayGap / 14));
  if (frequency === 'monthly') return Math.max(0, monthGap);
  return Math.max(0, my - sy);
}

export async function saveRecurringTransaction(input: Omit<RecurringTransaction, 'id' | 'createdAt' | 'active' | 'excludedDates'> & { id?: string }) {
  if (!input.description.trim()) throw new Error('Informe a descrição da movimentação recorrente.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor recorrente válido.');
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(input.startDate)) throw new Error('Informe uma data inicial válida.');
  if (input.endDate && (!/^\\d{4}-\\d{2}-\\d{2}$/.test(input.endDate) || input.endDate < input.startDate)) throw new Error('A data final deve ser igual ou posterior à data inicial.');
  if (!['daily', 'weekly', 'biweekly', 'monthly', 'yearly'].includes(input.frequency)) throw new Error('Selecione uma frequência.');
  if (!['pix', 'cash', 'card-debit', 'other'].includes(input.paymentMode)) throw new Error('Forma de pagamento não compatível com recorrência.');
  if (input.paymentMode !== 'other' && (!input.accountId || !(await db.accounts.get(input.accountId)))) throw new Error('Selecione uma conta válida para a recorrência.');
  const existing = input.id ? await db.recurringTransactions.get(input.id) : undefined;
  if (input.id && !existing) throw new Error('Movimentação recorrente não encontrada.');
  const value: RecurringTransaction = { ...input, id: input.id ?? makeId(), active: true, excludedDates: existing?.excludedDates ?? [], createdAt: existing?.createdAt ?? new Date().toISOString() };
  await db.recurringTransactions.put(value);
  await syncRecurringTransactions();
  return value;
}

export async function syncRecurringTransactions(referenceDate = today()): Promise<number> {
  const rules = await db.recurringTransactions.filter((item) => item.active).toArray();
  let createdCount = 0;
  const financialStart = FINANCIAL_START_MONTH + '-01';
  for (const rule of rules) {
    const effectiveStart = rule.startDate < financialStart ? financialStart : rule.startDate;
    let index = firstRecurringIndex(rule.startDate, effectiveStart, rule.frequency);
    for (let generated = 0; generated < 5000; generated += 1, index += 1) {
      const date = recurringDateAtIndex(rule.startDate, rule.frequency, index);
      if (date < effectiveStart) continue;
      if (rule.endDate && date > rule.endDate) break;
      if (!isTransactionVisibleByDate(date, referenceDate)) break;
      if (rule.excludedDates?.includes(date)) continue;
      const existing = await db.transactions.where('[recurringId+recurringDate]').equals([rule.id, date]).first();
      if (existing) {
        if (date <= referenceDate && (existing.status === 'pending' || existing.status === 'receivable')) {
          await db.transactions.update(existing.id, { status: existing.type === 'income' ? 'received' : 'paid' });
        }
        continue;
      }
      try {
        await saveTransaction({
          type: rule.type, description: rule.description, amountCents: rule.amountCents, date,
          categoryId: rule.categoryId, expenseClass: rule.type === 'expense' ? rule.expenseClass : undefined,
          status: date > referenceDate ? (rule.type === 'income' ? 'receivable' : 'pending') : (rule.type === 'income' ? 'received' : 'paid'),
          paymentMode: rule.paymentMode, accountId: rule.accountId, notes: rule.notes,
          recurringId: rule.id, recurringDate: date,
        });
        createdCount += 1;
      } catch (error) {
        console.warn('Não foi possível gerar a recorrência ' + rule.description + ' em ' + date + '.', error);
      }
    }
  }
  return createdCount;
}

export async function deleteRecurringTransaction(id: string) {
  const rule = await db.recurringTransactions.get(id);
  if (!rule) return;
  const generated = await db.transactions.where('recurringId').equals(id).toArray();
  const futureIds = generated.filter((item) => item.date > today()).map((item) => item.id);
  await db.transaction('rw', db.transactions, db.recurringTransactions, async () => {
    if (futureIds.length) await db.transactions.bulkDelete(futureIds);
    await db.recurringTransactions.delete(id);
  });
}

export async function saveTransactionTemplate(input: Omit<TransactionTemplate, 'id' | 'createdAt'> & { id?: string }) {
  if (!input.name.trim() || !input.description.trim()) throw new Error('Informe o nome do modelo e a descrição.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor válido para o modelo.');
  if (!['pix', 'cash', 'card-debit', 'other'].includes(input.paymentMode)) throw new Error('Forma de pagamento inválida para o modelo.');
  if (input.paymentMode !== 'other' && (!input.accountId || !(await db.accounts.get(input.accountId)))) throw new Error('Selecione uma conta válida.');
  const existing = input.id ? await db.transactionTemplates.get(input.id) : undefined;
  const value: TransactionTemplate = { ...input, id: input.id ?? makeId(), createdAt: existing?.createdAt ?? new Date().toISOString() };
  await db.transactionTemplates.put(value);
  return value;
}
export async function deleteTransactionTemplate(id: string) { await db.transactionTemplates.delete(id); }

export async function deleteTransaction(id: string) {
  const recurringTransaction = await db.transactions.get(id);
  if (recurringTransaction?.recurringId && recurringTransaction.recurringDate) {
    const rule = await db.recurringTransactions.get(recurringTransaction.recurringId);
    if (rule) await db.recurringTransactions.update(rule.id, { excludedDates: [...new Set([...(rule.excludedDates ?? []), recurringTransaction.recurringDate])] });
  }
  const sharedDebtors = await db.debtors.where('sharedExpenseId').equals(id).toArray();
  if (sharedDebtors.length) {
    for (const debtor of sharedDebtors) await deleteDebtor(debtor.id);
    await db.reserveMovements.filter((item) => item.linkedTransactionId === id).delete();
    await db.transactions.delete(id);
    return;
  }
  const debtor = await db.debtors.filter((item) => item.linkedTransactionId === id).first();
  if (debtor) {
    await deleteDebtor(debtor.id);
    await db.reserveMovements.filter((item) => item.linkedTransactionId === id).delete();
    return;
  }
  const payment = await db.debtorPayments.filter((item) => item.linkedTransactionId === id).first();
  if (payment) return deleteDebtorPayment(payment.id);
  await db.reserveMovements.filter((item) => item.linkedTransactionId === id).delete();
  await db.transactions.delete(id);
}

export async function saveAccount(input: Omit<Account, 'id' | 'createdAt'> & { id?: string }) {
  if (!input.name.trim()) throw new Error('Informe o nome da conta.');
  if (!Number.isSafeInteger(input.initialBalanceCents)) throw new Error('Saldo inicial inválido.');
  const value: Account = { ...input, id: input.id ?? makeId(), createdAt: new Date().toISOString() };
  await db.accounts.put(value);
  return value;
}

export async function saveCard(input: Omit<Card, 'id' | 'createdAt'> & { id?: string }) {
  if (!input.name.trim()) throw new Error('Informe o nome do cartão.');
  if (input.limitCents < 0 || input.closingDay < 1 || input.closingDay > 31 || input.dueDay < 1 || input.dueDay > 31) throw new Error('Confira limite e dias de fechamento/vencimento.');
  const value: Card = { ...input, kind: input.kind ?? 'credit', id: input.id ?? makeId(), createdAt: new Date().toISOString() };
  await db.cards.put(value);
  return value;
}

export async function createCardPurchase(input: {
  description: string; totalCents: number; cardId: string; categoryId?: string; expenseClass?: Transaction['expenseClass']; purchaseDate: string; firstDueMonth: string; installmentsCount: number; notes?: string;
  sharedWith?: SharedDebtInput | SharedDebtInput[];
}) {
  if (!input.description.trim()) throw new Error('Informe a descrição da compra.');
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents <= 0) throw new Error('Valor da compra inválido.');
  if (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1 || input.installmentsCount > 240) throw new Error('Quantidade de parcelas inválida (1 a 240).');
  const sharedLinks = normalizeSharedDebtInputs(input.sharedWith);
  validateSharedDebtInputs(sharedLinks, input.totalCents);
  const card = await db.cards.get(input.cardId);
  if (!card) throw new Error('Cartão não encontrado.');
  const committed = await db.installments.where('cardId').equals(card.id).toArray();
  const currentCommitment = calculateUnpaidCardCommitmentCents(committed);
  if (card.limitCents > 0 && input.totalCents + currentCommitment > card.limitCents) {
    throw new Error('A compra excede o limite cadastrado do cartão. Limite livre estimado: R$ ' + ((card.limitCents - currentCommitment) / 100).toFixed(2) + '.');
  }

  const purchaseId = makeId();
  const createdAt = new Date().toISOString();
  const purchase = {
    id: purchaseId, description: input.description.trim(), totalCents: input.totalCents, cardId: input.cardId,
    categoryId: input.categoryId, expenseClass: input.expenseClass, purchaseDate: input.purchaseDate, firstDueMonth: input.firstDueMonth,
    installmentsCount: input.installmentsCount, createdAt, notes: input.notes,
  };
  const installmentAmounts = splitInstallmentCents(input.totalCents, input.installmentsCount);
  const installments = Array.from({ length: input.installmentsCount }, (_, index) => {
    const dueMonth = monthOffset(input.firstDueMonth, index);
    const day = Math.min(card.dueDay, daysInMonth(dueMonth));
    return {
      id: makeId(), purchaseId, cardId: input.cardId, number: index + 1, count: input.installmentsCount,
      amountCents: installmentAmounts[index], paidCents: 0, dueMonth,
      dueDate: dueMonth + '-' + String(day).padStart(2, '0'),
    };
  });
  const debtors: Debtor[] = sharedLinks.map((link) => ({
    id: makeId(),
    person: link.person,
    description: 'Divisão da conta: ' + purchase.description,
    originalCents: link.amountCents,
    originDate: input.purchaseDate,
    categoryId: input.categoryId,
    originalPayment: 'Cartão de crédito',
    notes: input.notes,
    sharedPurchaseId: purchaseId,
    createdAt,
  }));
  await db.transaction('rw', db.purchases, db.installments, db.months, db.debtors, async () => {
    await db.purchases.add(purchase);
    await db.installments.bulkAdd(installments);
    await db.months.bulkPut([...new Set(installments.map((item) => item.dueMonth))].map((month) => ({ id: month, month, createdAt })));
    if (debtors.length) await db.debtors.bulkAdd(debtors);
  });
  return purchase;
}

export async function importPurchasesFromJson(payload: unknown): Promise<{
  importedCount: number;
  totalCents: number;
  debtorCount: number;
  paymentModeCounts: Record<string, number>;
}> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('O JSON precisa ser um objeto com uma lista "purchases" ou "transactions".');
  }
  const data = payload as Record<string, unknown>;
  const rawRows = Array.isArray(data.purchases) ? data.purchases : data.transactions;
  if (!Array.isArray(rawRows) || rawRows.length === 0 || rawRows.length > 500) {
    throw new Error('O campo "purchases" ou "transactions" precisa conter de 1 a 500 registros.');
  }

  const normalize = (value: string) => value.trim().toLocaleLowerCase('pt-BR');
  const normalizeMode = (value: unknown): Transaction['paymentMode'] | undefined => {
    if (typeof value !== 'string') return undefined;
    const key = normalize(value);
    const aliases: Record<string, Transaction['paymentMode']> = {
      pix: 'pix', dinheiro: 'cash', cash: 'cash',
      'cartão de débito': 'card-debit', 'cartao de debito': 'card-debit', 'card-debit': 'card-debit', debit: 'card-debit',
      'cartão de crédito': 'card-credit', 'cartao de credito': 'card-credit', 'card-credit': 'card-credit', credit: 'card-credit',
      outro: 'other', other: 'other',
      'reserva de planos': 'reserve-plans', 'reserve-plans': 'reserve-plans', planos: 'reserve-plans',
    };
    return aliases[key];
  };
  const modeLabel = (mode: Transaction['paymentMode']) => ({
    pix: 'Pix', cash: 'Dinheiro', 'card-debit': 'Cartão de débito',
    'card-credit': 'Cartão de crédito', other: 'Outro', 'reserve-plans': 'Reserva de planos',
  }[mode]);
  const validMonth = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const validDate = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const addMonth = (date: string) => {
    const [year, month] = date.slice(0, 7).split('-').map(Number);
    const next = new Date(year, month, 1);
    return next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0');
  };

  const [categories, accounts, cards, existingDebtors] = await Promise.all([
    db.categories.toArray(), db.accounts.toArray(), db.cards.toArray(), db.debtors.toArray(),
  ]);
  const resolveCategory = (row: Record<string, unknown>, index: number, description: string) => {
    const rawCategory = typeof row.category === 'string' ? row.category.trim()
      : typeof row.categoryName === 'string' ? row.categoryName.trim() : '';
    const legacyDebtorCategory = normalize(rawCategory) === 'devedores';
    let categoryId: string | undefined;
    if (row.categoryId !== undefined && typeof row.categoryId === 'string') {
      if (!categories.some((item) => item.id === row.categoryId)) {
        throw new Error('Registro ' + (index + 1) + ' (' + description + '): categoria não encontrada.');
      }
      categoryId = row.categoryId;
    } else if (rawCategory && !legacyDebtorCategory) {
      const found = categories.find((item) => normalize(item.name) === normalize(rawCategory));
      if (!found) throw new Error('Registro ' + (index + 1) + ' (' + description + '): categoria "' + rawCategory + '" não existe neste NEXO.');
      categoryId = found.id;
    }
    return { categoryId, legacyDebtorCategory };
  };

  const rootMode = normalizeMode(data.paymentMode);
  if (data.paymentMode !== undefined && !rootMode) {
    throw new Error('Forma de pagamento padrão inválida. Use pix, cash, card-debit, card-credit, other ou reserve-plans.');
  }
  const rootCardValue = typeof data.card === 'string' ? data.card.trim()
    : typeof data.cardId === 'string' ? data.cardId.trim() : '';
  const legacyCreditBatch = Boolean(rootCardValue) && !data.paymentMode;
  const rootAccountValue = typeof data.account === 'string' ? data.account.trim()
    : typeof data.accountId === 'string' ? data.accountId.trim()
      : typeof data.accountName === 'string' ? data.accountName.trim() : '';
  const rootCount = data.installmentsCount === undefined ? 1 : Number(data.installmentsCount);
  if (!Number.isInteger(rootCount) || rootCount < 1 || rootCount > 240) {
    throw new Error('"installmentsCount" precisa ser um número inteiro entre 1 e 240.');
  }

  const entries = (rawRows as unknown[]).map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Registro ' + (index + 1) + ': item inválido.');
    }
    const row = raw as Record<string, unknown>;
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    if (!description) throw new Error('Registro ' + (index + 1) + ': informe a descrição.');
    const totalCents = Number(row.totalCents ?? row.amountCents);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): "totalCents" precisa ser um inteiro positivo em centavos.');
    }
    const purchaseDate = row.purchaseDate ?? row.date;
    if (!validDate(purchaseDate)) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): data inválida; use AAAA-MM-DD.');
    }
    const mode = normalizeMode(row.paymentMode) ?? rootMode ?? (legacyCreditBatch ? 'card-credit' : undefined);
    if (!mode) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): informe "paymentMode" no item ou no objeto principal do JSON.');
    }
    if (row.paymentMode !== undefined && !normalizeMode(row.paymentMode)) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): forma de pagamento inválida.');
    }
    const typeValue = typeof row.type === 'string' ? normalize(row.type) : 'expense';
    const type: Transaction['type'] = ['income', 'receita'].includes(typeValue) ? 'income' : 'expense';
    if (!['income', 'receita', 'expense', 'despesa', ''].includes(typeValue)) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): tipo deve ser "expense" ou "income".');
    }
    if (type === 'income' && (mode === 'card-credit' || mode === 'reserve-plans')) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): receita não pode usar crédito nem Reserva de planos.');
    }
    if (type === 'income' && (row.sharedWith !== undefined || row.debtor !== undefined)) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): receitas não podem ter pessoas vinculadas como devedoras.');
    }
    if (mode === 'reserve-plans' && type !== 'expense') {
      throw new Error('Reserva de planos só pode ser usada em despesas.');
    }

    const { categoryId, legacyDebtorCategory } = resolveCategory(row, index, description);
    const expenseClass = row.expenseClass;
    if (expenseClass !== undefined && !['Investimento', 'Essencial', 'Supérfluo'].includes(String(expenseClass))) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): classe de despesa inválida.');
    }
    const notes = typeof row.notes === 'string' ? row.notes.trim() : undefined;
    const rawShared = row.sharedWith;
    const rawDebtor = row.debtor;
    if (rawShared !== undefined && rawDebtor !== undefined) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): use "sharedWith" ou "debtor", não os dois.');
    }

    const sharedLinks: Array<{ person: string; amountCents: number }> = [];
    let debtorDue: { person: string; amountCents: number } | undefined;
    const readShared = (value: unknown, label: string) => {
      const rawLinks = Array.isArray(value) ? value : [value];
      if (!rawLinks.length) throw new Error('Registro ' + (index + 1) + ': "' + label + '" não pode estar vazio.');
      const names = new Set<string>();
      let allocated = 0;
      for (const rawLink of rawLinks) {
        if (!rawLink || typeof rawLink !== 'object' || Array.isArray(rawLink)) {
          throw new Error('Registro ' + (index + 1) + ': "' + label + '" deve conter pessoa e valor em centavos.');
        }
        const link = rawLink as Record<string, unknown>;
        const person = typeof link.person === 'string' ? link.person.trim() : '';
        const key = normalize(person);
        const amountCents = Number(link.amountCents);
        if (!key) throw new Error('Registro ' + (index + 1) + ': informe o nome de cada pessoa vinculada.');
        if (names.has(key)) throw new Error('Registro ' + (index + 1) + ': uma pessoa não pode aparecer duas vezes no mesmo registro.');
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
          throw new Error('Registro ' + (index + 1) + ': valor vinculado inválido para ' + person + '.');
        }
        allocated += amountCents;
        if (!Number.isSafeInteger(allocated) || allocated > totalCents) {
          throw new Error('Registro ' + (index + 1) + ': a soma dos valores vinculados supera o valor da compra.');
        }
        names.add(key);
        sharedLinks.push({ person, amountCents });
      }
    };
    if (rawShared !== undefined) readShared(rawShared, 'sharedWith');
    else if (rawDebtor !== undefined) {
      if (!rawDebtor || typeof rawDebtor !== 'object' || Array.isArray(rawDebtor)) {
        throw new Error('Registro ' + (index + 1) + ': "debtor" deve conter uma pessoa.');
      }
      const debt = rawDebtor as Record<string, unknown>;
      const person = typeof debt.person === 'string' ? debt.person.trim() : '';
      const amountCents = debt.amountCents === undefined ? totalCents : Number(debt.amountCents);
      if (!person || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > totalCents) {
        throw new Error('Registro ' + (index + 1) + ': pessoa ou valor devedor inválido.');
      }
      debtorDue = { person, amountCents };
    } else if (legacyDebtorCategory) {
      const noteMatch = notes?.match(/referente\s+(?:à|a)\s+(.+?)[.!]?$/i);
      const descriptionMatch = description.match(/\s-\s(.+)$/);
      const inferredPerson = noteMatch?.[1]?.trim() || descriptionMatch?.[1]?.trim() || '';
      if (!inferredPerson) throw new Error('Registro ' + (index + 1) + ': não foi possível identificar a pessoa da categoria Devedores.');
      debtorDue = { person: inferredPerson, amountCents: totalCents };
    }
    if (type === 'income' && (sharedLinks.length || debtorDue)) {
      throw new Error('Receitas não podem ter valores a receber vinculados.');
    }

    let cardId: string | undefined;
    let firstDueMonth: string | undefined;
    let installmentsCount = 1;
    if (mode === 'card-credit') {
      const rawCard = typeof row.card === 'string' ? row.card.trim()
        : typeof row.cardId === 'string' ? row.cardId.trim() : rootCardValue;
      if (!rawCard) throw new Error('Registro ' + (index + 1) + ' (' + description + '): informe o cartão no campo "card".');
      const card = cards.find((item) => item.id === rawCard || normalize(item.name) === normalize(rawCard));
      if (!card) throw new Error('Registro ' + (index + 1) + ' (' + description + '): cartão "' + rawCard + '" não está cadastrado neste NEXO.');
      cardId = card.id;
      const dueMonthValue = row.firstDueMonth ?? data.firstDueMonth;
      firstDueMonth = dueMonthValue === undefined ? addMonth(purchaseDate) : String(dueMonthValue);
      if (!validMonth(firstDueMonth)) {
        throw new Error('Registro ' + (index + 1) + ' (' + description + '): primeira fatura inválida; use AAAA-MM.');
      }
      installmentsCount = row.installmentsCount === undefined ? rootCount : Number(row.installmentsCount);
      if (!Number.isInteger(installmentsCount) || installmentsCount < 1 || installmentsCount > 240) {
        throw new Error('Registro ' + (index + 1) + ' (' + description + '): parcelas devem ser um inteiro entre 1 e 240.');
      }
    } else if (row.installmentsCount !== undefined && Number(row.installmentsCount) !== 1) {
      throw new Error('Registro ' + (index + 1) + ' (' + description + '): quantidade de parcelas só é válida para cartão de crédito.');
    }

    let accountId: string | undefined;
    if (['pix', 'cash', 'card-debit'].includes(mode)) {
      const rawAccount = typeof row.account === 'string' ? row.account.trim()
        : typeof row.accountId === 'string' ? row.accountId.trim()
          : typeof row.accountName === 'string' ? row.accountName.trim() : rootAccountValue;
      if (!rawAccount) {
        throw new Error('Registro ' + (index + 1) + ' (' + description + '): informe "account" ou "accountId" para esta forma de pagamento.');
      }
      const account = accounts.find((item) => item.id === rawAccount || normalize(item.name) === normalize(rawAccount));
      if (!account) {
        throw new Error('Registro ' + (index + 1) + ' (' + description + '): conta "' + rawAccount + '" não está cadastrada neste NEXO.');
      }
      accountId = account.id;
    }
    return {
      description, totalCents, purchaseDate, mode, type, accountId, cardId, firstDueMonth, installmentsCount,
      categoryId, expenseClass: expenseClass as Transaction['expenseClass'] | undefined,
      notes, sharedLinks, debtorDue,
    };
  });

  const modeCounts: Record<string, number> = {};
  for (const entry of entries) modeCounts[modeLabel(entry.mode)] = (modeCounts[modeLabel(entry.mode)] ?? 0) + 1;
  const totalCents = entries.reduce((sum, entry) => sum + entry.totalCents, 0);
  const creditTotals = new Map<string, number>();
  for (const entry of entries) if (entry.mode === 'card-credit' && entry.cardId) {
    const installmentAmounts = splitInstallmentCents(entry.totalCents, entry.installmentsCount);
    installmentAmounts.forEach((amountCents, index) => {
      const dueMonth = monthOffset(entry.firstDueMonth!, index);
      if (isMonthInAccountingPeriod(dueMonth)) {
        creditTotals.set(entry.cardId!, (creditTotals.get(entry.cardId!) ?? 0) + amountCents);
      }
    });
  }
  for (const [cardId, batchCommitment] of creditTotals) {
    const card = cards.find((item) => item.id === cardId)!;
    const currentInstallments = await db.installments.where('cardId').equals(cardId).toArray();
    const currentCommitment = calculateUnpaidCardCommitmentCents(currentInstallments);
    if (card.limitCents > 0 && batchCommitment + currentCommitment > card.limitCents) {
      throw new Error('A importação excede o limite cadastrado do cartão ' + card.name + '. Limite livre estimado: R$ ' + ((card.limitCents - currentCommitment) / 100).toFixed(2) + '.');
    }
  }

  const plansReserveEntries = entries.filter((entry) => entry.mode === 'reserve-plans');
  const plansReserve = plansReserveEntries.length
    ? await db.reserves.filter((item) => item.name.trim().toLocaleLowerCase('pt-BR') === 'planos' && !item.closed).first()
    : undefined;
  if (plansReserveEntries.length && !plansReserve) {
    throw new Error('Crie ou reabra a caixinha Planos antes de importar despesas dessa forma.');
  }
  if (plansReserve) {
    const reserveMoves = await db.reserveMovements.where('reserveId').equals(plansReserve.id).toArray();
    const available = reserveMoves.reduce((sum, item) => sum + (item.type === 'withdrawal' ? -item.amountCents : item.amountCents), 0);
    const requested = plansReserveEntries.reduce((sum, entry) => sum + entry.totalCents, 0);
    if (requested > available) throw new Error('O saldo da caixinha Planos é insuficiente para todas as despesas do JSON.');
  }

  const legacyCreditOnly = legacyCreditBatch && entries.every((entry) => entry.mode === 'card-credit' && entry.cardId === entries[0].cardId);
  const legacySignature = legacyCreditOnly ? JSON.stringify({
    cardId: entries[0].cardId,
    entries: entries.map((entry) => [
      entry.description, entry.totalCents, entry.purchaseDate, entry.firstDueMonth, entry.installmentsCount,
      entry.categoryId ?? '', entry.expenseClass ?? '', entry.notes ?? '',
      entry.sharedLinks.length === 1 ? entry.sharedLinks[0].person : '', entry.sharedLinks.length === 1 ? entry.sharedLinks[0].amountCents : 0,
      entry.debtorDue?.person ?? '', entry.debtorDue?.amountCents ?? 0,
    ]),
  }) : JSON.stringify(entries.map((entry) => [
    entry.description, entry.totalCents, entry.purchaseDate, entry.mode, entry.type, entry.accountId ?? '',
    entry.cardId ?? '', entry.firstDueMonth ?? '', entry.installmentsCount,
    entry.categoryId ?? '', entry.expenseClass ?? '', entry.notes ?? '',
    entry.sharedLinks, entry.debtorDue ?? null,
  ]));
  let hash = 2166136261;
  for (let index = 0; index < legacySignature.length; index += 1) {
    hash ^= legacySignature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = (hash >>> 0).toString(36);
  const idPrefix = (legacyCreditOnly ? 'json-' : 'json-batch-') + fingerprint;
  const createdAt = new Date().toISOString();
  const purchaseRows: Array<{
    id: string; description: string; totalCents: number; cardId: string; categoryId?: string;
    expenseClass?: Transaction['expenseClass']; purchaseDate: string; firstDueMonth: string;
    installmentsCount: number; createdAt: string; notes?: string;
  }> = [];
  const installmentRows: Array<{
    id: string; purchaseId: string; cardId: string; number: number; count: number; amountCents: number;
    paidCents: number; dueMonth: string; dueDate: string;
  }> = [];
  const transactionRows: Transaction[] = [];
  const debtorRows: Array<{
    id: string; person: string; description: string; originalCents: number; originDate: string;
    categoryId?: string; originalPayment?: string; originAccountId?: string;
    notes?: string; sharedExpenseId?: string; sharedPurchaseId?: string; createdAt: string;
  }> = [];
  const reserveMovementRows: Array<{
    id: string; reserveId: string; type: 'withdrawal'; amountCents: number; date: string;
    notes: string; linkedTransactionId: string; availableBalanceImpactCents: number;
  }> = [];
  const monthRecords = new Set<string>();
  entries.forEach((entry, index) => {
    const recordId = idPrefix + (legacyCreditOnly ? '-' : '-r-') + (index + 1);
    let linkedPurchaseId: string | undefined;
    if (entry.mode === 'card-credit') {
      const purchaseId = recordId;
      linkedPurchaseId = purchaseId;
      purchaseRows.push({
        id: purchaseId, description: entry.description, totalCents: entry.totalCents, cardId: entry.cardId!,
        categoryId: entry.categoryId, expenseClass: entry.expenseClass, purchaseDate: entry.purchaseDate,
        firstDueMonth: entry.firstDueMonth!, installmentsCount: entry.installmentsCount, createdAt, notes: entry.notes,
      });
      const installmentAmounts = splitInstallmentCents(entry.totalCents, entry.installmentsCount);
      installmentAmounts.forEach((amountCents, installmentIndex) => {
        const dueMonth = monthOffset(entry.firstDueMonth!, installmentIndex);
        const card = cards.find((item) => item.id === entry.cardId)!;
        const day = Math.min(card.dueDay, daysInMonth(dueMonth));
        installmentRows.push({
          id: idPrefix + (legacyCreditOnly ? '-i-' : '-ri-') + (index + 1) + '-' + (installmentIndex + 1),
          purchaseId, cardId: entry.cardId!, number: installmentIndex + 1, count: entry.installmentsCount,
          amountCents, paidCents: 0, dueMonth, dueDate: dueMonth + '-' + String(day).padStart(2, '0'),
        });
        monthRecords.add(dueMonth);
      });
    } else {
      const transactionId = recordId;
      const reserveId = entry.mode === 'reserve-plans' ? plansReserve?.id : undefined;
      transactionRows.push({
        id: transactionId, type: entry.type, description: entry.description, amountCents: entry.totalCents,
        date: entry.purchaseDate, month: entry.purchaseDate.slice(0, 7), categoryId: entry.categoryId,
        expenseClass: entry.type === 'expense' ? entry.expenseClass : undefined,
        status: entry.type === 'income' ? 'received' : 'paid', paymentMode: entry.mode,
        accountId: entry.accountId, reserveId, notes: entry.notes, createdAt,
      });
      monthRecords.add(entry.purchaseDate.slice(0, 7));
      if (reserveId) reserveMovementRows.push({
        id: idPrefix + '-rm-' + (index + 1), reserveId, type: 'withdrawal', amountCents: entry.totalCents,
        date: entry.purchaseDate, notes: 'Despesa: ' + entry.description, linkedTransactionId: transactionId,
        availableBalanceImpactCents: -entry.totalCents,
      });
    }

    const links = entry.sharedLinks.length ? entry.sharedLinks
      : entry.debtorDue ? [entry.debtorDue] : [];
    links.forEach((link, linkIndex) => debtorRows.push({
      id: idPrefix + (legacyCreditOnly ? '-d-' : '-d-') + (index + 1) + '-' + (linkIndex + 1),
      person: link.person,
      description: entry.sharedLinks.length
        ? 'Divisão da conta: ' + entry.description
        : 'Compra para ' + link.person + ': ' + entry.description,
      originalCents: link.amountCents, originDate: entry.purchaseDate, categoryId: entry.categoryId,
      originalPayment: modeLabel(entry.mode), originAccountId: entry.accountId,
      notes: entry.notes, sharedExpenseId: linkedPurchaseId ? undefined : recordId,
      sharedPurchaseId: linkedPurchaseId, createdAt,
    }));
  });

  const existingPurchases = await db.purchases.bulkGet(purchaseRows.map((item) => item.id));
  const existingTransactions = await db.transactions.bulkGet(transactionRows.map((item) => item.id));
  const existingInstallments = await db.installments.bulkGet(installmentRows.map((item) => item.id));
  const existingDebtorIds = await db.debtors.bulkGet(debtorRows.map((item) => item.id));
  if ([...existingPurchases, ...existingTransactions, ...existingInstallments, ...existingDebtorIds].some(Boolean)) {
    throw new Error('Este JSON já foi importado (ou contém registros já importados). Nenhum registro foi alterado.');
  }
  entries.forEach((entry) => { if (entry.mode === 'card-credit') monthRecords.add(entry.firstDueMonth!); });

  const monthRows = [...monthRecords].map((month) => ({ id: month, month, createdAt }));
  await db.transaction(
    'rw',
    [db.transactions, db.purchases, db.installments, db.months, db.debtors, db.reserves, db.reserveMovements],
    async () => {
      if (transactionRows.length) await db.transactions.bulkAdd(transactionRows);
      if (purchaseRows.length) await db.purchases.bulkAdd(purchaseRows);
      if (installmentRows.length) await db.installments.bulkAdd(installmentRows);
      if (monthRows.length) await db.months.bulkPut(monthRows);
      if (debtorRows.length) await db.debtors.bulkAdd(debtorRows);
      if (reserveMovementRows.length) await db.reserveMovements.bulkAdd(reserveMovementRows);
    },
  );

  return { importedCount: entries.length, totalCents, debtorCount: debtorRows.length, paymentModeCounts: modeCounts };
}

/**
 * Update a credit purchase and regenerate its installment schedule.
 * Existing payment allocations are kept attached to their installment IDs.
 */
/**
 * Update a credit purchase and regenerate its installment schedule.
 * Existing payment allocations and all linked debtor/payment records are preserved.
 */
export async function updateCardPurchase(input: {
  id: string; description: string; totalCents: number; cardId: string;
  categoryId?: string; expenseClass?: Transaction['expenseClass'];
  purchaseDate: string; firstDueMonth: string; installmentsCount: number;
  notes?: string; sharedWith?: SharedDebtInput | SharedDebtInput[];
}) {
  const purchase = await db.purchases.get(input.id);
  if (!purchase) throw new Error('Compra parcelada não encontrada.');
  if (!input.description.trim()) throw new Error('Informe a descrição da compra.');
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents <= 0) throw new Error('Valor da compra inválido.');
  if (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1 || input.installmentsCount > 240) {
    throw new Error('Quantidade de parcelas inválida (1 a 240).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.firstDueMonth)) {
    throw new Error('Confira a data da compra e o mês da primeira fatura.');
  }
  const card = await db.cards.get(input.cardId);
  if (!card) throw new Error('Cartão não encontrado.');
  if (input.categoryId && !(await db.categories.get(input.categoryId))) throw new Error('Categoria não encontrada.');
  if (input.expenseClass && !['Investimento', 'Essencial', 'Supérfluo'].includes(input.expenseClass)) {
    throw new Error('Classificação da despesa inválida.');
  }
  const sharedLinks = normalizeSharedDebtInputs(input.sharedWith);
  validateSharedDebtInputs(sharedLinks, input.totalCents);

  const currentInstallments = (await db.installments.where('purchaseId').equals(purchase.id).toArray())
    .sort((a, b) => a.number - b.number);
  if (!currentInstallments.length) throw new Error('As parcelas desta compra não foram encontradas.');
  const hasPayments = currentInstallments.some((item) => item.paidCents > 0);
  const scheduleChanged = input.cardId !== purchase.cardId
    || input.installmentsCount !== currentInstallments.length
    || input.firstDueMonth !== purchase.firstDueMonth;
  if (hasPayments && scheduleChanged) {
    throw new Error('Esta compra já tem parcelas pagas. Para preservar os pagamentos, não altere o cartão, a quantidade de parcelas ou o mês da primeira fatura.');
  }

  const existingDebtors = await db.debtors.where('sharedPurchaseId').equals(purchase.id).toArray();
  const allDebtorPayments = existingDebtors.length ? await db.debtorPayments.toArray() : [];
  const normalizePerson = (name: string) => name.trim().toLocaleLowerCase('pt-BR');
  const retainedDebtorIds = new Set<string>();
  const debtorRows: Debtor[] = [];

  for (const link of sharedLinks) {
    const existingById = link.id ? existingDebtors.find((item) => item.id === link.id) : undefined;
    if (link.id && !existingById) throw new Error('Uma das dívidas vinculadas não pertence a esta compra.');
    const existing = existingById ?? existingDebtors.find((item) =>
      !retainedDebtorIds.has(item.id) && normalizePerson(item.person) === normalizePerson(link.person)
    );
    const receivedCents = existing
      ? allDebtorPayments.filter((payment) => payment.debtorId === existing.id).reduce((sum, payment) => sum + payment.amountCents, 0)
      : 0;
    if (existing && receivedCents > link.amountCents) {
      throw new Error('O valor devido a ' + existing.person + ' não pode ser menor que o que já foi recebido.');
    }
    if (existing && receivedCents > 0 && normalizePerson(existing.person) !== normalizePerson(link.person)) {
      throw new Error('Esta pessoa já recebeu parte da dívida. Não é possível trocar seu nome neste vínculo.');
    }
    const id = existing?.id ?? makeId();
    retainedDebtorIds.add(id);
    debtorRows.push({
      id,
      person: link.person,
      description: 'Divisão da conta: ' + input.description.trim(),
      originalCents: link.amountCents,
      originDate: input.purchaseDate,
      categoryId: input.categoryId,
      originalPayment: 'Cartão de crédito',
      notes: input.notes,
      sharedPurchaseId: purchase.id,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  for (const existing of existingDebtors) {
    if (retainedDebtorIds.has(existing.id)) continue;
    const receivedCents = allDebtorPayments.filter((payment) => payment.debtorId === existing.id).reduce((sum, payment) => sum + payment.amountCents, 0);
    if (receivedCents > 0) {
      throw new Error('A dívida de ' + existing.person + ' já recebeu pagamentos. Não é possível removê-la desta compra.');
    }
  }

  const paidByNumber = currentInstallments.map((item) => item.paidCents);
  const totalPaidCents = paidByNumber.reduce((sum, value) => sum + value, 0);
  if (input.totalCents < totalPaidCents) {
    throw new Error('O novo valor da compra não pode ser menor que o total já pago nas faturas.');
  }
  const amounts = splitInstallmentCents(input.totalCents, input.installmentsCount);
  if (hasPayments) {
    for (let index = 0; index < amounts.length; index += 1) {
      amounts[index] = Math.max(amounts[index], paidByNumber[index] ?? 0);
    }
    let excess = amounts.reduce((sum, value) => sum + value, 0) - input.totalCents;
    for (let index = amounts.length - 1; index >= 0 && excess > 0; index -= 1) {
      const available = amounts[index] - (paidByNumber[index] ?? 0);
      const reduction = Math.min(available, excess);
      amounts[index] -= reduction;
      excess -= reduction;
    }
    if (excess > 0) throw new Error('O novo valor não cobre os pagamentos já feitos em cada parcela.');
  }

  const newPurchase = {
    ...purchase,
    description: input.description.trim(),
    totalCents: input.totalCents,
    cardId: card.id,
    categoryId: input.categoryId,
    expenseClass: input.expenseClass,
    purchaseDate: input.purchaseDate,
    firstDueMonth: input.firstDueMonth,
    installmentsCount: input.installmentsCount,
    notes: input.notes?.trim() || undefined,
    isFamilyDebt: purchase.isDebtorCredit
      ? sharedLinks.some((link) => normalizePerson(link.person).normalize('NFD').replace(/[\u0300-\u036f]/g, '') === 'familia')
      : purchase.isFamilyDebt,
  };
  const installmentRows = amounts.map((amountCents, index) => {
    const previous = currentInstallments[index];
    const dueMonth = monthOffset(input.firstDueMonth, index);
    const day = Math.min(card.dueDay, daysInMonth(dueMonth));
    return {
      id: previous?.id ?? makeId(),
      purchaseId: purchase.id,
      cardId: card.id,
      number: index + 1,
      count: input.installmentsCount,
      amountCents,
      paidCents: previous?.paidCents ?? 0,
      dueMonth,
      dueDate: dueMonth + '-' + String(day).padStart(2, '0'),
    };
  });
  const oldIds = new Set(currentInstallments.map((item) => item.id));
  const newIds = new Set(installmentRows.map((item) => item.id));
  const removedIds = [...oldIds].filter((id) => !newIds.has(id));

  const targetCardInstallments = await db.installments.where('cardId').equals(card.id).toArray();
  const otherCommitments = calculateUnpaidCardCommitmentCents(
    targetCardInstallments.filter((item) => item.purchaseId !== purchase.id),
  );
  const newCommitment = calculateUnpaidCardCommitmentCents(installmentRows);
  if (card.limitCents > 0 && otherCommitments + newCommitment > card.limitCents) {
    throw new Error('A alteração excede o limite cadastrado do cartão. Limite livre estimado: R$ ' + ((card.limitCents - otherCommitments) / 100).toFixed(2) + '.');
  }

  const now = new Date().toISOString();
  await db.transaction('rw', db.purchases, db.installments, db.months, db.debtors, db.debtorPayments, async () => {
    await db.purchases.put(newPurchase);
    if (removedIds.length) await db.installments.bulkDelete(removedIds);
    await db.installments.bulkPut(installmentRows);
    const months = [...new Set(installmentRows.map((item) => item.dueMonth))]
      .map((month) => ({ id: month, month, createdAt: now }));
    await db.months.bulkPut(months);
    if (debtorRows.length) await db.debtors.bulkPut(debtorRows);
    const removedDebtorIds = existingDebtors.filter((item) => !retainedDebtorIds.has(item.id)).map((item) => item.id);
    if (removedDebtorIds.length) {
      await db.debtors.bulkDelete(removedDebtorIds);
      await db.debtorPayments.where('debtorId').anyOf(removedDebtorIds).delete();
    }
  });

  return newPurchase;
}

export async function payInvoice(input: { cardId: string; accountId: string; month: string; amountCents: number; date: string }) {
  if (input.month < FINANCIAL_START_MONTH || input.date < `${FINANCIAL_START_MONTH}-01`) throw new Error('O controle de faturas começa em dezembro de 2026.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor de pagamento válido.');
  const card = await db.cards.get(input.cardId);
  const account = await db.accounts.get(input.accountId);
  if (!card || !account) throw new Error('Selecione um cartão e uma conta válidos.');
  const pending = (await db.installments.where('cardId').equals(input.cardId).toArray())
    .filter((item) => item.dueMonth >= FINANCIAL_START_MONTH && item.dueMonth <= input.month && item.paidCents < item.amountCents)
    .sort((a, b) => a.dueMonth.localeCompare(b.dueMonth) || a.number - b.number);
  const { allocations, remainingCents } = allocateInvoicePayment(pending, input.amountCents);
  if (remainingCents > 0) throw new Error('O pagamento é maior que as parcelas em aberto até o mês selecionado. Confira o valor e as faturas anteriores.');
  await db.transaction('rw', db.installments, db.invoicePayments, async () => {
    for (const allocation of allocations) {
      const installment = await db.installments.get(allocation.installmentId);
      if (installment) await db.installments.update(installment.id, { paidCents: installment.paidCents + allocation.amountCents });
    }
    await db.invoicePayments.add({ id: makeId(), ...input, allocations });
  });
}

export async function createTransfer(input: { fromAccountId: string; toAccountId: string; amountCents: number; date: string; description?: string }) {
  if (input.fromAccountId === input.toAccountId) throw new Error('Escolha contas diferentes.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Valor de transferência inválido.');
  const [from, to] = await Promise.all([db.accounts.get(input.fromAccountId), db.accounts.get(input.toAccountId)]);
  if (!from || !to) throw new Error('Conta de origem ou destino inválida.');
  await db.transfers.add({ id: makeId(), ...input });
}

export async function createDebtor(input: Omit<Debtor, 'id' | 'createdAt' | 'linkedTransactionId' | 'sharedPurchaseId'> & {
  paymentMode: Transaction['paymentMode'];
  cardId?: string;
  installmentsCount?: number;
  firstDueMonth?: string;
  reserveId?: string;
}) {
  const person = input.person.trim();
  const description = input.description.trim();
  if (!person || !description) throw new Error('Informe pessoa e descrição.');
  if (!Number.isSafeInteger(input.originalCents) || input.originalCents <= 0) throw new Error('Valor da dívida inválido.');

  const paymentMode = input.paymentMode;
  const paymentLabels: Record<Transaction['paymentMode'], string> = {
    pix: 'Pix', cash: 'Dinheiro', 'card-debit': 'Cartão de débito',
    'card-credit': 'Cartão de crédito', other: 'Outro', 'reserve-plans': 'Reserva de planos',
  };
  const usesAccount = ['pix', 'cash', 'card-debit'].includes(paymentMode);
  if (usesAccount && (!input.originAccountId || !(await db.accounts.get(input.originAccountId)))) {
    throw new Error('Selecione a conta utilizada.');
  }
  if (paymentMode === 'reserve-plans' && input.reserveId && !(await db.reserves.get(input.reserveId))) {
    throw new Error('Caixinha não encontrada.');
  }

  const isCredit = paymentMode === 'card-credit';
  const isFamily = person.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR') === 'familia';
  const id = makeId();
  const createdAt = new Date().toISOString();
  let linkedTransactionId: string | undefined;
  let sharedPurchaseId: string | undefined;
  let purchaseValue: import('../types').Purchase | undefined;
  let installmentRows: Array<{
    id: string; purchaseId: string; cardId: string; number: number; count: number; amountCents: number; paidCents: number; dueMonth: string; dueDate: string;
  }> = [];
  let plansReserve: Reserve | undefined;

  if (isCredit) {
    const card = input.cardId ? await db.cards.get(input.cardId) : undefined;
    if (!card) throw new Error('Selecione um cartão de crédito válido.');
    const count = input.installmentsCount ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 240) throw new Error('Quantidade de parcelas inválida (1 a 240).');
    const firstDueMonth = input.firstDueMonth ?? monthOffset(input.originDate.slice(0, 7), 1);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(firstDueMonth)) throw new Error('Informe o mês da primeira fatura.');
    const currentInstallments = await db.installments.where('cardId').equals(card.id).toArray();
    const currentCommitment = calculateUnpaidCardCommitmentCents(currentInstallments);
    if (card.limitCents > 0 && input.originalCents + currentCommitment > card.limitCents) {
      throw new Error('A compra excede o limite cadastrado do cartão. Limite livre estimado: R$ ' + ((card.limitCents - currentCommitment) / 100).toFixed(2) + '.');
    }
    sharedPurchaseId = makeId();
    purchaseValue = {
      id: sharedPurchaseId, description, totalCents: input.originalCents, cardId: card.id,
      categoryId: input.categoryId, purchaseDate: input.originDate, firstDueMonth, installmentsCount: count,
      createdAt, notes: input.notes, isDebtorCredit: true, isFamilyDebt: isFamily,
    };
    const amounts = splitInstallmentCents(input.originalCents, count);
    installmentRows = amounts.map((amountCents, index) => {
      const dueMonth = monthOffset(firstDueMonth, index);
      const day = Math.min(card.dueDay, daysInMonth(dueMonth));
      return {
        id: makeId(), purchaseId: sharedPurchaseId!, cardId: card.id, number: index + 1, count,
        amountCents, paidCents: 0, dueMonth, dueDate: dueMonth + '-' + String(day).padStart(2, '0'),
      };
    });
  } else {
    if (paymentMode === 'reserve-plans') {
      plansReserve = input.reserveId
        ? await db.reserves.get(input.reserveId)
        : await db.reserves.filter((item) => item.name.trim().toLocaleLowerCase('pt-BR') === 'planos' && !item.closed).first();
      if (!plansReserve || plansReserve.closed) throw new Error('Crie ou reabra a caixinha Planos antes de usar esta forma de pagamento.');
      const movements = await db.reserveMovements.where('reserveId').equals(plansReserve.id).toArray();
      const balance = movements.reduce((sum, item) => sum + (item.type === 'withdrawal' ? -item.amountCents : item.amountCents), 0);
      if (input.originalCents > balance) throw new Error('O saldo da caixinha Planos é insuficiente.');
    }
    linkedTransactionId = makeId();
  }

  const debtor: Debtor = {
    person, description, originalCents: input.originalCents, originDate: input.originDate, dueDate: input.dueDate,
    categoryId: input.categoryId, originalPayment: paymentLabels[paymentMode],
    originAccountId: usesAccount ? input.originAccountId : undefined,
    notes: input.notes, linkedTransactionId, sharedPurchaseId, id, createdAt,
  };
  const loanExpense: Transaction | undefined = linkedTransactionId ? {
    id: linkedTransactionId, type: 'expense',
    description: `Empréstimo para ${person}: ${description}`,
    amountCents: input.originalCents, date: input.originDate, month: input.originDate.slice(0, 7),
    categoryId: input.categoryId, expenseClass: 'Essencial', status: 'paid', paymentMode,
    accountId: usesAccount ? input.originAccountId : undefined, reserveId: plansReserve?.id,
    notes: input.notes, createdAt,
  } : undefined;

  await db.transaction(
    'rw',
    [db.debtors, db.transactions, db.months, db.purchases, db.installments, db.reserveMovements],
    async () => {
      await db.debtors.add(debtor);
      if (purchaseValue) {
        await db.purchases.add(purchaseValue);
        await db.installments.bulkAdd(installmentRows);
        await db.months.bulkPut([...new Set(installmentRows.map((item) => item.dueMonth))].map((month) => ({ id: month, month, createdAt })));
      }
      if (loanExpense) {
        await db.transactions.add(loanExpense);
        await db.months.put({ id: loanExpense.month, month: loanExpense.month, createdAt });
        if (plansReserve) await db.reserveMovements.add({
          id: makeId(), reserveId: plansReserve.id, type: 'withdrawal', amountCents: input.originalCents,
          date: input.originDate, notes: 'Empréstimo para ' + person + ': ' + description,
          linkedTransactionId: loanExpense.id, availableBalanceImpactCents: -input.originalCents,
        });
      }
    },
  );
}

export async function updateDebtor(input: {
  id: string; person: string; description: string; originalCents: number; originDate: string;
  dueDate?: string; categoryId?: string; notes?: string; originAccountId?: string;
}) {
  const debtor = await db.debtors.get(input.id);
  if (!debtor) throw new Error('Lançamento de dívida não encontrado.');
  const person = input.person.trim();
  const description = input.description.trim();
  if (!person || !description) throw new Error('Informe a pessoa e a descrição.');
  if (!Number.isSafeInteger(input.originalCents) || input.originalCents <= 0) throw new Error('Informe um valor válido.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.originDate)) throw new Error('Informe uma data válida.');
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new Error('Informe uma previsão de pagamento válida.');
  if (input.categoryId && !(await db.categories.get(input.categoryId))) throw new Error('Categoria não encontrada.');
  const payments = await db.debtorPayments.where('debtorId').equals(debtor.id).toArray();
  const receivedCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  if (input.originalCents < receivedCents) throw new Error('O valor original não pode ser menor que o que já foi recebido.');
  const purchase = debtor.sharedPurchaseId ? await db.purchases.get(debtor.sharedPurchaseId) : undefined;
  const isFamily = person.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR') === 'familia';
  const updatedAt = new Date().toISOString();

  if (purchase?.isDebtorCredit) {
    const [card, currentInstallments] = await Promise.all([
      db.cards.get(purchase.cardId),
      db.installments.where('purchaseId').equals(purchase.id).toArray(),
    ]);
    if (!card || !currentInstallments.length) throw new Error('Não foi possível localizar o cartão ou as parcelas desta dívida.');
    const sorted = currentInstallments.sort((a, b) => a.number - b.number);
    const otherCommitment = calculateUnpaidCardCommitmentCents(
      (await db.installments.where('cardId').equals(card.id).toArray())
        .filter((item) => item.purchaseId !== purchase.id),
    );
    const amounts = splitInstallmentCents(input.originalCents, sorted.length);
    for (let index = 0; index < amounts.length; index += 1) amounts[index] = Math.max(amounts[index], sorted[index].paidCents);
    let excess = amounts.reduce((sum, amount) => sum + amount, 0) - input.originalCents;
    for (let index = amounts.length - 1; index >= 0 && excess > 0; index -= 1) {
      const available = amounts[index] - sorted[index].paidCents;
      const reduction = Math.min(available, excess);
      amounts[index] -= reduction;
      excess -= reduction;
    }
    if (excess > 0) throw new Error('O novo valor não cobre as parcelas que já foram pagas.');
    const updatedCommitment = calculateUnpaidCardCommitmentCents(
      sorted.map((item, index) => ({ ...item, amountCents: amounts[index] })),
    );
    if (card.limitCents > 0 && updatedCommitment + otherCommitment > card.limitCents) {
      throw new Error('O novo valor excede o limite disponível do cartão.');
    }
    await db.transaction('rw', db.debtors, db.purchases, db.installments, db.months, async () => {
      await db.debtors.update(debtor.id, {
        person, description, originalCents: input.originalCents, originDate: input.originDate,
        dueDate: input.dueDate || undefined, categoryId: input.categoryId, notes: input.notes?.trim() || undefined,
      });
      await db.purchases.update(purchase.id, {
        description, totalCents: input.originalCents, purchaseDate: input.originDate,
        categoryId: input.categoryId, notes: input.notes?.trim() || undefined, isFamilyDebt: isFamily,
      });
      await db.installments.bulkPut(sorted.map((item, index) => ({ ...item, amountCents: amounts[index] })));
      await db.months.put({ id: input.originDate.slice(0, 7), month: input.originDate.slice(0, 7), createdAt: updatedAt });
    });
    return;
  }

  const transaction = debtor.linkedTransactionId ? await db.transactions.get(debtor.linkedTransactionId) : undefined;
  if (debtor.linkedTransactionId && !transaction) throw new Error('A movimentação financeira vinculada não foi encontrada.');
  if (transaction && ['pix', 'cash', 'card-debit'].includes(transaction.paymentMode)) {
    const accountId = input.originAccountId || debtor.originAccountId;
    if (!accountId || !(await db.accounts.get(accountId))) throw new Error('Selecione uma conta válida.');
  }
  const accountId = input.originAccountId || debtor.originAccountId;
  await db.transaction('rw', db.debtors, db.transactions, db.months, db.reserveMovements, async () => {
    await db.debtors.update(debtor.id, {
      person, description, originalCents: input.originalCents, originDate: input.originDate,
      dueDate: input.dueDate || undefined, categoryId: input.categoryId,
      originAccountId: accountId, notes: input.notes?.trim() || undefined,
    });
    if (transaction) {
      const nextTransaction = {
        ...transaction,
        description: `Empréstimo para ${person}: ${description}`,
        amountCents: input.originalCents,
        date: input.originDate,
        month: input.originDate.slice(0, 7),
        categoryId: input.categoryId,
        accountId: ['pix', 'cash', 'card-debit'].includes(transaction.paymentMode) ? accountId : transaction.accountId,
        notes: input.notes?.trim() || undefined,
      };
      await db.transactions.put(nextTransaction);
      await db.months.put({ id: nextTransaction.month, month: nextTransaction.month, createdAt: updatedAt });
      const linkedReserveMovement = await db.reserveMovements.filter((item) => item.linkedTransactionId === transaction.id).first();
      if (linkedReserveMovement) await db.reserveMovements.update(linkedReserveMovement.id, {
        amountCents: input.originalCents, date: input.originDate,
        notes: `Empréstimo para ${person}: ${description}`,
        availableBalanceImpactCents: -input.originalCents,
      });
    }
  });
}

export async function receiveDebtorPayment(input: { debtorId: string; accountId: string; amountCents: number; date: string; notes?: string }) {
  const debtor = await db.debtors.get(input.debtorId);
  const [payments, account] = await Promise.all([db.debtorPayments.where('debtorId').equals(input.debtorId).toArray(), db.accounts.get(input.accountId)]);
  if (!debtor || !account) throw new Error('Selecione uma dívida e uma conta válidas.');
  const received = payments.reduce((sum, item) => sum + item.amountCents, 0);
  const remaining = debtor.originalCents - received;
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > remaining) throw new Error('O recebimento deve ser maior que zero e não pode superar o saldo devido.');
  const linkedTransactionId = makeId();
  const paymentTransaction: Transaction = {
    id: linkedTransactionId,
    type: 'income',
    description: `Pagamento - ${debtor.person}`,
    amountCents: input.amountCents,
    date: input.date,
    month: input.date.slice(0, 7),
    categoryId: debtor.categoryId,
    status: 'received',
    paymentMode: 'pix',
    accountId: input.accountId,
    notes: input.notes,
    createdAt: new Date().toISOString(),
  };
  await db.transaction('rw', db.debtorPayments, db.transactions, db.months, async () => {
    await db.debtorPayments.add({ id: makeId(), ...input, linkedTransactionId });
    await db.transactions.add(paymentTransaction);
    await db.months.put({ id: paymentTransaction.month, month: paymentTransaction.month, createdAt: new Date().toISOString() });
  });
}

export async function saveReserve(input: Omit<Reserve, 'id' | 'createdAt'> & { id?: string }) {
  if (!input.name.trim() || !Number.isSafeInteger(input.targetCents) || input.targetCents < 0) throw new Error('Informe nome e uma meta válida.');
  const annualYieldPercent = input.annualYieldPercent ?? 0;
  if (!Number.isFinite(annualYieldPercent) || annualYieldPercent < 0 || annualYieldPercent > 100) throw new Error('Informe um rendimento anual entre 0% e 100%.');
  if (input.id) await processReserveYields();
  const existing = input.id ? await db.reserves.get(input.id) : undefined;
  if (input.id && !existing) throw new Error('Caixinha não encontrada.');
  const value: Reserve = {
    ...existing,
    ...input,
    id: input.id ?? makeId(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    annualYieldPercent,
    lastYieldDate: today(),
  };
  await db.reserves.put(value);
}

function reserveMovementDelta(type: 'deposit' | 'withdrawal' | 'yield' | 'adjustment', amountCents: number) {
  return type === 'withdrawal' ? -amountCents : amountCents;
}

export async function processReserveYields(referenceDate = today()) {
  const reserves = await db.reserves.toArray();
  let processed = 0;
  await db.transaction('rw', db.reserves, db.reserveMovements, async () => {
    for (const reserve of reserves) {
      const lastDate = reserve.lastYieldDate ?? reserve.createdAt.slice(0, 10);
      if (lastDate >= referenceDate) continue;
      const moves = await db.reserveMovements.where('reserveId').equals(reserve.id).toArray();
      let balance = moves
        .filter((move) => move.date <= lastDate)
        .reduce((sum, move) => sum + reserveMovementDelta(move.type, move.amountCents), 0);
      const annualRate = reserve.annualYieldPercent ?? 0;
      const dailyRate = annualRate > 0 ? calculateDailyReserveRate(annualRate) : 0;
      let remainderCents = reserve.yieldRemainderCents ?? 0;
      const cursor = new Date(`${lastDate}T00:00:00.000Z`);
      while (true) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        const date = cursor.toISOString().slice(0, 10);
        if (date > referenceDate) break;
        for (const move of moves) {
          if (move.date === date) balance += reserveMovementDelta(move.type, move.amountCents);
        }
        if (isBrazilBankBusinessDay(date) && dailyRate > 0 && balance > 0) {
          const exactYieldCents = (balance + remainderCents) * dailyRate;
          const amountCents = Math.floor(exactYieldCents);
          remainderCents = exactYieldCents - amountCents;
          if (amountCents > 0) {
            await db.reserveMovements.add({
              id: makeId(),
              reserveId: reserve.id,
              type: 'yield',
              amountCents,
              date,
              notes: 'Rendimento diário automático',
            });
            balance += amountCents;
            processed += 1;
          }
        }
      }
      await db.reserves.update(reserve.id, { lastYieldDate: referenceDate, yieldRemainderCents: remainderCents });
    }
  });
  return processed;
}

export async function saveReserveClosing(input: { reserveId: string; month: string; actualBalanceCents: number }): Promise<ReserveClosing> {
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new Error('Selecione um mês válido.');
  if (!Number.isSafeInteger(input.actualBalanceCents) || input.actualBalanceCents < 0) throw new Error('Informe um saldo real válido.');
  if (input.month >= today().slice(0, 7)) throw new Error('O fechamento só pode ser feito depois que o mês terminar.');

  await processReserveYields(today());
  const reserve = await db.reserves.get(input.reserveId);
  if (!reserve) throw new Error('Caixinha não encontrada.');

  const closingDate = `${input.month}-${String(daysInMonth(input.month)).padStart(2, '0')}`;
  const reserveClosings = await db.reserveClosings.where('reserveId').equals(input.reserveId).toArray();
  const latestClosing = reserveClosings.sort((a, b) => b.month.localeCompare(a.month))[0];
  if (latestClosing && input.month < latestClosing.month) {
    throw new Error('Feche os meses em ordem. Para corrigir, ajuste primeiro o fechamento mais recente.');
  }

  const existing = reserveClosings.find((item) => item.month === input.month);
  const movements = await db.reserveMovements.where('reserveId').equals(input.reserveId).toArray();
  const estimatedBalanceCents = existing?.estimatedBalanceCents ?? movements
    .filter((move) => move.date <= closingDate)
    .reduce((sum, move) => sum + reserveMovementDelta(move.type, move.amountCents), 0);
  const differenceCents = input.actualBalanceCents - estimatedBalanceCents;
  const closingId = existing?.id ?? makeId();
  const closing: ReserveClosing = {
    id: closingId,
    reserveId: input.reserveId,
    month: input.month,
    estimatedBalanceCents,
    actualBalanceCents: input.actualBalanceCents,
    differenceCents,
    closedAt: new Date().toISOString(),
  };

  await db.transaction('rw', db.reserves, db.reserveMovements, db.reserveClosings, async () => {
    if (existing) {
      await db.reserveMovements.filter((move) => move.linkedClosingId === existing.id).delete();
    }
    // Future auto-yield entries were calculated from the old estimate. Rebuild them
    // from the actual closing value, while preserving user deposits and withdrawals.
    await db.reserveMovements.where('reserveId').equals(input.reserveId)
      .filter((move) => move.type === 'yield' && move.date > closingDate)
      .delete();
    if (differenceCents !== 0) {
      await db.reserveMovements.add({
        id: makeId(),
        reserveId: input.reserveId,
        type: 'adjustment',
        amountCents: differenceCents,
        date: closingDate,
        notes: `Ajuste do fechamento de ${input.month}`,
        linkedClosingId: closingId,
      });
    }
    await db.reserveClosings.put(closing);
    await db.reserves.update(input.reserveId, { lastYieldDate: closingDate, yieldRemainderCents: 0 });
  });

  // Recalculate all days after the closing using the real balance as the base.
  await processReserveYields(today());
  return closing;
}

export async function moveReserve(input: { reserveId: string; type: 'deposit' | 'withdrawal'; amountCents: number; date: string; notes?: string }) {
  const reserve = await db.reserves.get(input.reserveId);
  if (!reserve) throw new Error('Caixinha não encontrada.');
  const moves = await db.reserveMovements.where('reserveId').equals(input.reserveId).toArray();
  const balance = moves.reduce((sum, item) => sum + reserveMovementDelta(item.type, item.amountCents), 0);
  const countedBalance = moves.reduce((sum, item) => sum + (item.availableBalanceImpactCents ?? 0), 0);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor válido.');
  if (input.type === 'withdrawal' && input.amountCents > balance) throw new Error('A retirada não pode superar o valor reservado.');
  const availableBalanceImpactCents = input.type === 'deposit'
    ? input.amountCents
    : calculateReserveWithdrawalImpactCents(input.amountCents, countedBalance);
  await db.reserveMovements.add({ id: makeId(), ...input, availableBalanceImpactCents });
}

export async function createInvestment(input: Omit<Investment, 'id' | 'balanceCents' | 'createdAt'>) {
  if (!input.name.trim() || input.initialCents < 0 || input.cdiPercent <= 0) throw new Error('Confira nome, valor inicial e percentual do CDI.');
  await db.investments.add({ ...input, id: makeId(), balanceCents: input.initialCents, createdAt: new Date().toISOString() });
  await processCdiAccruals();
}

export async function moveInvestment(input: { investmentId: string; accountId: string; type: 'contribution' | 'withdrawal'; amountCents: number; date: string; notes?: string }) {
  const [investment, account] = await Promise.all([db.investments.get(input.investmentId), db.accounts.get(input.accountId)]);
  if (!investment || !account || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Investimento, conta ou valor inválido.');
  if (input.date < investment.initialDate) throw new Error('A movimentação não pode ser anterior à data inicial da aplicação.');
  if (input.type === 'withdrawal' && input.amountCents > investment.balanceCents) throw new Error('A retirada supera o saldo da aplicação.');
  await db.transaction('rw', db.investments, db.investmentMovements, async () => {
    await db.investmentMovements.add({ id: makeId(), ...input });
    await db.investments.update(investment.id, { balanceCents: investment.balanceCents + (input.type === 'contribution' ? input.amountCents : -input.amountCents) });
  });
  await processCdiAccruals();
}

export async function importCdiRates(records: Array<{ date: string; annualRate: number }>, source = 'Importação manual') {
  const valid = records.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.annualRate) && row.annualRate >= 0 && row.annualRate <= 100);
  if (!valid.length) throw new Error('Nenhuma taxa válida encontrada. Use data no formato AAAA-MM-DD e CDI anual em percentual.');
  await db.cdiRates.bulkPut(valid.map((row): CdiRate => ({ id: row.date, date: row.date, annualRate: row.annualRate, source })));
  return valid.length;
}

export async function processCdiAccruals() {
  const [investments, rates, movements] = await Promise.all([
    db.investments.toArray(), db.cdiRates.orderBy('date').toArray(), db.investmentMovements.toArray(),
  ]);
  if (!rates.length || !investments.length) return 0;
  let processedCount = 0;
  await db.transaction('rw', db.investments, db.cdiAccruals, db.investmentMovements, async () => {
    for (const investment of investments) {
      let balance = investment.initialCents;
      let movementIndex = 0;
      const investmentMoves = movements.filter((move) => move.investmentId === investment.id).sort((a, b) => a.date.localeCompare(b.date));
      await db.cdiAccruals.where('investmentId').equals(investment.id).delete();
      for (const rate of rates) {
        if (rate.date < investment.initialDate) continue;
        while (movementIndex < investmentMoves.length && investmentMoves[movementIndex].date <= rate.date) {
          const move = investmentMoves[movementIndex];
          balance += move.type === 'contribution' ? move.amountCents : -move.amountCents;
          movementIndex += 1;
        }
        const dailyYield = calculateDailyCdiRate(rate.annualRate, investment.cdiPercent);
        const amountCents = Math.round(Math.max(0, balance) * dailyYield);
        balance += amountCents;
        await db.cdiAccruals.add({ id: makeId(), investmentId: investment.id, date: rate.date, rateDaily: dailyYield, amountCents, balanceAfterCents: balance });
        processedCount += 1;
      }
      while (movementIndex < investmentMoves.length) {
        const move = investmentMoves[movementIndex];
        balance += move.type === 'contribution' ? move.amountCents : -move.amountCents;
        movementIndex += 1;
      }
      await db.investments.update(investment.id, { balanceCents: Math.max(0, balance), lastAccrualDate: rates[rates.length - 1].date });
    }
  });
  return processedCount;
}

export function parseRateFile(text: string): Array<{ date: string; annualRate: number }> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(data) ? data : (data as { rates?: unknown[] }).rates ?? [];
    return rows.map((row) => {
      const value = row as Record<string, unknown>;
      return { date: String(value.date ?? value.data ?? ''), annualRate: Number(value.annualRate ?? value.taxa ?? value.cdi ?? NaN) };
    });
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const header = lines[0].toLowerCase().split(/[;,]/).map((item) => item.trim());
  const dateIndex = header.findIndex((item) => ['date', 'data'].includes(item));
  const rateIndex = header.findIndex((item) => ['annualrate', 'taxa', 'cdi', 'taxa anual', 'taxa_anual'].includes(item));
  if (dateIndex < 0 || rateIndex < 0) throw new Error('CSV esperado: date,annualRate (ou data,taxa).');
  return lines.slice(1).map((line) => {
    const columns = line.split(/[;,]/).map((item) => item.trim().replace(',', '.'));
    const rawDate = columns[dateIndex] ?? '';
    const date = /^\d{2}\/\d{2}\/\d{4}$/.test(rawDate) ? `${rawDate.slice(6)}-${rawDate.slice(3, 5)}-${rawDate.slice(0, 2)}` : rawDate;
    return { date, annualRate: Number(columns[rateIndex]) };
  });
}

export async function exportBackup() {
  const tables = [
    'categories', 'accounts', 'cards', 'transactions', 'purchases', 'installments', 'invoicePayments', 'transfers',
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'reserveClosings', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases', 'recurringTransactions', 'transactionTemplates',
  ] as const;
  const payload: Record<string, unknown> = { app: 'Nexo', schemaVersion: 4, exportedAt: new Date().toISOString() };
  for (const table of tables) payload[table] = await db.table(table).toArray();
  return payload;
}

export async function restoreBackup(payload: unknown, replace = false) {
  if (!payload || typeof payload !== 'object' || (payload as { app?: string }).app !== 'Nexo') {
    throw new Error('Arquivo de backup inválido ou versão não suportada.');
  }
  const schemaVersion = (payload as { schemaVersion?: number }).schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4) throw new Error('Arquivo de backup inválido ou versão não suportada.');
  const tables = [
    'categories', 'accounts', 'cards', 'transactions', 'purchases', 'installments', 'invoicePayments', 'transfers',
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'reserveClosings', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases', 'recurringTransactions', 'transactionTemplates',
  ] as const;
  const data = payload as Record<string, unknown>;
  for (const table of tables) {
    if (table === 'wishlistPurchases' && data[table] === undefined && schemaVersion === 1) data[table] = [];
    if (table === 'reserveClosings' && data[table] === undefined && schemaVersion < 3) data[table] = [];
    if ((table === 'recurringTransactions' || table === 'transactionTemplates') && data[table] === undefined && schemaVersion < 4) data[table] = [];
    if (!Array.isArray(data[table])) throw new Error(`Backup sem a coleção ${table}.`);
  }
  await db.transaction('rw', tables.map((table) => db.table(table)), async () => {
    if (replace) for (const table of tables) await db.table(table).clear();
    for (const table of tables) {
      const rows = data[table] as Record<string, unknown>[];
      if (replace) await db.table(table).bulkPut(rows);
      else {
        const key = db.table(table).schema.primKey.keyPath as string;
        const existing = await db.table(table).toArray() as Record<string, unknown>[];
        const merged = mergeBackupRecords(existing, rows, key);
        if (merged.length) await db.table(table).bulkPut(merged);
      }
    }
  });
}

export async function encryptBackup(payload: unknown, password: string) {
  if (password.length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return { format: 'NEXO-AES-GCM-1', salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptBackup(envelope: { format?: string; salt: string; iv: string; data: string }, password: string) {
  if (envelope.format !== 'NEXO-AES-GCM-1') throw new Error('Formato criptografado não reconhecido.');
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromBase64(envelope.salt), iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.data));
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}
function toBase64(data: Uint8Array) { return btoa(String.fromCharCode(...data)); }
function fromBase64(data: string) { return Uint8Array.from(atob(data), (char) => char.charCodeAt(0)); }


// Exclusions keep related records consistent and remove dependent records only.
export async function deleteDebtor(debtorId: string, removeLinkedPurchase = true) {
  const debtor = await db.debtors.get(debtorId);
  if (!debtor) return;
  const payments = await db.debtorPayments.where('debtorId').equals(debtorId).toArray();
  const linkedPurchase = debtor.sharedPurchaseId ? await db.purchases.get(debtor.sharedPurchaseId) : undefined;
  await db.transaction('rw', db.debtors, db.debtorPayments, db.transactions, async () => {
    await db.transactions.bulkDelete([debtor.linkedTransactionId, ...payments.map((item) => item.linkedTransactionId)].filter((id): id is string => Boolean(id)));
    await db.debtorPayments.where('debtorId').equals(debtorId).delete();
    await db.debtors.delete(debtorId);
  });
  if (removeLinkedPurchase && linkedPurchase?.isDebtorCredit) await deletePurchase(linkedPurchase.id, false);
}

export async function deleteDebtorPayment(paymentId: string) {
  const payment = await db.debtorPayments.get(paymentId);
  if (!payment) return;
  await db.transaction('rw', db.debtorPayments, db.transactions, async () => {
    await db.debtorPayments.delete(paymentId);
    if (payment.linkedTransactionId) await db.transactions.delete(payment.linkedTransactionId);
  });
}



export async function deletePurchase(purchaseId: string, removeLinkedDebtors = true) {
  const linkedDebtors = await db.debtors.where('sharedPurchaseId').equals(purchaseId).toArray();
  if (removeLinkedDebtors) {
    for (const debtor of linkedDebtors) await deleteDebtor(debtor.id, false);
  }
  const installments = await db.installments.where('purchaseId').equals(purchaseId).toArray();
  const installmentIds = new Set(installments.map((item) => item.id));
  const payments = await db.invoicePayments.toArray();
  await db.transaction('rw', db.purchases, db.installments, db.invoicePayments, async () => {
    for (const payment of payments) {
      const removed = payment.allocations.filter((allocation) => installmentIds.has(allocation.installmentId));
      if (!removed.length) continue;
      const refundedAllocationCents = removed.reduce((sum, allocation) => sum + allocation.amountCents, 0);
      const allocations = payment.allocations.filter((allocation) => !installmentIds.has(allocation.installmentId));
      const amountCents = Math.max(0, payment.amountCents - refundedAllocationCents);
      if (amountCents === 0 || allocations.length === 0) await db.invoicePayments.delete(payment.id);
      else await db.invoicePayments.update(payment.id, { amountCents, allocations });
    }
    await db.installments.bulkDelete([...installmentIds]);
    await db.purchases.delete(purchaseId);
  });
}

export async function deleteCard(cardId: string) {
  const purchases = await db.purchases.where('cardId').equals(cardId).toArray();
  for (const purchase of purchases) await deletePurchase(purchase.id);
  await db.transaction('rw', db.cards, db.invoicePayments, async () => {
    await db.invoicePayments.where('cardId').equals(cardId).delete();
    await db.cards.delete(cardId);
  });
}

export async function deleteInvoicePayment(paymentId: string) {
  const payment = await db.invoicePayments.get(paymentId);
  if (!payment) return;
  await db.transaction('rw', db.invoicePayments, db.installments, async () => {
    for (const allocation of payment.allocations) {
      const installment = await db.installments.get(allocation.installmentId);
      if (installment) await db.installments.update(installment.id, { paidCents: Math.max(0, installment.paidCents - allocation.amountCents) });
    }
    await db.invoicePayments.delete(paymentId);
  });
}

export async function deleteTransfer(transferId: string) {
  await db.transfers.delete(transferId);
}

export async function deleteCategory(categoryId: string) {
  const [transactions, purchases, debtors, budgets] = await Promise.all([
    db.transactions.where('categoryId').equals(categoryId).toArray(),
    db.purchases.where('categoryId').equals(categoryId).toArray(),
    db.debtors.where('categoryId').equals(categoryId).toArray(),
    db.monthlyBudgets.where('categoryId').equals(categoryId).toArray(),
  ]);
  await db.transaction('rw', db.categories, db.transactions, db.purchases, db.debtors, db.monthlyBudgets, async () => {
    for (const item of transactions) await db.transactions.update(item.id, { categoryId: undefined });
    for (const item of purchases) await db.purchases.update(item.id, { categoryId: undefined });
    for (const item of debtors) await db.debtors.update(item.id, { categoryId: undefined });
    await db.monthlyBudgets.bulkDelete(budgets.map((item) => item.id));
    await db.categories.delete(categoryId);
  });
}

export async function deleteReserve(reserveId: string) {
  await db.transaction('rw', db.reserves, db.reserveMovements, db.reserveClosings, async () => {
    await db.reserveMovements.where('reserveId').equals(reserveId).delete();
    await db.reserveClosings.where('reserveId').equals(reserveId).delete();
    await db.reserves.delete(reserveId);
  });
}

export async function deleteReserveMovement(movementId: string) {
  const movement = await db.reserveMovements.get(movementId);
  if (movement?.type === 'adjustment') {
    throw new Error('Esse ajuste está vinculado ao fechamento mensal. Corrija o valor pelo fechamento da caixinha.');
  }
  await db.reserveMovements.delete(movementId);
}

export async function deleteAccount(accountId: string) {
  // Delete all account-linked records in one Dexie transaction. Calling the
  // individual delete helpers here opened nested transactions and could leave
  // the account undeleted when a related record was present.
  await db.transaction(
    'rw',
    [db.accounts, db.transactions, db.transfers, db.invoicePayments, db.installments,
      db.debtors, db.debtorPayments, db.investmentMovements, db.investments],
    async () => {
      const account = await db.accounts.get(accountId);
      if (!account) return;

      const [accountTransactions, transfers, invoicePayments, debtors, investmentMovements] = await Promise.all([
        db.transactions.where('accountId').equals(accountId).toArray(),
        db.transfers.toArray().then((items) => items.filter((item) => item.fromAccountId === accountId || item.toAccountId === accountId)),
        db.invoicePayments.where('accountId').equals(accountId).toArray(),
        db.debtors.where('originAccountId').equals(accountId).toArray(),
        db.investmentMovements.where('accountId').equals(accountId).toArray(),
      ]);

      const debtorIds = new Set(debtors.map((item) => item.id));
      const relatedDebtorPayments = await db.debtorPayments.toArray().then((items) =>
        items.filter((item) => debtorIds.has(item.debtorId) || item.accountId === accountId)
      );
      const linkedTransactionIds = [
        ...debtors.map((item) => item.linkedTransactionId),
        ...relatedDebtorPayments.map((item) => item.linkedTransactionId),
      ].filter((id): id is string => Boolean(id));
      const transactionIds = new Set([...accountTransactions.map((item) => item.id), ...linkedTransactionIds]);

      for (const payment of invoicePayments) {
        for (const allocation of payment.allocations ?? []) {
          const installment = await db.installments.get(allocation.installmentId);
          if (installment) {
            await db.installments.update(installment.id, {
              paidCents: Math.max(0, installment.paidCents - allocation.amountCents),
            });
          }
        }
      }

      await db.transactions.bulkDelete([...transactionIds]);
      await db.transfers.bulkDelete(transfers.map((item) => item.id));
      await db.invoicePayments.bulkDelete(invoicePayments.map((item) => item.id));
      await db.debtorPayments.bulkDelete(relatedDebtorPayments.map((item) => item.id));
      await db.debtors.bulkDelete([...debtorIds]);
      await db.investmentMovements.bulkDelete(investmentMovements.map((item) => item.id));

      const affectedInvestmentIds = new Set(investmentMovements.map((item) => item.investmentId));
      for (const investmentId of affectedInvestmentIds) {
        const investment = await db.investments.get(investmentId);
        if (!investment) continue;
        const remaining = await db.investmentMovements.where('investmentId').equals(investmentId).toArray();
        const balanceCents = remaining.reduce(
          (sum, move) => sum + (move.type === 'contribution' ? move.amountCents : -move.amountCents),
          investment.initialCents,
        );
        await db.investments.update(investmentId, { balanceCents: Math.max(0, balanceCents) });
      }

      await db.accounts.delete(accountId);
    },
  );
}


const WISHLIST_INITIAL_KEY = 'wishlistInitialCents';

export async function saveWishlistInitialBalance(initialCents: number) {
  if (!Number.isSafeInteger(initialCents) || initialCents < 0) throw new Error('Informe um valor inicial válido.');
  await db.settings.put({ key: WISHLIST_INITIAL_KEY, value: initialCents });
}

export async function createWishlistPurchase(input: { description: string; amountCents: number; date: string; notes?: string }) {
  if (!input.description.trim()) throw new Error('Informe o nome da compra desejada.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor de compra válido.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Informe uma data válida.');
  await db.wishlistPurchases.add({ id: makeId(), ...input, description: input.description.trim(), createdAt: new Date().toISOString() });
}

export async function deleteWishlistPurchase(purchaseId: string) {
  await db.wishlistPurchases.delete(purchaseId);
}

export async function clearTestData() {
  const tables = [
    'categories', 'accounts', 'cards', 'transactions', 'purchases', 'installments', 'invoicePayments', 'transfers',
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'reserveClosings', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases', 'recurringTransactions', 'transactionTemplates',
  ] as const;
  await db.transaction('rw', tables.map((name) => db.table(name)), async () => {
    for (const name of tables) await db.table(name).clear();
  });
  await initializeDatabase();
}
