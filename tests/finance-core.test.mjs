import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateInvoicePayment,
  calculateAvailableCardLimit,
  calculateDailyCdiRate,
  calculateDailyReserveRate,
  isBrazilBankBusinessDay,
  calculateFreeCashCents,
  calculateReserveWithdrawalImpactCents,
  calculateWishlistRemainingCents,
  calculateMonthlyFreeCents,
  calculateReserveRemaining,
  splitInstallmentCents,
  FINANCIAL_START_MONTH,
  isMonthInAccountingPeriod,
  isExpenseInAccountingPeriod,
  isTransactionVisibleByDate,
} from '../.tmp-tests/calculations.js';

test('divisão de compra em seis parcelas preserva o total', () => {
  const parts = splitInstallmentCents(120000, 6);
  assert.deepEqual(parts, [20000, 20000, 20000, 20000, 20000, 20000]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 120000);
});

test('parcelas com centavos restantes não perdem nem criam dinheiro', () => {
  const parts = splitInstallmentCents(1000, 3);
  assert.deepEqual(parts, [334, 333, 333]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
});

test('saldo mensal desconta a parcela de cada mês e reservas líquidas', () => {
  const result = calculateMonthlyFreeCents({
    incomeCents: 150000,
    cashExpensesCents: 0,
    installmentsCents: 20000,
    reserveDepositsCents: 0,
    reserveWithdrawalsCents: 0,
  });
  assert.equal(result, 130000);
});

test('aporte reduz saldo livre sem transformar a reserva em despesa definitiva', () => {
  const result = calculateMonthlyFreeCents({
    incomeCents: 100000,
    cashExpensesCents: 0,
    installmentsCents: 0,
    reserveDepositsCents: 30000,
    reserveWithdrawalsCents: 0,
  });
  assert.equal(result, 70000);
  assert.equal(calculateReserveRemaining(1000000, 250000), 750000);
});

test('pagamento libera limite somente pelo valor ainda comprometido', () => {
  assert.equal(calculateAvailableCardLimit(200000, 80000), 120000);
  assert.equal(calculateAvailableCardLimit(200000, 250000), 0);
});

test('taxa diária é positiva e menor que a anual', () => {
  const daily = calculateDailyCdiRate(13, 140);
  assert.ok(daily > 0 && daily < 0.001);
  assert.equal(calculateDailyCdiRate(0, 140), 0);
});

test('pagamento parcial da fatura aloca valor às parcelas abertas mais antigas', () => {
  const result = allocateInvoicePayment([
    { id: 'parcela-1', amountCents: 20000, paidCents: 5000 },
    { id: 'parcela-2', amountCents: 20000, paidCents: 0 },
  ], 25000);
  assert.deepEqual(result.allocations, [
    { installmentId: 'parcela-1', amountCents: 15000 },
    { installmentId: 'parcela-2', amountCents: 10000 },
  ]);
  assert.equal(result.remainingCents, 0);
});

test('pagamento excedente é detectável sem criar saldo negativo', () => {
  const result = allocateInvoicePayment([{ id: 'parcela-1', amountCents: 20000, paidCents: 0 }], 25000);
  assert.equal(result.allocations[0].amountCents, 20000);
  assert.equal(result.remainingCents, 5000);
});


test('saldo livre ignora a reserva inicial e desconta somente novos aportes líquidos', () => {
  const free = calculateFreeCashCents(732795, [
    { reserveId: 'caixinha-1', impactCents: 0 }, // valor que já estava reservado antes do controle
    { reserveId: 'caixinha-1', impactCents: 10000 },
    { reserveId: 'caixinha-1', impactCents: -4000 },
    { reserveId: 'caixinha-2', impactCents: 5000 },
  ]);
  assert.equal(free, 721795);
});

test('retirada libera somente a parte formada por aportes novos', () => {
  assert.equal(calculateReserveWithdrawalImpactCents(7000, 3000), -3000);
  assert.equal(calculateReserveWithdrawalImpactCents(2000, 8000), -2000);
  assert.equal(calculateReserveWithdrawalImpactCents(2000, 0), 0);
});

test('lista de desejo desconta compras do valor inicial sem interferir no patrimônio', () => {
  assert.equal(calculateWishlistRemainingCents(50000, [12000, 8500]), 29500);
  assert.equal(calculateWishlistRemainingCents(10000, [12000]), -2000);
});


test('despesas de preparação anteriores a dezembro de 2026 não entram no período financeiro', () => {
  assert.equal(FINANCIAL_START_MONTH, '2026-12');
  assert.equal(isExpenseInAccountingPeriod('2026-11-01'), false);
  assert.equal(isExpenseInAccountingPeriod('2026-11-30'), false);
  assert.equal(isExpenseInAccountingPeriod('2026-12-01'), true);
  assert.equal(isMonthInAccountingPeriod('2026-11'), false);
  assert.equal(isMonthInAccountingPeriod('2026-12'), true);
  assert.equal(isMonthInAccountingPeriod('2027-01'), true);
});

test('taxa anual da caixinha é convertida para 252 dias úteis', () => {
  const daily = calculateDailyReserveRate(14);
  assert.ok(daily > 0 && daily < 0.001);
  assert.ok(Math.abs(Math.pow(1 + daily, 252) - 1.14) < 1e-10);
});

test('calendário bancário brasileiro exclui fins de semana e feriados móveis e fixos', () => {
  assert.equal(isBrazilBankBusinessDay('2026-03-02'), true);
  assert.equal(isBrazilBankBusinessDay('2026-11-28'), false); // sábado
  assert.equal(isBrazilBankBusinessDay('2026-02-16'), false); // Carnaval
  assert.equal(isBrazilBankBusinessDay('2026-02-17'), false); // Carnaval
  assert.equal(isBrazilBankBusinessDay('2026-02-18'), true); // expediente parcial, é dia útil
  assert.equal(isBrazilBankBusinessDay('2026-04-03'), false); // Paixão de Cristo
  assert.equal(isBrazilBankBusinessDay('2026-06-04'), false); // Corpus Christi
  assert.equal(isBrazilBankBusinessDay('2026-11-20'), false); // Consciência Negra
  assert.equal(isBrazilBankBusinessDay('2026-12-31'), false); // sem expediente bancário ao público
  assert.equal(isBrazilBankBusinessDay('2026-02-30'), false); // data inválida
});


test('movimentações e receitas com data válida aparecem na data prevista', () => {
  assert.equal(isTransactionVisibleByDate('2026-11-27', '2026-11-27'), true);
  assert.equal(isTransactionVisibleByDate('2026-12-15', '2026-11-14'), false);
  assert.equal(isTransactionVisibleByDate('2026-12-15', '2026-11-15'), true);
  assert.equal(isTransactionVisibleByDate('2026-12-15', '2026-12-15'), true);
  assert.equal(isTransactionVisibleByDate('inválida', '2026-12-15'), false);
  assert.equal(isTransactionVisibleByDate('2026-12-15', 'inválida'), false);
});
