import { db, initializeDatabase } from './db';
import { daysInMonth, makeId, monthOffset, today } from './format';
import { allocateInvoicePayment, calculateDailyCdiRate, calculateDailyReserveRate, calculateReserveWithdrawalImpactCents, isBrazilBankBusinessDay, splitInstallmentCents, FINANCIAL_START_MONTH } from './calculations';
import type { Account, Card, CdiRate, Debtor, Investment, Reserve, ReserveClosing, Transaction } from '../types';

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

export async function deleteTransaction(id: string) {
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
  const currentCommitment = committed.reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
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

export async function importCardPurchasesFromJson(payload: unknown): Promise<{
  importedCount: number; totalCents: number; cardName: string; firstDueMonth: string; debtorCount: number;
}> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('O JSON precisa ser um objeto com cartão e uma lista de compras.');
  }
  const data = payload as Record<string, unknown>;
  const cardValue = typeof data.card === 'string' ? data.card.trim()
    : typeof data.cardId === 'string' ? data.cardId.trim() : '';
  if (!cardValue) throw new Error('Informe o cartão no campo "card".');

  const normalize = (value: string) => value.trim().toLocaleLowerCase('pt-BR');
  const cards = await db.cards.toArray();
  const card = cards.find((item) => item.id === cardValue || normalize(item.name) === normalize(cardValue));
  if (!card) throw new Error('Cartão "' + cardValue + '" não está cadastrado neste NEXO.');

  const validMonth = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const validDate = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!validMonth(data.firstDueMonth)) throw new Error('Informe "firstDueMonth" no formato AAAA-MM.');
  const rootMonth = data.firstDueMonth;
  const rootCount = data.installmentsCount === undefined ? 1 : Number(data.installmentsCount);
  if (!Number.isInteger(rootCount) || rootCount < 1 || rootCount > 240) {
    throw new Error('"installmentsCount" precisa ser um número inteiro entre 1 e 240.');
  }
  if (!Array.isArray(data.purchases) || data.purchases.length === 0 || data.purchases.length > 500) {
    throw new Error('O campo "purchases" precisa conter de 1 a 500 compras.');
  }

  const categories = await db.categories.toArray();
  const existingDebtors = await db.debtors.toArray();
  const personRecords = new Map<string, string>();
  for (const debtor of existingDebtors) {
    const key = normalize(debtor.person);
    if (key && !personRecords.has(key)) personRecords.set(key, debtor.person.trim());
  }

  const entries = (data.purchases as unknown[]).map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Compra ' + (index + 1) + ': item inválido.');
    }
    const row = raw as Record<string, unknown>;
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    if (!description) throw new Error('Compra ' + (index + 1) + ': informe a descrição.');
    const totalCents = Number(row.totalCents);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw new Error('Compra ' + (index + 1) + ' (' + description + '): "totalCents" precisa ser um inteiro positivo em centavos.');
    }
    if (!validDate(row.purchaseDate)) {
      throw new Error('Compra ' + (index + 1) + ' (' + description + '): data inválida; use AAAA-MM-DD.');
    }
    const firstDueMonth = row.firstDueMonth === undefined ? rootMonth : row.firstDueMonth;
    if (!validMonth(firstDueMonth)) {
      throw new Error('Compra ' + (index + 1) + ' (' + description + '): primeira fatura inválida; use AAAA-MM.');
    }
    const installmentsCount = row.installmentsCount === undefined ? rootCount : Number(row.installmentsCount);
    if (!Number.isInteger(installmentsCount) || installmentsCount < 1 || installmentsCount > 240) {
      throw new Error('Compra ' + (index + 1) + ' (' + description + '): parcelas devem ser um inteiro entre 1 e 240.');
    }

    const rawCategory = typeof row.category === 'string' ? row.category.trim()
      : typeof row.categoryName === 'string' ? row.categoryName.trim() : '';
    const legacyDebtorCategory = normalize(rawCategory) === 'devedores';
    let categoryId: string | undefined;
    if (row.categoryId !== undefined && typeof row.categoryId === 'string') {
      if (!categories.some((item) => item.id === row.categoryId)) {
        throw new Error('Compra ' + (index + 1) + ' (' + description + '): categoria não encontrada.');
      }
      categoryId = row.categoryId;
    } else if (rawCategory && !legacyDebtorCategory) {
      const found = categories.find((item) => normalize(item.name) === normalize(rawCategory));
      if (!found) throw new Error('Compra ' + (index + 1) + ' (' + description + '): categoria "' + rawCategory + '" não existe neste NEXO.');
      categoryId = found.id;
    }

    const expenseClass = row.expenseClass;
    if (expenseClass !== undefined && !['Investimento', 'Essencial', 'Supérfluo'].includes(String(expenseClass))) {
      throw new Error('Compra ' + (index + 1) + ' (' + description + '): classe de despesa inválida.');
    }
    const notes = typeof row.notes === 'string' ? row.notes.trim() : undefined;
    const rawShared = row.sharedWith;
    const rawDebtor = row.debtor;
    if (rawShared !== undefined && rawDebtor !== undefined) {
      throw new Error('Compra ' + (index + 1) + ' (' + description + '): use "sharedWith" ou "debtor", não os dois.');
    }

    const readPersonAmount = (value: unknown, label: string, fullAmountAllowed: boolean) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Compra ' + (index + 1) + ' (' + description + '): "' + label + '" deve conter pessoa e valor em centavos.');
      }
      const personData = value as Record<string, unknown>;
      const requestedPerson = typeof personData.person === 'string' ? personData.person.trim() : '';
      const person = personRecords.get(normalize(requestedPerson));
      if (!person) {
        throw new Error('Compra ' + (index + 1) + ' (' + description + '): cadastre "' + (requestedPerson || 'a pessoa') + '" em Devedores antes de importar.');
      }
      const amountCents = personData.amountCents === undefined && fullAmountAllowed
        ? totalCents : Number(personData.amountCents);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0
        || (fullAmountAllowed ? amountCents > totalCents : amountCents >= totalCents)) {
        throw new Error('Compra ' + (index + 1) + ' (' + description + '): valor de "' + label + '" inválido.');
      }
      return { person, amountCents };
    };

    let sharedWith: { person: string; amountCents: number } | undefined;
    let debtorDue: { person: string; amountCents: number } | undefined;
    if (rawShared !== undefined) {
      sharedWith = readPersonAmount(rawShared, 'sharedWith', false);
    } else if (rawDebtor !== undefined) {
      debtorDue = readPersonAmount(rawDebtor, 'debtor', true);
    } else if (legacyDebtorCategory) {
      // Supports the earlier JSON example: category "Devedores" plus a note
      // like "Lançamento separado referente à Lê." records the full amount as owed.
      const noteMatch = notes?.match(/referente\s+(?:à|a)\s+(.+?)[.!]?$/i);
      const descriptionMatch = description.match(/\s-\s(.+)$/);
      const inferredPerson = noteMatch?.[1]?.trim() || descriptionMatch?.[1]?.trim() || '';
      debtorDue = readPersonAmount({ person: inferredPerson }, 'debtor', true);
    }

    return {
      description, totalCents, purchaseDate: row.purchaseDate, firstDueMonth, installmentsCount,
      categoryId, expenseClass: expenseClass as Transaction['expenseClass'] | undefined,
      notes, sharedWith, debtorDue,
    };
  });

  const totalCents = entries.reduce((sum, entry) => sum + entry.totalCents, 0);
  const currentInstallments = await db.installments.where('cardId').equals(card.id).toArray();
  const currentCommitment = currentInstallments.reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
  if (card.limitCents > 0 && totalCents + currentCommitment > card.limitCents) {
    throw new Error('A importação excede o limite cadastrado do cartão. Limite livre estimado: R$ ' + ((card.limitCents - currentCommitment) / 100).toFixed(2) + '.');
  }

  // Deterministic IDs prevent importing the same JSON batch twice.
  const signature = JSON.stringify({
    cardId: card.id,
    entries: entries.map((entry) => [
      entry.description, entry.totalCents, entry.purchaseDate, entry.firstDueMonth, entry.installmentsCount,
      entry.categoryId ?? '', entry.expenseClass ?? '', entry.notes ?? '',
      entry.sharedWith?.person ?? '', entry.sharedWith?.amountCents ?? 0,
      entry.debtorDue?.person ?? '', entry.debtorDue?.amountCents ?? 0,
    ]),
  });
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = (hash >>> 0).toString(36);
  const createdAt = new Date().toISOString();
  const purchaseRows = entries.map((entry, index) => ({
    id: 'json-' + fingerprint + '-' + (index + 1),
    description: entry.description, totalCents: entry.totalCents, cardId: card.id,
    categoryId: entry.categoryId, expenseClass: entry.expenseClass,
    purchaseDate: entry.purchaseDate, firstDueMonth: entry.firstDueMonth,
    installmentsCount: entry.installmentsCount, createdAt, notes: entry.notes,
  }));
  const existing = await db.purchases.bulkGet(purchaseRows.map((item) => item.id));
  if (existing.some(Boolean)) {
    throw new Error('Este JSON já foi importado (ou contém compras já importadas). Nenhum registro foi alterado.');
  }

  const installmentRows = entries.flatMap((entry, index) => {
    const amounts = splitInstallmentCents(entry.totalCents, entry.installmentsCount);
    return amounts.map((amountCents, installmentIndex) => {
      const dueMonth = monthOffset(entry.firstDueMonth, installmentIndex);
      const day = Math.min(card.dueDay, daysInMonth(dueMonth));
      return {
        id: 'json-' + fingerprint + '-i-' + (index + 1) + '-' + (installmentIndex + 1),
        purchaseId: purchaseRows[index].id, cardId: card.id,
        number: installmentIndex + 1, count: entry.installmentsCount,
        amountCents, paidCents: 0, dueMonth,
        dueDate: dueMonth + '-' + String(day).padStart(2, '0'),
      };
    });
  });
  const debtorRows = entries.flatMap((entry, index) => {
    const amount = entry.sharedWith ?? entry.debtorDue;
    if (!amount) return [];
    return [{
      id: 'json-' + fingerprint + '-d-' + (index + 1),
      person: amount.person,
      description: entry.sharedWith
        ? 'Divisão da conta: ' + entry.description
        : 'Compra para ' + amount.person + ': ' + entry.description,
      originalCents: amount.amountCents, originDate: entry.purchaseDate,
      categoryId: entry.categoryId, originalPayment: 'Cartão de crédito',
      notes: entry.notes, sharedPurchaseId: purchaseRows[index].id, createdAt,
    }];
  });
  const months = [...new Set(installmentRows.map((item) => item.dueMonth))]
    .map((month) => ({ id: month, month, createdAt }));

  await db.transaction('rw', db.purchases, db.installments, db.months, db.debtors, async () => {
    await db.purchases.bulkAdd(purchaseRows);
    await db.installments.bulkAdd(installmentRows);
    await db.months.bulkPut(months);
    if (debtorRows.length) await db.debtors.bulkAdd(debtorRows);
  });

  return {
    importedCount: purchaseRows.length, totalCents, cardName: card.name,
    firstDueMonth: entries[0].firstDueMonth, debtorCount: debtorRows.length,
  };
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
  const otherCommitments = targetCardInstallments
    .filter((item) => item.purchaseId !== purchase.id)
    .reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
  const newCommitment = installmentRows.reduce((sum, item) => sum + Math.max(0, item.amountCents - item.paidCents), 0);
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
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases',
  ] as const;
  const payload: Record<string, unknown> = { app: 'Nexo', schemaVersion: 3, exportedAt: new Date().toISOString() };
  for (const table of tables) payload[table] = await db.table(table).toArray();
  return payload;
}

export async function restoreBackup(payload: unknown, replace = false) {
  if (!payload || typeof payload !== 'object' || (payload as { app?: string }).app !== 'Nexo') {
    throw new Error('Arquivo de backup inválido ou versão não suportada.');
  }
  const schemaVersion = (payload as { schemaVersion?: number }).schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) throw new Error('Arquivo de backup inválido ou versão não suportada.');
  const tables = [
    'categories', 'accounts', 'cards', 'transactions', 'purchases', 'installments', 'invoicePayments', 'transfers',
    'debtors', 'debtorPayments', 'reserves', 'reserveMovements', 'reserveClosings', 'monthlyBudgets', 'months', 'investments',
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases',
  ] as const;
  const data = payload as Record<string, unknown>;
  for (const table of tables) {
    if (table === 'wishlistPurchases' && data[table] === undefined && schemaVersion === 1) data[table] = [];
    if (table === 'reserveClosings' && data[table] === undefined && schemaVersion < 3) data[table] = [];
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
  const linkedDebtors = await db.debtors.where('sharedPurchaseId').equals(purchaseId).toArray();
  for (const debtor of linkedDebtors) await deleteDebtor(debtor.id);
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
    'investmentMovements', 'cdiRates', 'cdiAccruals', 'settings', 'wishlistPurchases',
  ] as const;
  await db.transaction('rw', tables.map((name) => db.table(name)), async () => {
    for (const name of tables) await db.table(name).clear();
  });
  await initializeDatabase();
}
