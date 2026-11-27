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

/** Annual effective rate converted to one Brazilian bank-business-day rate. */
export function calculateDailyReserveRate(annualRatePercent: number): number {
  if (!Number.isFinite(annualRatePercent) || annualRatePercent < 0 || annualRatePercent > 100) {
    throw new Error('Taxa anual da caixinha inválida.');
  }
  return Math.pow(1 + annualRatePercent / 100, 1 / 252) - 1;
}

function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Gregorian Easter Sunday, used to derive the movable Brazilian bank holidays. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Nationwide Brazilian bank-calendar holidays; local/state holidays are not included. */
export function getBrazilBankHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  return new Set([
    `${year}-01-01`,
    shiftIsoDate(easter, -48), // Carnival Monday
    shiftIsoDate(easter, -47), // Carnival Tuesday
    shiftIsoDate(easter, -2),  // Good Friday
    `${year}-04-21`,
    `${year}-05-01`,
    shiftIsoDate(easter, 60),  // Corpus Christi
    `${year}-09-07`,
    `${year}-10-12`,
    `${year}-11-02`,
    `${year}-11-15`,
    `${year}-11-20`,
    `${year}-12-25`,
    `${year}-12-31`, // banks do not serve the public on the last day of the year
  ]);
}

/** Returns true only on nationwide Brazilian bank-business days. */
export function isBrazilBankBusinessDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  const weekday = parsed.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !getBrazilBankHolidays(year).has(date);
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
  const releasedCents = Math.min(withdrawalCents, Math.max(0, countedReserveCents));
  return releasedCents === 0 ? 0 : -releasedCents;
}

/** Wishlist spending is independent from cash, investments, and patrimony. */
export function calculateWishlistRemainingCents(initialCents: number, purchasesCents: number[]): number {
  return initialCents - purchasesCents.reduce((sum, amount) => sum + amount, 0);
}


/** Finance starts in December 2026. Earlier expense entries are setup records. */
export const FINANCIAL_START_MONTH = '2026-12';

export function isMonthInAccountingPeriod(month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && month >= FINANCIAL_START_MONTH;
}

export function isExpenseInAccountingPeriod(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date.slice(0, 7) >= FINANCIAL_START_MONTH;
}
