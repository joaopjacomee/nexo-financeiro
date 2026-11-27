import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bookmark, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, GitCompareArrows, Plus, Repeat2, Trash2 } from 'lucide-react';
import { db } from './lib/db';
import { dateBR, fromCents, money, monthBR, today, toCents } from './lib/format';
import { getCategorySpend, getInstallmentsForMonth, getMonthSummary } from './lib/finance';
import { isTransactionVisibleByDate } from './lib/calculations';
import { deleteRecurringTransaction, deleteTransactionTemplate, saveRecurringTransaction, saveTransaction, saveTransactionTemplate, syncRecurringTransactions } from './lib/operations';
import type { Category, RecurringFrequency, RecurringTransaction, Transaction, TransactionTemplate } from './types';

type ExtraData = { categories: Category[]; accounts: Array<{ id: string; name: string }>; cards: Array<{ id: string; name: string }> };
type ExtraProps = {
  data: ExtraData; month: string; setMonth: (value: string) => void; showValues: boolean; revision: number;
  act: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
};
type FrequencyValue = '' | RecurringFrequency;
const frequencyLabels: Record<RecurringFrequency, string> = {
  daily: 'Diariamente', weekly: 'Toda semana', biweekly: 'A cada 2 semanas', monthly: 'Todo mês', yearly: 'Todo ano',
};
function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}
function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={'panel ' + className}>{children}</section>;
}
function MonthControl({ month, setMonth }: { month: string; setMonth: (value: string) => void }) {
  return <div className="month-selector">
    <button className="icon-button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mês anterior"><ChevronLeft size={17}/></button>
    <input type="month" value={month} onChange={(event) => setMonth(event.target.value)}/>
    <button className="icon-button" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Próximo mês"><ChevronRight size={17}/></button>
  </div>;
}
function shiftMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(year, value - 1 + offset, 1);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}
function field(label: string, child: ReactNode, wide = false) {
  return <label className={'form-field ' + (wide ? 'field-wide' : '')}><span>{label}</span>{child}</label>;
}
function MoneyField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <input value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => { onChange(fromCents(toCents(event.target.value))); }} inputMode="decimal" placeholder="0,00"/>;
}
function amountText(amount: number, hidden: boolean) { return hidden ? '••••••' : money(amount); }

export function RecurringTransactionsPage({ data, revision, showValues, act }: ExtraProps) {
  const [rules, setRules] = useState<RecurringTransaction[]>([]);
  const [form, setForm] = useState({
    type: 'expense' as 'income' | 'expense', description: '', amount: '', frequency: '' as FrequencyValue,
    startDate: today(), endDate: '', categoryId: '', expenseClass: 'Essencial' as NonNullable<Transaction['expenseClass']>,
    paymentMode: 'pix' as 'pix' | 'cash' | 'card-debit' | 'other', accountId: data.accounts[0]?.id ?? '', notes: '',
  });
  useEffect(() => {
    let active = true;
    Promise.all([db.recurringTransactions.orderBy('startDate').toArray(), syncRecurringTransactions()])
      .then(([items]) => { if (active) setRules(items.sort((a, b) => a.startDate.localeCompare(b.startDate))); });
    return () => { active = false; };
  }, [revision]);
  const save = () => act(async () => {
    if (!form.frequency) throw new Error('Escolha a frequência para configurar a recorrência.');
    await saveRecurringTransaction({
      type: form.type, description: form.description.trim(), amountCents: toCents(form.amount),
      frequency: form.frequency, startDate: form.startDate, endDate: form.endDate || undefined,
      categoryId: form.categoryId || undefined, expenseClass: form.type === 'expense' ? form.expenseClass : undefined,
      paymentMode: form.paymentMode, accountId: form.paymentMode === 'other' ? undefined : form.accountId || undefined, notes: form.notes,
    });
  }, 'Movimentação recorrente salva. Os lançamentos já visíveis foram gerados.').then((ok) => {
    if (ok) setForm({ type: 'expense', description: '', amount: '', frequency: '', startDate: today(), endDate: '', categoryId: '', expenseClass: 'Essencial', paymentMode: 'pix', accountId: data.accounts[0]?.id ?? '', notes: '' });
  });
  return <>
    <Heading eyebrow="AUTOMAÇÃO FINANCEIRA" title="Movimentações recorrentes" description="Cadastre receitas e despesas que se repetem. Os lançamentos aparecem automaticamente a partir de um mês antes da data programada."/>
    <Panel className="recurring-editor">
      <div className="panel-header"><div><h3>Nova recorrência</h3><p>Comece escolhendo a frequência; as opções de período e pagamento aparecem em seguida.</p></div><Repeat2 size={19}/></div>
      <div className="form-grid">
        {field('Tipo', <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as 'income' | 'expense' })}><option value="expense">Saída</option><option value="income">Entrada</option></select>)}
        {field('Descrição', <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Ex.: Salário, internet, aluguel"/>, true)}
        {field('Valor (R$)', <MoneyField value={form.amount} onChange={(amount) => setForm({ ...form, amount })}/>)}
        {field('Frequência', <select value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value as FrequencyValue })}><option value="">Selecione a frequência</option><option value="daily">Diariamente</option><option value="weekly">Toda semana</option><option value="biweekly">A cada 2 semanas</option><option value="monthly">Todo mês</option><option value="yearly">Todo ano</option></select>)}
        {form.frequency ? <>
          {field('Data de início', <input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })}/>)}
          {field('Data de fim (opcional)', <input type="date" min={form.startDate} value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })}/>)}
          {field('Categoria', <select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}><option value="">Sem categoria</option>{data.categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select>)}
          {form.type === 'expense' && field('Classificação', <select value={form.expenseClass} onChange={(event) => setForm({ ...form, expenseClass: event.target.value as NonNullable<Transaction['expenseClass']> })}><option value="Investimento">Investimento</option><option value="Essencial">Essencial</option><option value="Supérfluo">Supérfluo</option></select>)}
          {field('Forma de pagamento', <select value={form.paymentMode} onChange={(event) => setForm({ ...form, paymentMode: event.target.value as typeof form.paymentMode })}><option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="card-debit">Cartão de débito</option><option value="other">Outro</option></select>)}
          {form.paymentMode !== 'other' && field('Conta utilizada', <select value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">Selecione a conta</option>{data.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select>)}
          {field('Observações', <textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })}/>, true)}
          <div className="form-footnote field-wide"><CalendarDays size={15}/> O primeiro lançamento segue a data de início. As próximas datas respeitam a frequência escolhida. Cartão de crédito não é usado diretamente em recorrências; registre a compra no crédito pela área de movimentações para gerar suas parcelas.</div>
          <div className="form-actions field-wide"><button className="btn btn-secondary" onClick={() => setForm({ ...form, frequency: '', endDate: '' })}>Limpar frequência</button><button className="btn btn-primary" onClick={save} disabled={!form.description.trim() || toCents(form.amount || '0') <= 0 || (form.paymentMode !== 'other' && !form.accountId) || !form.startDate || !form.frequency}><Plus size={15}/> Salvar recorrência</button></div>
        </> : <div className="form-footnote field-wide"><Clock3 size={15}/> Escolha uma frequência para mostrar as datas de início e fim e as demais informações do lançamento.</div>}
      </div>
    </Panel>
    <Panel>
      <div className="panel-header"><div><h3>Recorrências cadastradas</h3><p>{rules.length} regra(s) salva(s) neste dispositivo. Excluir uma regra remove apenas lançamentos futuros gerados por ela.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>DESCRIÇÃO</th><th>TIPO</th><th>FREQUÊNCIA</th><th>PERÍODO</th><th>FORMA</th><th>VALOR</th><th></th></tr></thead><tbody>
        {rules.map((rule) => <tr key={rule.id}><td><strong>{rule.description}</strong><small className="subline">{rule.notes || ' '}</small></td><td>{rule.type === 'income' ? 'Entrada' : 'Saída'}</td><td>{frequencyLabels[rule.frequency]}</td><td>{dateBR(rule.startDate)} até {rule.endDate ? dateBR(rule.endDate) : 'sem fim'}</td><td>{rule.paymentMode === 'pix' ? 'Pix' : rule.paymentMode === 'cash' ? 'Dinheiro' : rule.paymentMode === 'card-debit' ? 'Débito' : 'Outro'}</td><td className={rule.type === 'income' ? 'positive' : 'negative'}>{amountText(rule.amountCents, !showValues)}</td><td><button className="icon-button mini danger-icon" title="Excluir recorrência" onClick={() => { void act(() => deleteRecurringTransaction(rule.id), 'Recorrência excluída.'); }}><Trash2 size={14}/></button></td></tr>)}
      </tbody></table>{!rules.length && <div className="table-empty">Nenhuma movimentação recorrente cadastrada.</div>}</div>
    </Panel>
    <div className="info-note"><CalendarDays size={17}/><span>Para um lançamento futuro, o NEXO só o disponibiliza quando faltar um mês ou menos para a data programada. No dia do lançamento, a movimentação passa de prevista para efetivada automaticamente.</span></div>
  </>;
}

type CalendarEvent = { id: string; date: string; title: string; kind: 'income' | 'expense' | 'installment' | 'reserve' | 'card-due'; amountCents: number; detail: string };
export function FinancialCalendarPage({ month, setMonth, revision, showValues }: ExtraProps) {
  const [selectedDate, setSelectedDate] = useState(month + '-01');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  useEffect(() => { setSelectedDate(month + '-01'); }, [month]);
  useEffect(() => {
    let active = true;
    Promise.all([
      db.transactions.where('month').equals(month).toArray(),
      getInstallmentsForMonth(month),
      db.purchases.toArray(),
      db.reserveMovements.where('date').between(month + '-01', month + '-31', true, true).toArray(),
      db.cards.toArray(),
    ]).then(([transactions, installments, purchases, reserves, cards]) => {
      if (!active) return;
      const rows: CalendarEvent[] = transactions.filter((item) => item.status !== 'cancelled' && isTransactionVisibleByDate(item.date, today())).map((item) => ({
        id: item.id, date: item.date, title: item.description, kind: item.type, amountCents: item.amountCents,
        detail: item.type === 'income' ? 'Entrada' : 'Saída',
      }));
      const purchaseMap = new Map(purchases.map((item) => [item.id, item]));
      for (const card of cards) {
        const cardInstallments = installments.filter((item) => item.cardId === card.id);
        if (!cardInstallments.length) continue;
        const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
        const dueDate = month + '-' + String(Math.min(Math.max(1, card.dueDay), lastDay)).padStart(2, '0');
        if (!isTransactionVisibleByDate(dueDate, today())) continue;
        const remainingCents = cardInstallments.reduce((total, item) => total + Math.max(0, item.amountCents - item.paidCents), 0);
        rows.push({
          id: 'card-due-' + card.id + '-' + month, date: dueDate, title: 'Vencimento · ' + card.name,
          kind: 'card-due', amountCents: remainingCents,
          detail: remainingCents > 0 ? 'Vencimento da fatura' : 'Fatura paga',
        });
      }
      for (const item of installments.filter((entry) => isTransactionVisibleByDate(entry.dueDate, today()))) {
        const purchase = purchaseMap.get(item.purchaseId);
        rows.push({ id: item.id, date: item.dueDate, title: purchase?.description ?? 'Compra no crédito', kind: 'installment', amountCents: item.amountCents, detail: 'Parcela ' + item.number + '/' + item.count + ' · Fatura' });
      }
      for (const move of reserves.filter((entry) => isTransactionVisibleByDate(entry.date, today()))) {
        rows.push({ id: move.id, date: move.date, title: move.notes || 'Movimentação de caixinha', kind: 'reserve', amountCents: move.amountCents, detail: move.type === 'withdrawal' ? 'Retirada de caixinha' : move.type === 'deposit' ? 'Depósito em caixinha' : 'Rendimento / ajuste' });
      }
      setEvents(rows.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)));
    });
    return () => { active = false; };
  }, [month, revision]);
  const [year, monthNumber] = month.split('-').map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const totalDays = new Date(year, monthNumber, 0).getDate();
  const calendarCells = [...Array(firstWeekday).fill(null), ...Array.from({ length: totalDays }, (_, index) => index + 1)];
  const selectedEvents = events.filter((event) => event.date === selectedDate);
  const todayKey = today();
  return <>
    <Heading eyebrow="AGENDA FINANCEIRA" title="Calendário financeiro" description="Visualize entradas, saídas e vencimentos de parcelas no dia em que acontecem." action={<MonthControl month={month} setMonth={setMonth}/>}/>
    <Panel className="financial-calendar-panel">
      <div className="calendar-weekdays">{['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="financial-calendar-grid">
        {calendarCells.map((day, index) => {
          if (!day) return <div className="calendar-blank" key={'blank-' + index}/>;
          const key = month + '-' + String(day).padStart(2, '0');
          const dayEvents = events.filter((event) => event.date === key);
          return <button key={key} className={'calendar-day' + (selectedDate === key ? ' selected' : '') + (todayKey === key ? ' is-today' : '')} onClick={() => setSelectedDate(key)}>
            <strong>{day}</strong><span className="calendar-day-dots">{dayEvents.slice(0, 4).map((event) => <i key={event.id} className={'calendar-dot ' + event.kind}/>)}</span>
            {dayEvents.length > 0 && <small>{dayEvents.length} evento(s)</small>}
          </button>;
        })}
      </div>
    </Panel>
    <Panel>
      <div className="panel-header"><div><h3>{dateBR(selectedDate)}</h3><p>{selectedEvents.length} evento(s) neste dia</p></div></div>
      {selectedEvents.length ? <div className="event-list">{selectedEvents.map((event) => <div className="event-row" key={event.id}><span className={'event-marker ' + event.kind}/><div className="event-main"><strong>{event.title}</strong><span>{event.detail}</span></div><strong className={event.kind === 'income' ? 'positive' : 'negative'}>{showValues ? (event.kind === 'income' ? '+' : '−') + money(event.amountCents) : '••••'}</strong></div>)}</div> : <div className="table-empty">Nenhuma movimentação visível neste dia.</div>}
    </Panel>
    <div className="info-note"><CalendarDays size={17}/><span>As parcelas aparecem pelo vencimento da fatura; as compras no crédito continuam registradas pela data original na lista de movimentações.</span></div>
  </>;
}

export function MonthComparisonPage({ month, setMonth, showValues, revision }: ExtraProps) {
  const previousMonth = shiftMonth(month, -1);
  const [current, setCurrent] = useState<Awaited<ReturnType<typeof getMonthSummary>> | null>(null);
  const [previous, setPrevious] = useState<Awaited<ReturnType<typeof getMonthSummary>> | null>(null);
  const [currentCategories, setCurrentCategories] = useState<Awaited<ReturnType<typeof getCategorySpend>>>([]);
  const [previousCategories, setPreviousCategories] = useState<Awaited<ReturnType<typeof getCategorySpend>>>([]);
  useEffect(() => {
    let active = true;
    Promise.all([getMonthSummary(month), getMonthSummary(previousMonth), getCategorySpend(month), getCategorySpend(previousMonth)])
      .then(([nowSummary, previousSummary, nowCategories, oldCategories]) => {
        if (!active) return;
        setCurrent(nowSummary); setPrevious(previousSummary);
        setCurrentCategories(nowCategories); setPreviousCategories(oldCategories);
      });
    return () => { active = false; };
  }, [month, previousMonth, revision]);
  const metrics = [
    { label: 'Receitas', current: current?.incomeCents ?? 0, previous: previous?.incomeCents ?? 0, kind: 'income' },
    { label: 'Despesas à vista', current: current?.cashExpensesCents ?? 0, previous: previous?.cashExpensesCents ?? 0, kind: 'expense' },
    { label: 'Parcelas de crédito', current: current?.installmentsCents ?? 0, previous: previous?.installmentsCents ?? 0, kind: 'expense' },
    { label: 'Saldo livre', current: current?.freeCents ?? 0, previous: previous?.freeCents ?? 0, kind: 'income' },
  ];
  const categories = useMemo(() => {
    const values = new Map<string, { name: string; current: number; previous: number }>();
    for (const item of currentCategories) values.set(item.category.id, { name: item.category.name, current: item.spentCents, previous: 0 });
    for (const item of previousCategories) {
      const value = values.get(item.category.id) ?? { name: item.category.name, current: 0, previous: 0 };
      value.previous = item.spentCents; values.set(item.category.id, value);
    }
    return [...values.values()].sort((a, b) => (b.current + b.previous) - (a.current + a.previous));
  }, [currentCategories, previousCategories]);
  return <>
    <Heading eyebrow="ANÁLISE DE EVOLUÇÃO" title="Comparativo entre meses" description="Compare receitas, despesas, parcelas e gastos por categoria com o mês imediatamente anterior." action={<MonthControl month={month} setMonth={setMonth}/>}/>
    <div className="comparison-period-label"><span>{monthBR(previousMonth)}</span><ChevronRight size={15}/><strong>{monthBR(month)}</strong></div>
    <div className="comparison-metric-grid">
      {metrics.map((item) => {
        const difference = item.current - item.previous;
        const percentage = item.previous !== 0 ? (difference / Math.abs(item.previous)) * 100 : null;
        const positive = item.kind === 'income' ? difference >= 0 : difference <= 0;
        return <Panel className="comparison-metric" key={item.label}>
          <span>{item.label}</span><strong>{amountText(item.current, !showValues)}</strong>
          <small className={positive ? 'positive' : 'negative'}>{showValues ? (difference > 0 ? '+' : '') + money(difference) + (percentage === null ? ' · sem base anterior' : ' · ' + (percentage > 0 ? '+' : '') + percentage.toFixed(1).replace('.', ',') + '%') : 'Comparação oculta'}</small>
          <div className="comparison-bars"><i style={{ width: Math.min(100, item.previous ? item.previous / Math.max(item.current, item.previous) * 100 : 0) + '%' }}/><i style={{ width: Math.min(100, item.current ? item.current / Math.max(item.current, item.previous) * 100 : 0) + '%' }}/></div>
          <div className="comparison-small-labels"><small>Anterior</small><small>Atual</small></div>
        </Panel>;
      })}
    </div>
    <Panel><div className="panel-header"><div><h3>Despesas por categoria</h3><p>Valores de {monthBR(previousMonth)} e {monthBR(month)}.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>CATEGORIA</th><th>MÊS ANTERIOR</th><th>MÊS ATUAL</th><th>DIFERENÇA</th></tr></thead><tbody>
        {categories.map((item) => <tr key={item.name}><td><strong>{item.name}</strong></td><td>{amountText(item.previous, !showValues)}</td><td>{amountText(item.current, !showValues)}</td><td className={item.current > item.previous ? 'negative' : 'positive'}>{showValues ? (item.current - item.previous > 0 ? '+' : '') + money(item.current - item.previous) : '••••'}</td></tr>)}
      </tbody></table>{!categories.length && <div className="table-empty">Não há despesas por categoria para comparar.</div>}</div>
    </Panel>
    <div className="info-note"><GitCompareArrows size={17}/><span>O comparativo usa os registros que já estão visíveis em cada período. Lançamentos futuros só entram na comparação quando faltarem até um mês para sua data.</span></div>
  </>;
}

export function TransactionTemplatesPage({ data, revision, showValues, act }: ExtraProps) {
  const [templates, setTemplates] = useState<TransactionTemplate[]>([]);
  const [form, setForm] = useState({
    name: '', type: 'expense' as 'income' | 'expense', description: '', amount: '', categoryId: '',
    expenseClass: 'Essencial' as NonNullable<Transaction['expenseClass']>, paymentMode: 'pix' as 'pix' | 'cash' | 'card-debit' | 'other',
    accountId: data.accounts[0]?.id ?? '', notes: '',
  });
  useEffect(() => {
    let active = true;
    db.transactionTemplates.orderBy('name').toArray().then((items) => { if (active) setTemplates(items); });
    return () => { active = false; };
  }, [revision]);
  const save = () => act(() => saveTransactionTemplate({
    name: form.name.trim(), type: form.type, description: form.description.trim(), amountCents: toCents(form.amount),
    categoryId: form.categoryId || undefined, expenseClass: form.type === 'expense' ? form.expenseClass : undefined,
    paymentMode: form.paymentMode, accountId: form.paymentMode === 'other' ? undefined : form.accountId || undefined, notes: form.notes,
  }), 'Modelo de movimentação salvo.').then((ok) => {
    if (ok) setForm({ name: '', type: 'expense', description: '', amount: '', categoryId: '', expenseClass: 'Essencial', paymentMode: 'pix', accountId: data.accounts[0]?.id ?? '', notes: '' });
  });
  const launch = (template: TransactionTemplate) => act(() => saveTransaction({
    type: template.type, description: template.description, amountCents: template.amountCents, date: today(),
    categoryId: template.categoryId, expenseClass: template.type === 'expense' ? template.expenseClass : undefined,
    status: template.type === 'income' ? 'received' : 'paid', paymentMode: template.paymentMode,
    accountId: template.accountId, notes: template.notes,
  }), 'Movimentação criada a partir do modelo.');
  return <>
    <Heading eyebrow="ORGANIZAÇÃO" title="Modelos de movimentação" description="Guarde contas e receitas frequentes com suas informações e registre-as novamente com um toque."/>
    <Panel><div className="panel-header"><div><h3>Novo modelo</h3><p></p></div><Bookmark size={19}/></div>
      <div className="form-grid">
        {field('Nome do modelo', <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ex.: Conta de internet"/>)}
        {field('Tipo', <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as 'income' | 'expense' })}><option value="expense">Saída</option><option value="income">Entrada</option></select>)}
        {field('Descrição ao lançar', <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Ex.: Internet"/>, true)}
        {field('Valor (R$)', <MoneyField value={form.amount} onChange={(amount) => setForm({ ...form, amount })}/>)}
        {field('Categoria', <select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}><option value="">Sem categoria</option>{data.categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select>)}
        {form.type === 'expense' && field('Classificação', <select value={form.expenseClass} onChange={(event) => setForm({ ...form, expenseClass: event.target.value as NonNullable<Transaction['expenseClass']> })}><option value="Investimento">Investimento</option><option value="Essencial">Essencial</option><option value="Supérfluo">Supérfluo</option></select>)}
        {field('Forma de pagamento', <select value={form.paymentMode} onChange={(event) => setForm({ ...form, paymentMode: event.target.value as typeof form.paymentMode })}><option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="card-debit">Débito</option><option value="other">Outro</option></select>)}
        {form.paymentMode !== 'other' && field('Conta utilizada', <select value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">Selecione a conta</option>{data.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select>)}
        {field('Observações', <textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })}/>, true)}
        <div className="form-actions field-wide"><button className="btn btn-primary" onClick={save} disabled={!form.name.trim() || !form.description.trim() || toCents(form.amount || '0') <= 0 || (form.paymentMode !== 'other' && !form.accountId)}><Plus size={15}/> Salvar modelo</button></div>
      </div>
    </Panel>
    <Panel><div className="panel-header"><div><h3>Modelos salvos</h3><p>{templates.length} modelo(s) disponível(is) para reutilização.</p></div></div>
      <div className="template-list">{templates.map((template) => <div className="template-row" key={template.id}>
        <div className="template-main"><strong>{template.name}</strong><span>{template.description} · {template.type === 'income' ? 'Entrada' : 'Saída'} · {template.paymentMode === 'pix' ? 'Pix' : template.paymentMode === 'cash' ? 'Dinheiro' : template.paymentMode === 'card-debit' ? 'Débito' : 'Outro'}</span></div>
        <strong className={template.type === 'income' ? 'positive' : 'negative'}>{amountText(template.amountCents, !showValues)}</strong>
        <div className="template-actions"><button className="btn btn-secondary btn-small" onClick={() => { void launch(template); }}><Check size={14}/> Lançar hoje</button><button className="icon-button mini danger-icon" onClick={() => { void act(() => deleteTransactionTemplate(template.id), 'Modelo excluído.'); }} title="Excluir modelo"><Trash2 size={14}/></button></div>
      </div>)}</div>{!templates.length && <div className="table-empty">Nenhum modelo salvo. Cadastre uma conta frequente acima.</div>}
    </Panel>
    <div className="info-note"><Bookmark size={17}/><span>Ao usar um modelo, o NEXO cria uma nova movimentação com a data de hoje. O modelo original permanece salvo para o próximo uso.</span></div>
  </>;
}
