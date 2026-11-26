import { db, initializeDatabase } from './db';
import { daysInMonth, makeId, monthOffset, today } from './format';
import { allocateInvoicePayment, calculateDailyCdiRate, calculateReserveWithdrawalImpactCents, splitInstallmentCents } from './calculations';
import type { Account, Card, CdiRate, Debtor, Investment, Reserve, Transaction } from '../types';

export async function saveTransaction(input: Omit<Transaction, 'id' | 'createdAt' | 'month'> & {
  id?: string;
  sharedWith?: { person: string; amountCents: number };
}) {
  const { sharedWith, ...transactionInput } = input;
  if (!transactionInput.description.trim()) throw new Error('Informe uma descrição.');
  if (!Number.isSafeInteger(transactionInput.amountCents) || transactionInput.amountCents <= 0) throw new Error('Informe um valor válido maior que zero.');
  if (transactionInput.status !== 'cancelled' && transactionInput.paymentMode !== 'other' && !transactionInput.accountId) throw new Error('Selecione a conta utilizada.');
  if (sharedWith && transactionInput.type !== 'expense') throw new Error('Somente despesas podem ser divididas.');
  if (sharedWith && transactionInput.paymentMode === 'card-credit') throw new Error('A divisão está disponível para despesas fora do cartão de crédito.');
  if (sharedWith && (!Number.isSafeInteger(sharedWith.amountCents) || sharedWith.amountCents <= 0 || sharedWith.amountCents >= transactionInput.amountCents)) {
    throw new Error('A parte da outra pessoa precisa ser maior que zero e menor que o total da despesa.');
  }

  const normalizePerson = (value: string) => value.trim().toLocaleLowerCase('pt-BR');
  const people = sharedWith ? await db.debtors.toArray() : [];
  const personRecord = sharedWith
    ? people.find((item) => normalizePerson(item.person) === normalizePerson(sharedWith.person))
    : undefined;
  if (sharedWith && !personRecord) throw new Error('Selecione uma pessoa já cadastrada em Devedores.');

  const value: Transaction = {
    ...transactionInput,
    id: transactionInput.id ?? makeId(),
    month: transactionInput.date.slice(0, 7),
    createdAt: new Date().toISOString(),
  };
  const existingShared = transactionInput.id
    ? await db.debtors.filter((item) => item.sharedExpenseId === transactionInput.id).first()
    : undefined;
  const existingPayments = existingShared
    ? await db.debtorPayments.where('debtorId').equals(existingShared.id).toArray()
    : [];
  const alreadyReceivedCents = existingPayments.reduce((sum, payment) => sum + payment.amountCents, 0);

  if (existingShared && sharedWith && normalizePerson(existingShared.person) !== normalizePerson(personRecord!.person) && alreadyReceivedCents > 0) {
    throw new Error('Esta divisão já tem pagamentos. Não é possível trocar a pessoa depois de receber parte do valor.');
  }
  if (existingShared && sharedWith && alreadyReceivedCents > sharedWith.amountCents) {
    throw new Error('A parte da pessoa não pode ser menor que o valor que ela já pagou.');
  }
  if (existingShared && !sharedWith && alreadyReceivedCents > 0) {
    throw new Error('Esta divisão já tem pagamentos. Remova ou ajuste os recebimentos antes de desfazer a divisão.');
  }

  await db.transaction('rw', db.transactions, db.months, db.debtors, db.debtorPayments, async () => {
    await db.transactions.put(value);
    await db.months.put({ id: value.month, month: value.month, createdAt: new Date().toISOString() });

    if (sharedWith && personRecord) {
      const sharedDebtor: Debtor = {
        id: existingShared?.id ?? makeId(),
        person: personRecord.person.trim(),
        description: `Divisão da conta: ${value.description.trim()}`,
        originalCents: sharedWith.amountCents,
        originDate: value.date,
        categoryId: value.categoryId,
        originalPayment: 'Conta dividida',
        originAccountId: value.accountId,
        notes: value.notes,
        sharedExpenseId: value.id,
        createdAt: existingShared?.createdAt ?? new Date().toISOString(),
      };
      await db.debtors.put(sharedDebtor);
    } else if (existingShared) {
      await db.debtors.delete(existingShared.id);
      await db.debtorPayments.where('debtorId').equals(existingShared.id).delete();
    }
  });

  return value;
}

export async function deleteTransaction(id: string) {
  const debtor = await db.debtors.filter((item) => item.linkedTransactionId === id || item.sharedExpenseId === id).first();
  if (debtor) {
    const isSharedExpense = debtor.sharedExpenseId === id;
    await deleteDebtor(debtor.id);
    if (isSharedExpense) await db.transactions.delete(id);
    return;
  }
  const payment = await db.debtorPayments.filter((item) => item.linkedTransactionId === id).first();
  if (payment) return deleteDebtorPayment(payment.id);
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
  sharedWith?: { person: string; amountCents: number };
}) {
  if (!input.description.trim()) throw new Error('Informe a descrição da compra.');
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents <= 0) throw new Error('Valor da compra inválido.');
  if (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1 || input.installmentsCount > 240) throw new Error('Quantidade de parcelas inválida (1 a 240).');
  if (input.sharedWith && (!Number.isSafeInteger(input.sharedWith.amountCents) || input.sharedWith.amountCents <= 0 || input.sharedWith.amountCents >= input.totalCents)) {
    throw new Error('A parte da outra pessoa precisa ser maior que zero e menor que o total da compra.');
  }
  const card = await db.cards.get(input.cardId);
  if (!card) throw new Error('Cartão não encontrado.');
  const committed = await db.installments.where('cardId').equals(card.id).toArray();
  const currentCommitment = committed.reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
  if (card.limitCents > 0 && input.totalCents + currentCommitment > card.limitCents) {
    throw new Error(`A compra excede o limite cadastrado do cartão. Limite livre estimado: R$ ${((card.limitCents - currentCommitment) / 100).toFixed(2)}.`);
  }
  const normalizePerson = (value: string) => value.trim().toLocaleLowerCase('pt-BR');
  const people = input.sharedWith ? await db.debtors.toArray() : [];
  const personRecord = input.sharedWith
    ? people.find((item) => normalizePerson(item.person) === normalizePerson(input.sharedWith!.person))
    : undefined;
  if (input.sharedWith && !personRecord) throw new Error('Selecione uma pessoa já cadastrada em Devedores.');

  const purchaseId = makeId();
  const purchase = {
    id: purchaseId, description: input.description.trim(), totalCents: input.totalCents, cardId: input.cardId,
    categoryId: input.categoryId, expenseClass: input.expenseClass, purchaseDate: input.purchaseDate, firstDueMonth: input.firstDueMonth,
    installmentsCount: input.installmentsCount, createdAt: new Date().toISOString(), notes: input.notes,
  };
  const installmentAmounts = splitInstallmentCents(input.totalCents, input.installmentsCount);
  const installments = Array.from({ length: input.installmentsCount }, (_, index) => {
    const dueMonth = monthOffset(input.firstDueMonth, index);
    const day = Math.min(card.dueDay, daysInMonth(dueMonth));
    return {
      id: makeId(), purchaseId, cardId: input.cardId, number: index + 1, count: input.installmentsCount,
      amountCents: installmentAmounts[index], paidCents: 0, dueMonth,
      dueDate: `${dueMonth}-${String(day).padStart(2, '0')}`,
    };
  });
  await db.transaction('rw', db.purchases, db.installments, db.months, db.debtors, async () => {
    await db.purchases.add(purchase);
    await db.installments.bulkAdd(installments);
    await db.months.bulkPut([...new Set(installments.map((item) => item.dueMonth))].map((month) => ({ id: month, month, createdAt: new Date().toISOString() })));
    if (input.sharedWith && personRecord) {
      const sharedDebtor: Debtor = {
        id: makeId(),
        person: personRecord.person.trim(),
        description: `Divisão da conta: ${purchase.description}`,
        originalCents: input.sharedWith.amountCents,
        originDate: input.purchaseDate,
        categoryId: input.categoryId,
        originalPayment: 'Cartão de crédito',
        notes: input.notes,
        sharedPurchaseId: purchaseId,
        createdAt: new Date().toISOString(),
      };
      await db.debtors.add(sharedDebtor);
    }
  });
}

export async function payInvoice(input: { cardId: string; accountId: string; month: string; amountCents: number; date: string }) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor de pagamento válido.');
  const card = await db.cards.get(input.cardId);
  const account = await db.accounts.get(input.accountId);
  if (!card || !account) throw new Error('Selecione um cartão e uma conta válidos.');
  const pending = (await db.installments.where('cardId').equals(input.cardId).toArray())
    .filter((item) => item.dueMonth <= input.month && item.paidCents < item.amountCents)
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

export async function createDebtor(input: Omit<Debtor, 'id' | 'createdAt' | 'linkedTransactionId'>) {
  if (!input.person.trim() || !input.description.trim()) throw new Error('Informe pessoa e descrição.');
  if (!input.originAccountId || !(await db.accounts.get(input.originAccountId))) throw new Error('Selecione a conta de onde o dinheiro saiu.');
  if (!Number.isSafeInteger(input.originalCents) || input.originalCents <= 0) throw new Error('Valor da dívida inválido.');
  const id = makeId();
  const linkedTransactionId = makeId();
  const loanExpense: Transaction = {
    id: linkedTransactionId,
    type: 'expense',
    description: `Empréstimo para ${input.person.trim()}: ${input.description.trim()}`,
    amountCents: input.originalCents,
    date: input.originDate,
    month: input.originDate.slice(0, 7),
    categoryId: input.categoryId,
    expenseClass: 'Essencial',
    status: 'paid',
    paymentMode: 'pix',
    accountId: input.originAccountId,
    notes: input.notes,
    createdAt: new Date().toISOString(),
  };
  const debtor: Debtor = { ...input, id, linkedTransactionId, createdAt: new Date().toISOString() };
  await db.transaction('rw', db.debtors, db.transactions, db.months, async () => {
    await db.debtors.add(debtor);
    await db.transactions.add(loanExpense);
    await db.months.put({ id: loanExpense.month, month: loanExpense.month, createdAt: new Date().toISOString() });
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
    description: `Pagamento ${debtor.person}`,
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

function reserveMovementDelta(type: 'deposit' | 'withdrawal' | 'yield', amountCents: number) {
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
      const dailyRate = annualRate > 0 ? Math.pow(1 + annualRate / 100, 1 / 365) - 1 : 0;
      let remainderCents = reserve.yieldRemainderCents ?? 0;
      const cursor = new Date(`${lastDate}T00:00:00.000Z`);
      while (true) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        const date = cursor.toISOString().slice(0, 10);
        if (date > referenceDate) break;
        for (const move of moves) {
          if (move.date === date) balance += reserveMovementDelta(move.type, move.amountCents);
        }
        if (dailyRate > 0 && balance > 0) {
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
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases',
  ] as const;
  const payload: Record<string, unknown> = { app: 'Nexo', schemaVersion: 2, exportedAt: new Date().toISOString() };
  for (const table of tables) payload[table] = await db.table(table).toArray();
  return payload;
}

export async function restoreBackup(payload: unknown, replace = false) {
  if (!payload || typeof payload !== 'object' || (payload as { app?: string }).app !== 'Nexo') {
    throw new Error('Arquivo de backup inválido ou versão não suportada.');
  }
  const schemaVersion = (payload as { schemaVersion?: number }).schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error('Arquivo de backup inválido ou versão não suportada.');
  const tables = [
    'categories', 'accounts', 'cards', 'transactions', 'purchases', 'installments', 'invoicePayments', 'transfers',
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases',
  ] as const;
  const data = payload as Record<string, unknown>;
  for (const table of tables) {
    if (table === 'wishlistPurchases' && data[table] === undefined && schemaVersion === 1) data[table] = [];
    if (!Array.isArray(data[table])) throw new Error(`Backup sem a coleção ${table}.`);
  }
  await db.transaction('rw', tables.map((table) => db.table(table)), async () => {
    if (replace) for (const table of tables) await db.table(table).clear();
    for (const table of tables) {
      const rows = data[table] as Record<string, unknown>[];
      if (replace) await db.table(table).bulkPut(rows);
      else {
        const key = db.table(table).schema.primKey.keyPath as string;
        const existing = new Set(await db.table(table).toCollection().primaryKeys());
        const fresh = rows.filter((row) => !existing.has(row[key] as never));
        if (fresh.length) await db.table(table).bulkAdd(fresh);
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
export async function deleteDebtor(debtorId: string) {
  const debtor = await db.debtors.get(debtorId);
  if (!debtor) return;
  const payments = await db.debtorPayments.where('debtorId').equals(debtorId).toArray();
  await db.transaction('rw', db.debtors, db.debtorPayments, db.transactions, async () => {
    await db.transactions.bulkDelete([debtor.linkedTransactionId, ...payments.map((item) => item.linkedTransactionId)].filter((id): id is string => Boolean(id)));
    await db.debtorPayments.where('debtorId').equals(debtorId).delete();
    await db.debtors.delete(debtorId);
  });
}

export async function deleteDebtorPayment(paymentId: string) {
  const payment = await db.debtorPayments.get(paymentId);
  if (!payment) return;
  await db.transaction('rw', db.debtorPayments, db.transactions, async () => {
    await db.debtorPayments.delete(paymentId);
    if (payment.linkedTransactionId) await db.transactions.delete(payment.linkedTransactionId);
  });
}



export async function deletePurchase(purchaseId: string) {
  const sharedDebtor = await db.debtors.filter((item) => item.sharedPurchaseId === purchaseId).first();
  if (sharedDebtor) await deleteDebtor(sharedDebtor.id);
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
  await db.transaction('rw', db.reserves, db.reserveMovements, async () => {
    await db.reserveMovements.where('reserveId').equals(reserveId).delete();
    await db.reserves.delete(reserveId);
  });
}

export async function deleteReserveMovement(movementId: string) {
  await db.reserveMovements.delete(movementId);
}

export async function deleteAccount(accountId: string) {
  const debtors = await db.debtors.where('originAccountId').equals(accountId).toArray();
  for (const debtor of debtors) await deleteDebtor(debtor.id);
  const [transactions, transfers, payments, debtorPayments, movements] = await Promise.all([
    db.transactions.where('accountId').equals(accountId).toArray(),
    db.transfers.toArray().then((items) => items.filter((item) => item.fromAccountId === accountId || item.toAccountId === accountId)),
    db.invoicePayments.where('accountId').equals(accountId).toArray(),
    db.debtorPayments.where('accountId').equals(accountId).toArray(),
    db.investmentMovements.where('accountId').equals(accountId).toArray(),
  ]);
  for (const payment of payments) await deleteInvoicePayment(payment.id);
  for (const payment of debtorPayments) await deleteDebtorPayment(payment.id);
  const investmentIds = new Set(movements.map((item) => item.investmentId));
  await db.transaction('rw', db.accounts, db.transactions, db.transfers, db.investmentMovements, db.investments, async () => {
    await db.transactions.bulkDelete(transactions.map((item) => item.id));
    await db.transfers.bulkDelete(transfers.map((item) => item.id));
    await db.investmentMovements.bulkDelete(movements.map((item) => item.id));
    for (const investmentId of investmentIds) {
      const investment = await db.investments.get(investmentId);
      if (!investment) continue;
      const remaining = await db.investmentMovements.where('investmentId').equals(investmentId).toArray();
      const balanceCents = remaining.reduce((sum, move) => sum + (move.type === 'contribution' ? move.amountCents : -move.amountCents), investment.initialCents);
      await db.investments.update(investmentId, { balanceCents: Math.max(0, balanceCents) });
    }
    await db.accounts.delete(accountId);
  });
}


const WISHLIST_INITIAL_KEY = 'wishlistInitialCents';

export async function saveWishlistInitialBalance(initialCents: number) {
  if (!Number.isSafeInteger(initialCents) || initialCents < 0) throw new Error('Informe um valor inicial válido.');
  await db.settings.put({ key: WISHLIST_INITIAL_KEY, value: initialCents });
}

export async function createWishlistPurchase(input: { description: string; amountCents: number; date: string; notes?: string }) {
  if (!input.description.trim()) throw new Error('Informe o nome da compra desejada.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Informe um valor de compra válido.');
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(input.date)) throw new Error('Informe uma data válida.');
  await db.wishlistPurchases.add({ id: makeId(), ...input, description: input.description.trim(), createdAt: new Date().toISOString() });
}

export async function deleteWishlistPurchase(purchaseId: string) {
  await db.wishlistPurchases.delete(purchaseId);
}

export async function clearTestData() {
  const tables = [
    'categories', 'accounts', 'cards', 'transactions', 'purchases', 'installments', 'invoicePayments', 'transfers',
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases',
  ] as const;
  await db.transaction('rw', tables.map((name) => db.table(name)), async () => {
    for (const name of tables) await db.table(name).clear();
  });
  await initializeDatabase();
}
