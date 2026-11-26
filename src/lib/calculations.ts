/** Split a total number of cents into installments without losing cents. */
export function splitInstallmentCents(totalCents: number, count: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('Valor total inválido.');
  if (!Number.isInteger(count) || count < 1) throw new Error('Quantidade de parcelas inválida.');
  const base = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function calculateMonthlyFreeCents(input: {
  incomeCents: number;
  cashExpensesCents: number;
  installmentsCents: number;
  reserveDepositsCents: number;
  reserveWithdrawalsCents: number;
}): number {
  return input.incomeCents - input.cashExpensesCents - input.installmentsCents - input.reserveDepositsCents + input.reserveWithdrawalsCents;
}

export function calculateAvailableCardLimit(limitCents: number, unpaidInstallmentsCents: number): number {
  return Math.max(0, limitCents - unpaidInstallmentsCents);
}

export function calculateReserveRemaining(targetCents: number, reservedCents: number): number {
  return Math.max(targetCents - reservedCents, 0);
}

/** Annual effective rate converted to a daily rate on 252 business days. */
export function calculateDailyCdiRate(annualRatePercent: number, cdiPercent: number): number {
  if (!Number.isFinite(annualRatePercent) || annualRatePercent < 0 || annualRatePercent > 100) throw new Error('Taxa CDI anual inválida.');
  if (!Number.isFinite(cdiPercent) || cdiPercent < 0) throw new Error('Percentual do CDI inválido.');
  return (Math.pow(1 + annualRatePercent / 100, 1 / 252) - 1) * (cdiPercent / 100);
}

export function allocateInvoicePayment<T extends { id: string; amountCents: number; paidCents: number }>(
  installments: T[], paymentCents: number,
): { allocations: Array<{ installmentId: string; amountCents: number }>; remainingCents: number } {
  if (!Number.isSafeInteger(paymentCents) || paymentCents < 0) throw new Error('Pagamento inválido.');
  let remainingCents = paymentCents;
  const allocations: Array<{ installmentId: string; amountCents: number }> = [];
  for (const item of installments) {
    if (remainingCents <= 0) break;
    const open = Math.max(0, item.amountCents - item.paidCents);
    const allocated = Math.min(open, remainingCents);
    if (allocated > 0) allocations.push({ installmentId: item.id, amountCents: allocated });
    remainingCents -= allocated;
  }
  return { allocations, remainingCents };
}

/** Bank cash excludes only reserve contributions made after reserve tracking was introduced. */
export function calculateFreeCashCents(
  cashCents: number,
  impacts: Array<{ reserveId: string; impactCents: number }>,
): number {
  const byReserve = new Map<string, number>();
  for (const movement of impacts) {
    byReserve.set(movement.reserveId, (byReserve.get(movement.reserveId) ?? 0) + movement.impactCents);
  }
  const countedReservedCents = [...byReserve.values()].reduce((sum, balance) => sum + Math.max(0, balance), 0);
  return cashCents - countedReservedCents;
}

/** A withdrawal releases only the part of the reserve that was funded by new deposits. */
export function calculateReserveWithdrawalImpactCents(withdrawalCents: number, countedReserveCents: number): number {
  if (!Number.isSafeInteger(withdrawalCents) || withdrawalCents < 0) throw new Error('Valor de retirada inválido.');
  return -Math.min(withdrawalCents, Math.max(0, countedReserveCents));
}

/** Wishlist spending is independent from cash, investments, and patrimony. */
export function calculateWishlistRemainingCents(initialCents: number, purchasesCents: number[]): number {
  return initialCents - purchasesCents.reduce((sum, amount) => sum + amount, 0);
}
