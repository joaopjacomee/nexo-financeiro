import { Fragment, useCallback, useEffect, useMemo, useState, type FocusEvent, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, CalendarDays,
  CalendarRange, Check, ChevronLeft, ChevronRight, CreditCard, Download, Eye, EyeOff, FileBarChart,
  FileText, FolderOpen, Gauge, Goal, HandCoins, Landmark, Layers3, LayoutDashboard, Menu, Plus,
  Search, Settings, ShieldCheck, Smartphone, Target, TrendingDown, TrendingUp, Wallet, X, Upload,
  PiggyBank, Receipt, CircleHelp, Trash2,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db, initializeDatabase } from './lib/db';
import { dateBR, firstUsageMonth, fromCents, makeId, money, monthBR, today, toCents } from './lib/format';
import {
  getAccountBalances, getCardMetrics, getCategorySpend, getDebtorMetrics, getInstallmentsForMonth,
  getMonthSummary, getPatrimony, getReserveBalances,
} from './lib/finance';
import {
  clearTestData, createCardPurchase, createDebtor, createTransfer, decryptBackup,
  deleteAccount, deleteCard, deleteCategory, deleteDebtor, deleteDebtorPayment, deleteInvoicePayment,
  deletePurchase, deleteReserve, deleteReserveMovement, deleteTransaction, deleteTransfer, encryptBackup, exportBackup, moveReserve,
  payInvoice, processReserveYields, receiveDebtorPayment, restoreBackup, saveAccount, saveCard, saveReserve, saveTransaction,
} from './lib/operations';
import type {
  Account,
  Card,
  Category,
  Debtor,
  DebtorPayment,
  Installment,
  InvoicePayment,
  PageKey,
  Purchase,
  Reserve,
  ReserveMovement,
  Transaction,
  Transfer,
} from './types';
const navGroups: { title: string; items: { key: PageKey; label: string; icon: typeof LayoutDashboard }[] }[] = [
  { title: 'VISÃO GERAL', items: [{ key: 'dashboard', label: 'Início', icon: LayoutDashboard }, { key: 'months', label: 'Meses', icon: CalendarRange }] },
  { title: 'MOVIMENTAÇÕES', items: [{ key: 'transactions', label: 'Movimentações', icon: ArrowLeftRight }, { key: 'categories', label: 'Categorias', icon: Layers3 }] },
  { title: 'CONTAS E CARTÕES', items: [{ key: 'accounts', label: 'Contas bancárias', icon: Landmark }, { key: 'cards', label: 'Cartões', icon: CreditCard }, { key: 'invoices', label: 'Faturas', icon: Receipt }, { key: 'installments', label: 'Parcelamentos', icon: CalendarDays }] },
  { title: 'ORGANIZAÇÃO', items: [{ key: 'debtors', label: 'Devedores', icon: HandCoins }, { key: 'reserves', label: 'Caixinhas', icon: Goal }] },
  { title: 'ANÁLISES', items: [{ key: 'reports', label: 'Relatórios', icon: FileBarChart }, { key: 'calendar', label: 'Calendário', icon: CalendarDays }, { key: 'forecast', label: 'Previsões', icon: Activity }, { key: 'patrimony', label: 'Patrimônio', icon: Wallet }] },
  { title: 'SISTEMA', items: [{ key: 'settings', label: 'Configurações', icon: Settings }] },
];
const pageTitles: Record<PageKey, string> = {
  dashboard: 'Visão geral', months: 'Organização mensal', transactions: 'Movimentações', categories: 'Categorias',
  accounts: 'Contas bancárias', cards: 'Cartões', invoices: 'Faturas', installments: 'Parcelamentos', debtors: 'Devedores',
  reserves: 'Minhas caixinhas', reports: 'Relatórios', calendar: 'Calendário financeiro',
  forecast: 'Previsão financeira', patrimony: 'Patrimônio', settings: 'Configurações',
};
const COLORS = ['#6d28d9', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe', '#7c3aed', '#5b21b6'];

interface Snapshot {
  categories: Category[]; accounts: Account[]; cards: Card[]; transactions: Transaction[]; purchases: Purchase[];
  debtors: Debtor[]; reserves: Reserve[]; months: { id: string; month: string }[];
}
const emptySnapshot: Snapshot = { categories: [], accounts: [], cards: [], transactions: [], purchases: [], debtors: [], reserves: [], months: [] };

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [month, setMonth] = useState(firstUsageMonth());
  const [showValues, setShowValues] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [ready, setReady] = useState(false);
  const [privacyNotice, setPrivacyNotice] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' } | null>(null);
  const [query, setQuery] = useState('');

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await initializeDatabase();
        await processReserveYields();
        const [categories, accounts, cards, transactions, purchases, debtors, reserves, months, setting] = await Promise.all([
          db.categories.orderBy('sortOrder').toArray(), db.accounts.toArray(), db.cards.toArray(), db.transactions.toArray(),
          db.purchases.toArray(), db.debtors.toArray(), db.reserves.toArray(), db.months.orderBy('month').reverse().toArray(),
          db.settings.get('privacyNoticeDismissed'),
        ]);
        if (active) {
          setSnapshot({ categories, accounts, cards, transactions, purchases, debtors, reserves, months });
          setPrivacyNotice(!setting?.value);
          setReady(true);
        }
      } catch (error) {
        console.error(error);
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, [revision]);

  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(timer); }, [toast]);
  const act = async (action: () => Promise<unknown>, successMessage = 'Alterações salvas.'): Promise<boolean> => {
    try { await action(); refresh(); setToast({ message: successMessage, kind: 'success' }); return true; }
    catch (error) { setToast({ message: error instanceof Error ? error.message : 'Não foi possível concluir a operação.', kind: 'error' }); return false; }
  };
  const navigate = (key: PageKey) => { setPage(key); setMobileNav(false); };
  const common = { data: snapshot, month, setMonth, showValues, revision, refresh, act, query };

  if (!ready) return <div className="loading-screen"><div className="brand-mark">N</div><strong>Preparando seu espaço financeiro</strong><span>Inicializando o armazenamento local…</span></div>;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><div className="brand-mark">N</div><div><strong>nexo</strong><span>FINANÇAS PESSOAIS</span></div><button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="Fechar menu"><X size={18}/></button></div>
        <div className="profile-card"><div className="profile-avatar">NP</div><div><strong>Meu espaço</strong><span>Dados neste dispositivo</span></div><ShieldCheck size={16} className="profile-shield"/></div>
        <nav className="side-nav">
          {navGroups.map((group) => <section key={group.title} className="nav-group"><div className="nav-group-title">{group.title}</div>{group.items.map((item) => {
            const Icon = item.icon;
            return <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => navigate(item.key)}><Icon size={17}/><span>{item.label}</span>{item.key === 'dashboard' && <i className="nav-dot"/>}</button>;
          })}</section>)}
        </nav>
        <div className="sidebar-footer"><div className="offline-pill"><span/> Armazenamento local ativo</div><div className="version-label">NEXO · VERSÃO 1.0.0</div></div>
      </aside>
      {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Fechar navegação"/>}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Abrir menu"><Menu size={20}/></button><div><div className="breadcrumb">ESPAÇO FINANCEIRO <ChevronRight size={12}/> <span>{pageTitles[page].toUpperCase()}</span></div><h1>{pageTitles[page]}</h1></div></div>
          <div className="topbar-actions"><div className="privacy-status"><span className="privacy-dot"/> Somente neste dispositivo</div><button className="icon-button" onClick={() => setShowValues((value) => !value)} title={showValues ? 'Ocultar valores' : 'Mostrar valores'}>{showValues ? <Eye size={18}/> : <EyeOff size={18}/>}</button><button className="icon-button" onClick={() => navigate('settings')} title="Configurações"><Settings size={18}/></button><div className="top-avatar">NP</div></div>
        </header>
        <div className="page-content">
          {page === 'dashboard' && <Dashboard {...common} navigate={navigate}/>}
          {page === 'months' && <MonthsPage {...common}/>}
          {page === 'transactions' && <TransactionsPage {...common}/>}
          {page === 'categories' && <CategoriesPage {...common}/>}
          {page === 'accounts' && <AccountsPage {...common}/>}
          {page === 'cards' && <CardsPage {...common}/>}
          {page === 'invoices' && <InvoicesPage {...common}/>}
          {page === 'installments' && <InstallmentsPage {...common}/>}
          {page === 'debtors' && <DebtorsPage {...common}/>}
          {page === 'reserves' && <ReservesPage {...common}/>}
          {page === 'reports' && <ReportsPage {...common}/>}
          {page === 'calendar' && <CalendarPage {...common}/>}
          {page === 'forecast' && <ForecastPage {...common}/>}
          {page === 'patrimony' && <PatrimonyPage {...common}/>}
          {page === 'settings' && <SettingsPage {...common}/>}
        </div>
        <footer className="app-footer"><span>© {new Date().getFullYear()} Nexo</span><span><ShieldCheck size={13}/> Seus dados financeiros não saem do navegador.</span></footer>
      </main>
      {toast && <div className={`action-toast ${toast.kind}`} role="status">{toast.kind === "success" ? <Check size={16}/> : <CircleHelp size={16}/>}<span>{toast.message}</span></div>}
      {privacyNotice && <div className="notice-banner"><div className="notice-icon"><ShieldCheck size={19}/></div><div><strong>Seus dados ficam no seu dispositivo</strong><p>O Nexo usa o armazenamento do navegador. Limpar os dados do site pode apagar suas informações. Faça backups periódicos em Configurações.</p></div><button className="btn btn-secondary btn-small" onClick={() => { void db.settings.put({ key: 'privacyNoticeDismissed', value: true }); setPrivacyNotice(false); }}>Entendi</button></div>}
    </div>
  );
}

type CommonProps = { data: Snapshot; month: string; setMonth: (v: string) => void; showValues: boolean; revision: number; refresh: () => void; act: (action: () => Promise<unknown>, success?: string) => Promise<boolean>; query: string };

function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}
function normalizedMoneyInput(value: string) {
  if (!value.trim()) return '';
  const cents = toCents(value);
  return Number.isSafeInteger(cents) ? fromCents(cents) : value;
}
function MoneyInput({ name, value, defaultValue, onChange, onBlur, required = false, placeholder = '0,00', className }: { name?: string; value?: string; defaultValue?: string; onChange?: (value: string) => void; onBlur?: (value: string) => void; required?: boolean; placeholder?: string; className?: string }) {
  const blur = (event: FocusEvent<HTMLInputElement>) => {
    const formatted = normalizedMoneyInput(event.currentTarget.value);
    event.currentTarget.value = formatted;
    onChange?.(formatted);
    onBlur?.(formatted);
  };
  return <input type="text" inputMode="decimal" name={name} value={value} defaultValue={defaultValue} onChange={onChange ? (event) => onChange(event.target.value) : undefined} onBlur={blur} required={required} placeholder={placeholder} className={className}/>;
}
function Button({ children, onClick, variant = 'primary', size = 'normal', type = 'button', disabled = false }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'normal' | 'small'; type?: 'button' | 'submit'; disabled?: boolean }) {
  return <button type={type} disabled={disabled} className={`btn btn-${variant} ${size === 'small' ? 'btn-small' : ''}`} onClick={onClick}>{children}</button>;
}
function Panel({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`panel ${className}`}>{children}</section>; }
function PanelHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) { return <div className="panel-header"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</div>; }
function StatCard({ label, value, sub, icon: Icon, tone = 'purple', hidden = false }: { label: string; value: string; sub?: string; icon: typeof Wallet; tone?: string; hidden?: boolean }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}><Icon size={19}/></div><div className="stat-info"><span>{label}</span><strong className="stat-value">{hidden ? '••••••' : value}</strong>{sub && <small>{sub}</small>}</div></div>;
}
function MoneyText({ cents, hidden, className = '' }: { cents: number; hidden: boolean; className?: string }) { return <span className={className}>{hidden ? '••••••' : money(cents)}</span>; }
function MonthSelector({ month, setMonth }: { month: string; setMonth: (v: string) => void }) { return <div className="month-selector"><button className="icon-button" onClick={() => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }} aria-label="Mês anterior"><ChevronLeft size={17}/></button><input type="month" value={month} onChange={(e) => setMonth(e.target.value)}/><button className="icon-button" onClick={() => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }} aria-label="Próximo mês"><ChevronRight size={17}/></button></div>; }
function Field({ label, children, wide = false, hint }: { label: string; children: ReactNode; wide?: boolean; hint?: string }) { return <label className={`form-field ${wide ? 'field-wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Modal({ title, children, onClose, width = 'medium' }: { title: string; children: ReactNode; onClose: () => void; width?: 'medium' | 'large' }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal modal-${width}`}><div className="modal-header"><div><div className="eyebrow">NEXO · CADASTRO</div><h3>{title}</h3></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={19}/></button></div><div className="modal-content">{children}</div></div></div>;
}
function EmptyState({ icon: Icon = FolderOpen, title, text, action }: { icon?: typeof FolderOpen; title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon"><Icon size={23}/></div><strong>{title}</strong><p>{text}</p>{action}</div>; }
function TableEmpty({ text }: { text: string }) { return <div className="table-empty">{text}</div>; }

function Dashboard({ data, month, setMonth, showValues, revision, navigate }: CommonProps & { navigate: (key: PageKey) => void }) {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof getMonthSummary>> | null>(null);
  const [recent, setRecent] = useState<Transaction[]>([]);
  useEffect(() => {
    let active = true;
    Promise.all([getMonthSummary(month), db.transactions.orderBy('date').reverse().limit(6).toArray()])
      .then(([monthSummary, transactions]) => { if (active) { setSummary(monthSummary); setRecent(transactions); } });
    return () => { active = false; };
  }, [month, revision]);
  const accountName = (id?: string) => data.accounts.find((account) => account.id === id)?.name ?? '—';
  const expenses = (summary?.cashExpensesCents ?? 0) + (summary?.installmentsCents ?? 0);
  return <>
    <div className="welcome-row"><div><div className="eyebrow">{monthBR(month).toUpperCase()}</div><h2>Seu dinheiro, <span>em ordem.</span></h2><p>Um resumo simples das suas movimentações.</p></div>
      <div className="welcome-actions"><MonthSelector month={month} setMonth={setMonth}/><Button onClick={() => navigate('transactions')}><Plus size={16}/> Nova movimentação</Button></div>
    </div>
    <div className="stat-grid stat-grid-three">
      <StatCard label="Receitas" value={money(summary?.incomeCents ?? 0)} icon={ArrowDownLeft} tone="green" hidden={!showValues}/>
      <StatCard label="Despesas e parcelas" value={money(expenses)} icon={ArrowUpRight} tone="pink" hidden={!showValues}/>
      <StatCard label="Saldo previsto do mês" value={money(summary?.freeCents ?? 0)} icon={Wallet} tone="lavender" hidden={!showValues}/>
    </div>
    <Panel className="dashboard-comparison-chart"><PanelHeader title="Receitas x saídas" subtitle={monthBR(month)}/><ResponsiveContainer width="100%" height={260}><BarChart data={[{ name: monthBR(month), receita: (summary?.incomeCents ?? 0) / 100, saida: expenses / 100 }]} margin={{ top: 12, right: 18, bottom: 4, left: 8 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0eafa"/><XAxis dataKey="name" tick={{ fontSize: 11, fill: '#8f879d' }} axisLine={false} tickLine={false}/><YAxis tickFormatter={(value) => money(Number(value) * 100)} tick={{ fontSize: 10, fill: '#8f879d' }} axisLine={false} tickLine={false}/><Tooltip formatter={(value) => money(Number(value) * 100)}/><Bar dataKey="receita" name="Receita" fill="#18a878" radius={[6, 6, 0, 0]}/><Bar dataKey="saida" name="Saída" fill="#df6686" radius={[6, 6, 0, 0]}/></BarChart></ResponsiveContainer></Panel>
    <div className="dashboard-grid">
      <Panel><PanelHeader title="Acesso rápido" subtitle="Abra a área que deseja organizar."/>
        <div className="quick-links">
          <Button variant="secondary" onClick={() => navigate('accounts')}><Landmark size={15}/> Contas bancárias</Button>
          <Button variant="secondary" onClick={() => navigate('cards')}><CreditCard size={15}/> Cartões</Button>
          <Button variant="secondary" onClick={() => navigate('reserves')}><PiggyBank size={15}/> Caixinhas</Button>
          <Button variant="secondary" onClick={() => navigate('debtors')}><HandCoins size={15}/> Devedores</Button>
        </div>
      </Panel>
      <Panel><PanelHeader title="Movimentações recentes" subtitle="Últimos seis registros" action={<button className="link-button" onClick={() => navigate('transactions')}>Ver todas <ArrowRight size={13}/></button>}/>
        {recent.length ? <div className="event-list">{recent.map((item) => <div className="event-row" key={item.id}>
          <div className="event-marker"/>
          <div className="event-main"><strong>{item.type === 'income' ? 'Receita' : item.description}</strong><span>{item.type === 'income' ? item.description : accountName(item.accountId)} · {dateBR(item.date)}</span></div>
          <strong className={item.type === 'income' ? 'positive' : 'negative'}>{showValues ? `${item.type === 'income' ? '+' : '−'}${money(item.amountCents)}` : '••••'}</strong>
        </div>)}</div> : <EmptyState title="Ainda não há movimentações" text="Quando você registrar uma receita ou despesa, ela aparecerá aqui." action={<Button onClick={() => navigate('transactions')}><Plus size={16}/> Registrar agora</Button>}/>}
      </Panel>
    </div>
  </>;
}

function MonthsPage({ data, month, setMonth, showValues, revision, refresh, act }: CommonProps) {
  const [budgetRows, setBudgetRows] = useState<Array<{ category: Category; budgetCents: number; spentCents: number }>>([]);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof getMonthSummary>> | null>(null);
  const [newMonth, setNewMonth] = useState(month);
  useEffect(() => {
    let active = true;
    Promise.all([getMonthSummary(month), getCategorySpend(month), db.monthlyBudgets.where('month').equals(month).toArray()]).then(([s, spend, budgets]) => {
      if (!active) return;
      setSummary(s);
      setBudgetRows(data.categories.map((category) => ({ category, spentCents: spend.find((item) => item.category.id === category.id)?.spentCents ?? 0, budgetCents: budgets.find((item) => item.categoryId === category.id)?.budgetCents ?? 0 })));
    });
    return () => { active = false; };
  }, [month, revision, data.categories]);
  const saveBudget = (categoryId: string, raw: string) => act(async () => {
    const budgetCents = toCents(raw || '0');
    if (!Number.isSafeInteger(budgetCents) || budgetCents < 0) throw new Error('Orçamento inválido.');
    const id = `${month}:${categoryId}`;
    await db.monthlyBudgets.put({ id, month, categoryId, budgetCents });
  });
  return <>
    <PageHeading eyebrow="MESES" title="Seu dinheiro, organizado por período" description="Cada mês tem seus próprios registros e orçamentos. Os dados anteriores são preservados." action={<div className="inline-actions"><MonthSelector month={month} setMonth={setMonth}/><Button onClick={() => act(async () => { const value = { id: newMonth, month: newMonth, createdAt: new Date().toISOString() }; await db.months.put(value); setMonth(newMonth); }, 'Mês criado com sucesso.')}><Plus size={16}/> Criar novo mês</Button></div>}/>
    <Panel className="month-create-panel"><div className="month-create-info"><div className="month-feature-icon"><CalendarRange size={22}/></div><div><strong>Criar ou acessar um mês</strong><span>Escolha qualquer mês, inclusive períodos futuros.</span></div></div><div className="month-create-controls"><input type="month" value={newMonth} onChange={(e) => setNewMonth(e.target.value)}/><Button variant="secondary" onClick={() => act(async () => { await db.months.put({ id: newMonth, month: newMonth, createdAt: new Date().toISOString() }); setMonth(newMonth); }, 'Mês disponível para consulta.')}>Abrir mês</Button></div></Panel>
    <div className="month-history-chips">{data.months.slice(0, 8).map((item) => <button className={item.month === month ? 'active' : ''} key={item.id} onClick={() => setMonth(item.month)}>{monthBR(item.month)}</button>)}</div>
    <div className="month-summary-head"><div><div className="eyebrow">PERÍODO SELECIONADO</div><h2>{monthBR(month)}</h2></div><MonthSelector month={month} setMonth={setMonth}/></div>
    <div className="stat-grid stat-grid-four"><StatCard label="Receitas previstas" value={money(summary?.incomeCents ?? 0)} icon={ArrowDownLeft} tone="green" hidden={!showValues}/><StatCard label="Despesas à vista" value={money(summary?.cashExpensesCents ?? 0)} icon={ArrowUpRight} tone="pink" hidden={!showValues}/><StatCard label="Parcelas do cartão" value={money(summary?.installmentsCents ?? 0)} icon={CreditCard} tone="lavender" hidden={!showValues}/><StatCard label="Saldo livre planejado" value={money(summary?.freeCents ?? 0)} icon={Wallet} hidden={!showValues}/></div>
    <Panel><PanelHeader title="Orçamento por categoria" subtitle="Defina um limite de gastos diferente para cada categoria neste mês." action={<span className="subtle-tag">19 CATEGORIAS PADRÃO</span>}/><div className="table-scroll"><table><thead><tr><th>CATEGORIA</th><th>ORÇAMENTO (R$)</th><th>GASTO (R$)</th><th>RESTANTE</th><th>UTILIZAÇÃO</th><th></th></tr></thead><tbody>{budgetRows.map((item) => <tr key={item.category.id}><td><span className="category-cell"><i style={{ background: item.category.color }}/>{item.category.name}</span></td><td><MoneyInput className="table-input" defaultValue={fromCents(item.budgetCents)} key={`${month}-${item.category.id}-${item.budgetCents}`} onBlur={(value) => saveBudget(item.category.id, value)}/></td><td>{showValues ? money(item.spentCents) : '••••'}</td><td className={item.budgetCents - item.spentCents < 0 ? 'negative' : 'positive'}>{showValues ? money(item.budgetCents - item.spentCents) : '••••'}</td><td><div className="budget-progress"><div className="progress-track"><i style={{ width: `${item.budgetCents ? Math.min(100, item.spentCents / item.budgetCents * 100) : 0}%` }}/></div><small>{item.budgetCents ? `${Math.round(item.spentCents / item.budgetCents * 100)}%` : '—'}</small></div></td><td><button className="icon-button mini" onClick={() => saveBudget(item.category.id, String(item.budgetCents / 100))} title="Salvar orçamento"><Check size={15}/></button></td></tr>)}</tbody></table></div></Panel>
    <div className="info-note"><CircleHelp size={17}/><span>O saldo livre planejado considera receitas e despesas registradas, parcelas com vencimento neste mês e aportes líquidos às caixinhas. Pagamentos de fatura afetam a conta bancária real, mas não criam uma nova despesa.</span></div>
  </>;
}

function TransactionsPage({ data, month, setMonth, showValues, revision, refresh, act, query }: CommonProps) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [modal, setModal] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Transaction | null>(null);
  useEffect(() => { db.transactions.where('month').equals(month).reverse().sortBy('date').then(setItems); }, [month, revision]);
  const filtered = items.filter((item) => (typeFilter === 'all' || item.type === typeFilter) && (categoryFilter === 'all' || item.categoryId === categoryFilter) && (statusFilter === 'all' || (item.type === 'expense' && item.expenseClass === statusFilter)) && `${item.description} ${item.notes ?? ''}`.toLowerCase().includes((search || query).toLowerCase()));
  const submit = async (payload: FormData) => {
    const raw = String(payload.get('amount') ?? '');
    const type = String(payload.get('type')) as 'income' | 'expense';
    const paymentMode = String(payload.get('paymentMode')) as Transaction['paymentMode'];
    const categoryId = String(payload.get('categoryId') || '') || undefined;
    const notes = String(payload.get('notes') || '');
    const expenseClass = String(payload.get('status') || 'Essencial') as Transaction['expenseClass'];
    if (editing?.paymentMode === 'card-credit') { setToast({ message: 'Para alterar uma compra parcelada, exclua o parcelamento atual e registre a compra novamente.', kind: 'error' }); return; }
    const ok = await act(() => paymentMode === 'card-credit'
      ? createCardPurchase({ description: String(payload.get('description') ?? ''), totalCents: toCents(raw), cardId: String(payload.get('cardId') || ''), installmentsCount: Number(payload.get('installmentsCount') || 1), purchaseDate: String(payload.get('date')), firstDueMonth: String(payload.get('firstDueMonth') || addMonths(String(payload.get('date')).slice(0, 7), 1)), categoryId, expenseClass, notes })
      : saveTransaction({ id: editing?.id, type, description: String(payload.get('description') ?? ''), amountCents: toCents(raw), date: String(payload.get('date')), categoryId, expenseClass: type === 'expense' ? expenseClass : undefined, status: type === 'income' ? 'received' : 'paid', paymentMode, accountId: String(payload.get('accountId') || '') || undefined, notes }),
      editing ? 'Movimentação atualizada.' : paymentMode === 'card-credit' ? 'Compra e parcelas registradas.' : 'Movimentação registrada.');
    if (ok) { setModal(false); setEditing(null); }
  };
  const accountName = (id?: string) => data.accounts.find((acc) => acc.id === id)?.name ?? '—';
  return <>
    <PageHeading eyebrow="LANÇAMENTOS" title="Entradas e saídas em um só lugar" description="Registre, pesquise e acompanhe suas movimentações financeiras." action={<div className="inline-actions"><MonthSelector month={month} setMonth={setMonth}/><Button onClick={() => { setEditing(null); setModal(true); }}><Plus size={16}/> Nova movimentação</Button></div>}/>
    <Panel><div className="filter-toolbar"><div className="search-box"><Search size={16}/><input placeholder="Buscar descrição..." value={search} onChange={(e) => setSearch(e.target.value)}/></div><div className="filter-selects"><select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="all">Todos os tipos</option><option value="income">Receitas</option><option value="expense">Despesas</option></select><select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option value="all">Todas as categorias</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">Todos os status</option><option value="Investimento">Investimento</option><option value="Essencial">Essencial</option><option value="Supérfluo">Supérfluo</option></select></div></div><div className="table-scroll"><table><thead><tr><th>DESCRIÇÃO</th><th>CATEGORIA</th><th>CONTA / MEIO</th><th>DATA</th><th>STATUS</th><th>VALOR</th><th>AÇÕES</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><div className="table-title"><span className={`tx-type-icon ${item.type}`}>{item.type === 'income' ? <ArrowDownLeft size={14}/> : <ArrowUpRight size={14}/>}</span><div><strong>{item.description}</strong>{item.notes && <small>{item.notes}</small>}</div></div></td><td>{data.categories.find((cat) => cat.id === item.categoryId)?.name ?? '—'}</td><td>{accountName(item.accountId)} <small className="subline">{item.paymentMode === 'pix' ? 'Pix' : item.paymentMode === 'cash' ? 'Dinheiro' : item.paymentMode === 'card-debit' ? 'Cartão débito' : item.paymentMode === 'card-credit' ? 'Cartão de crédito' : 'Outro'}</small></td><td>{dateBR(item.date)}</td><td>{item.type === 'income' ? <span className="status-pill status-received">Receita</span> : <span className="status-pill">{item.expenseClass ?? 'Essencial'}</span>}</td><td className={item.type === 'income' ? 'positive' : 'negative'}>{showValues ? money(item.amountCents) : '••••'}</td><td><div className="row-actions"><button className="icon-button mini" title="Editar" onClick={() => { setEditing(item); setModal(true); }}><Settings size={14}/></button><button className="icon-button mini danger-icon" title="Excluir" onClick={() => { void act(() => deleteTransaction(item.id)); }}><Trash2 size={14}/></button></div></td></tr>)}</tbody></table>{!filtered.length && <TableEmpty text="Nenhuma movimentação encontrada para os filtros selecionados."/>}</div></Panel>
    {modal && <TransactionModal data={data} editing={editing} onClose={() => { setModal(false); setEditing(null); }} onSubmit={submit}/>}
  </>;
}
function StatusPill({ status }: { status: Transaction['status'] }) {
  const map: Record<Transaction['status'], string> = { paid: 'Pago', pending: 'Pendente', received: 'Recebido', receivable: 'A receber', cancelled: 'Cancelado' };
  return <span className={`status-pill status-${status}`}>{map[status]}</span>;
}
function TransactionModal({ data, editing, onClose, onSubmit }: { data: Snapshot; editing: Transaction | null; onClose: () => void; onSubmit: (form: FormData) => Promise<void> }) {
  const initialDate = editing?.date ?? today();
  const [type, setType] = useState<'income' | 'expense'>(editing?.type ?? 'expense');
  const [mode, setMode] = useState<Transaction['paymentMode']>(editing?.paymentMode ?? 'pix');
  const [status, setStatus] = useState<NonNullable<Transaction['expenseClass']>>(editing?.expenseClass ?? 'Essencial');
  const [purchaseDate, setPurchaseDate] = useState(initialDate);
  const [firstDueMonth, setFirstDueMonth] = useState(addMonths(initialDate.slice(0, 7), 1));
  const [saving, setSaving] = useState(false);
  const onFormSubmit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setSaving(true); try { await onSubmit(new FormData(e.currentTarget)); } finally { setSaving(false); } };
  return <Modal title={editing ? 'Editar movimentação' : 'Nova movimentação'} onClose={onClose}><form className="form-grid" onSubmit={onFormSubmit}>
    <Field label="Tipo"><select name="type" value={type} onChange={(e) => { const next = e.target.value as 'income' | 'expense'; setType(next); if (next === 'income' && mode === 'card-credit') setMode('pix'); }}><option value="expense">Despesa</option><option value="income">Receita</option></select></Field>
    <Field label="Descrição" wide><input name="description" required defaultValue={editing?.description}/></Field>
    <Field label="Valor (R$)"><MoneyInput name="amount" required defaultValue={editing ? fromCents(editing.amountCents) : ''}/></Field>
    <Field label={mode === 'card-credit' ? 'Data da compra' : 'Data'}><input name="date" type="date" required value={purchaseDate} onChange={(e) => { setPurchaseDate(e.target.value); setFirstDueMonth(addMonths(e.target.value.slice(0, 7), 1)); }}/></Field>
    <Field label="Categoria"><select name="categoryId" defaultValue={editing?.categoryId ?? ''}><option value="">Sem categoria</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
    {type === 'expense' && <Field label="Status"><select name="status" defaultValue={editing?.expenseClass ?? 'Essencial'}><option value="Investimento">Investimento</option><option value="Essencial">Essencial</option><option value="Supérfluo">Supérfluo</option></select></Field>}
    <Field label="Forma de pagamento"><select name="paymentMode" value={mode} onChange={(e) => setMode(e.target.value as Transaction['paymentMode'])}><option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="card-debit">Cartão débito</option>{type === 'expense' && <option value="card-credit">Cartão de crédito</option>}<option value="other">Outro</option></select></Field>
    {mode === 'card-credit' && type === 'expense' && <>
      <Field label="Cartão de crédito"><select name="cardId" required defaultValue={data.cards[0]?.id ?? ''}><option value="">Selecione o cartão</option>{data.cards.map((card) => <option key={card.id} value={card.id}>{card.name} · {card.institution}</option>)}</select></Field>
      <Field label="Quantidade de parcelas"><input name="installmentsCount" type="number" min="1" max="240" defaultValue="1" required/></Field>
      <Field label="Mês da primeira fatura"><input name="firstDueMonth" type="month" value={firstDueMonth} onChange={(e) => setFirstDueMonth(e.target.value)} required/></Field>
      <div className="form-footnote"><CreditCard size={15}/> A compra fica registrada na data informada. A primeira fatura começa automaticamente no mês seguinte; ajuste-a caso o cartão ainda feche no mês da compra. As parcelas vencem no dia de vencimento cadastrado do cartão.</div>
    </>}
    {mode !== 'other' && mode !== 'card-credit' && <Field label={mode === 'cash' ? 'Carteira de dinheiro' : 'Conta utilizada'}><select name="accountId" required defaultValue={editing?.accountId ?? (mode === 'cash' ? data.accounts.find((a) => a.type === 'cash')?.id : '')}><option value="">Selecione a conta</option>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>}
    <Field label="Observações" wide><textarea name="notes" rows={2} defaultValue={editing?.notes}/></Field>
    {mode !== 'card-credit' && <div className="form-footnote"><ShieldCheck size={15}/> Para compras no crédito, selecione essa forma de pagamento para registrar cartão, quantidade de parcelas e primeira fatura.</div>}
    <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving || (mode === 'card-credit' && !data.cards.length)}>{saving ? 'Salvando…' : editing ? 'Salvar alterações' : 'Salvar movimentação'}</Button></div>
  </form></Modal>;
}
function CategoriesPage({ data, act }: CommonProps) {
  const [name, setName] = useState(''); const [color, setColor] = useState('#8b5cf6'); const [editing, setEditing] = useState<Category | null>(null);
  const clearForm = () => { setEditing(null); setName(''); setColor('#8b5cf6'); };
  const save = () => act(async () => { if (!name.trim()) throw new Error('Informe o nome da categoria.'); await db.categories.put({ id: editing?.id ?? makeId(), name: name.trim(), color, icon: editing?.icon ?? 'circle', sortOrder: editing?.sortOrder ?? data.categories.length }); clearForm(); }, 'Categoria salva.');
  const remove = (category: Category) => act(() => deleteCategory(category.id), 'Categoria removida. Os lançamentos relacionados foram mantidos sem categoria.');
  return <><PageHeading eyebrow="PERSONALIZAÇÃO" title="Categorias financeiras" description="Personalize nomes e cores ou crie novas opções."/><div className="two-column-layout"><Panel><PanelHeader title={editing ? 'Editar categoria' : 'Nova categoria'} subtitle="Use nomes claros para facilitar seus relatórios."/><div className="category-form"><Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Cursos"/></Field><Field label="Cor de identificação"><input type="color" value={color} onChange={(e) => setColor(e.target.value)}/></Field><div className="form-actions"><Button variant="secondary" onClick={clearForm}>Limpar</Button><Button onClick={save}><Plus size={15}/> {editing ? 'Salvar' : 'Adicionar categoria'}</Button></div></div></Panel><Panel><PanelHeader title={`${data.categories.length} categorias`} subtitle="Ao excluir, os lançamentos vinculados continuam salvos sem categoria."/><div className="category-management-list">{data.categories.map((category) => <div className="category-manage-row" key={category.id}><span className="category-dot" style={{ background: category.color }}/><strong>{category.name}</strong><div className="row-actions"><button className="icon-button mini" onClick={() => { setEditing(category); setName(category.name); setColor(category.color); }} title="Editar"><Settings size={14}/></button><button className="icon-button mini danger-icon" onClick={() => { void remove(category); }} title="Excluir"><Trash2 size={14}/></button></div></div>)}</div></Panel></div></>;
}
function AccountsPage({ data, showValues, act, revision }: CommonProps) {
  const [balances, setBalances] = useState<Awaited<ReturnType<typeof getAccountBalances>>>([]);
  const [modal, setModal] = useState<'account' | 'transfer' | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  useEffect(() => { getAccountBalances().then(setBalances); }, [revision]);
  const [transfer, setTransfer] = useState({ fromAccountId: '', toAccountId: '', amount: '', date: today(), description: 'Transferência entre contas' });
  const saveTransfer = () => act(() => createTransfer({ ...transfer, amountCents: toCents(transfer.amount) }), 'Transferência registrada sem alterar receitas, despesas ou patrimônio.').then((ok) => { if (ok) setModal(null); });
  return <><PageHeading eyebrow="SALDOS REAIS" title="Contas bancárias" description="Acompanhe o dinheiro efetivamente disponível em cada instituição." action={<div className="inline-actions"><Button variant="secondary" onClick={() => setModal('transfer')}><ArrowLeftRight size={16}/> Transferir</Button><Button onClick={() => setModal('account')}><Plus size={16}/> Nova conta</Button></div>}/><div className="account-cards-grid">{balances.map(({ account, balanceCents }) => <div className="bank-account-card" key={account.id}><div className="bank-card-top"><BankLogo institution={account.institution} large/><span className="subtle-tag">{account.type === 'cash' ? 'DINHEIRO' : account.type.toUpperCase()}</span></div><strong>{account.name}</strong><small>{account.institution}</small><div className="bank-balance"><span>Saldo atual</span><b>{showValues ? money(balanceCents) : '••••••'}</b></div><div className="bank-initial">Saldo inicial: {showValues ? money(account.initialBalanceCents) : '••••'}</div><div className="bank-account-actions"><Button size="small" variant="secondary" onClick={() => { setEditingAccount(account); setModal('account'); }}>Editar</Button><Button size="small" variant="danger" onClick={() => { void act(() => deleteAccount(account.id), 'Conta e registros vinculados removidos.'); }}><Trash2 size={14}/> Excluir</Button></div></div>)}</div><Panel><PanelHeader title="Histórico de transferências" subtitle="Transferências próprias não são consideradas receitas nem despesas."/><TransferHistory revision={revision} accounts={data.accounts} showValues={showValues} act={act}/></Panel>{modal === 'account' && <AccountModal editing={editingAccount} onClose={() => { setModal(null); setEditingAccount(null); }} act={act}/ >}{modal === 'transfer' && <Modal title="Transferir entre contas" onClose={() => setModal(null)}><div className="form-grid"><Field label="Conta de origem"><select value={transfer.fromAccountId} onChange={(e) => setTransfer({ ...transfer, fromAccountId: e.target.value })}><option value="">Selecione</option>{data.accounts.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</select></Field><Field label="Conta de destino"><select value={transfer.toAccountId} onChange={(e) => setTransfer({ ...transfer, toAccountId: e.target.value })}><option value="">Selecione</option>{data.accounts.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</select></Field><Field label="Valor (R$)"><MoneyInput value={transfer.amount} onChange={(amount) => setTransfer({ ...transfer, amount })}/></Field><Field label="Data"><input type="date" value={transfer.date} onChange={(e) => setTransfer({ ...transfer, date: e.target.value })}/></Field><Field label="Descrição" wide><input value={transfer.description} onChange={(e) => setTransfer({ ...transfer, description: e.target.value })}/></Field><div className="form-footnote"><ArrowLeftRight size={15}/> O valor sai de uma conta e entra na outra sem criar receita ou despesa.</div><div className="form-actions"><Button variant="secondary" onClick={() => setModal(null)}>Cancelar</Button><Button onClick={saveTransfer}>Confirmar transferência</Button></div></div></Modal>}</>;
}
function TransferHistory({ revision, accounts, showValues, act }: { revision: number; accounts: Account[]; showValues: boolean; act: CommonProps['act'] }) {
  const [items, setItems] = useState<Transfer[]>([]);
  useEffect(() => { db.transfers.orderBy('date').reverse().toArray().then(setItems); }, [revision]);
  return items.length ? <div className="table-scroll"><table><thead><tr><th>ORIGEM</th><th>DESTINO</th><th>DATA</th><th>VALOR</th><th></th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{accounts.find((a) => a.id === item.fromAccountId)?.name ?? '—'}</td><td>{accounts.find((a) => a.id === item.toAccountId)?.name ?? '—'}</td><td>{dateBR(item.date)}</td><td>{showValues ? money(item.amountCents) : '••••'}</td><td><button className="icon-button mini danger-icon" title="Excluir transferência" onClick={() => { void act(() => deleteTransfer(item.id), 'Transferência excluída.'); }}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div> : <TableEmpty text="Nenhuma transferência registrada."/>;
}
function BankLogo({ institution, large = false }: { institution: string; large?: boolean }) {
  const normalized = institution.toLowerCase().replace(/[^a-z]/g, '');
  const logos: Record<string, string> = { mercadopago: 'mercadopago', bradesco: 'bradesco', inter: 'inter', nubank: 'nubank', nu: 'nubank' };
  const slug = logos[normalized];
  return <div className={`bank-icon ${large ? 'large' : ''} bank-brand-icon`}>
    {slug ? <img src={`${import.meta.env.BASE_URL}banks/${slug}.svg`} alt={institution} loading="lazy"/> : <Landmark size={large ? 19 : 17}/>}
  </div>;
}
function AccountModal({ editing, onClose, act }: { editing: Account | null; onClose: () => void; act: CommonProps['act'] }) {
  const [name, setName] = useState(editing?.name ?? ''); const [institution, setInstitution] = useState(editing?.institution ?? ''); const [type, setType] = useState<Account['type']>(editing?.type ?? 'checking'); const [balance, setBalance] = useState(fromCents(editing?.initialBalanceCents ?? 0));
  const submit = () => act(() => saveAccount({ id: editing?.id, name, institution: institution || name, type, initialBalanceCents: toCents(balance) }), editing ? 'Conta atualizada.' : 'Conta cadastrada.').then((ok) => { if (ok) onClose(); });
  return <Modal title={editing ? 'Editar conta' : 'Cadastrar conta'} onClose={onClose}><div className="form-grid"><Field label="Nome da conta"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Inter principal"/></Field><Field label="Instituição"><input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Ex.: Inter"/></Field><Field label="Tipo"><select value={type} onChange={(e) => setType(e.target.value as Account['type'])}><option value="checking">Conta corrente</option><option value="savings">Poupança</option><option value="payment">Conta de pagamento</option><option value="cash">Dinheiro</option><option value="other">Outro</option></select></Field><Field label="Saldo inicial (R$)"><MoneyInput value={balance} onChange={setBalance}/></Field><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit}>Salvar conta</Button></div></div></Modal>;
}

function CardsPage({ data, showValues, act, revision }: CommonProps) {
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof getCardMetrics>>>([]);
  const [modal, setModal] = useState<'card' | 'purchase' | null>(null);
  const [editingCard, setEditingCard] = useState<Card | null>(null);
  useEffect(() => { getCardMetrics().then(setMetrics); }, [revision]);
  return <><PageHeading eyebrow="CRÉDITO" title="Seus cartões" description="Limites, utilização e compras de crédito centralizados em um só lugar." action={<div className="inline-actions"><Button variant="secondary" onClick={() => setModal('purchase')}><Plus size={16}/> Nova compra</Button><Button onClick={() => { setEditingCard(null); setModal('card'); }}><CreditCard size={16}/> Adicionar cartão</Button></div>}/><div className="cards-overview-grid">{metrics.map(({ card, usedCents, availableCents, nextInvoiceCents }) => <div className="credit-card-visual" style={{ background: `linear-gradient(125deg, ${card.color}, #3b176c)` }} key={card.id}><div className="credit-card-line"><span>NEXO</span><span>••••</span></div><div className="credit-chip"><span/></div><div className="credit-name"><small>{card.institution}</small><strong>{card.name}</strong></div><div className="credit-card-footer"><div><small>DISPONÍVEL</small><strong>{showValues ? money(availableCents) : '••••••'}</strong></div><div><small>FATURA DO MÊS</small><strong>{showValues ? money(nextInvoiceCents) : '••••'}</strong></div></div><div className="card-limit-line"><div style={{ width: `${card.limitCents ? Math.min(100, usedCents / card.limitCents * 100) : 0}%` }}/></div><div className="credit-details"><span>Limite total {showValues ? money(card.limitCents) : '••••'}</span><span>Utilizado {showValues ? money(usedCents) : '••••'}</span></div></div>)}</div><Panel><PanelHeader title="Cartões cadastrados" subtitle="O limite utilizado considera parcelas ainda não liberadas pelo pagamento da fatura."/><div className="table-scroll"><table><thead><tr><th>CARTÃO</th><th>INSTITUIÇÃO</th><th>TIPO</th><th>FECHAMENTO</th><th>VENCIMENTO</th><th>LIMITE</th><th>DISPONÍVEL</th><th></th></tr></thead><tbody>{metrics.map(({ card, usedCents, availableCents }) => <tr key={card.id}><td><strong>{card.name}</strong></td><td>{card.institution}</td><td><span className="status-pill status-received">Crédito</span></td><td>Dia {card.closingDay}</td><td>Dia {card.dueDay}</td><td>{showValues ? money(card.limitCents) : '••••'}</td><td className="positive">{showValues ? money(availableCents) : '••••'}</td><td><div className="row-actions"><Button size="small" variant="secondary" onClick={() => { setEditingCard(card); setModal('card'); }}>Editar</Button><button className="icon-button mini danger-icon" title="Excluir cartão e compras vinculadas" onClick={() => { void act(() => deleteCard(card.id), 'Cartão e compras vinculadas removidos.'); }}><Trash2 size={14}/></button></div></td></tr>)}</tbody></table>{!metrics.length && <TableEmpty text="Cadastre seu primeiro cartão para acompanhar o limite."/>}</div></Panel>{modal === 'card' && <CardModal data={data} editing={editingCard} onClose={() => { setModal(null); setEditingCard(null); }} act={act}/ >}{modal === 'purchase' && <PurchaseModal data={data} onClose={() => setModal(null)} act={act}/>}</>;
}
function CardModal({ data, editing, onClose, act }: { data: Snapshot; editing: Card | null; onClose: () => void; act: CommonProps['act'] }) {
  const [form, setForm] = useState({ name: editing?.name ?? '', institution: editing?.institution ?? data.accounts.find((a) => a.type !== 'cash' && a.institution !== 'Dinheiro')?.institution ?? 'Inter', brand: editing?.brand ?? 'Visa', limit: fromCents(editing?.limitCents ?? 0), closingDay: String(editing?.closingDay ?? 1), dueDay: String(editing?.dueDay ?? 10), color: editing?.color ?? '#6d28d9' });
  const submit = () => act(() => saveCard({ id: editing?.id, name: form.name, institution: form.institution, brand: form.brand, kind: 'credit', limitCents: toCents(form.limit), closingDay: Number(form.closingDay), dueDay: Number(form.dueDay), color: form.color }), editing ? 'Cartão atualizado.' : 'Cartão cadastrado.').then((ok) => { if (ok) onClose(); });
  return <Modal title={editing ? 'Editar cartão' : 'Adicionar cartão'} onClose={onClose}><div className="form-grid"><Field label="Nome do cartão"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Cartão Inter"/></Field><Field label="Instituição"><select value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })}>{data.accounts.filter((a) => a.type !== 'cash' && a.institution !== 'Dinheiro').map((a) => <option key={a.id} value={a.institution}>{a.institution}</option>)}{!data.accounts.some((a) => a.type !== 'cash' && a.institution !== 'Dinheiro') && <option>Outra</option>}</select></Field><Field label="Tipo do cartão"><select value="credit" disabled><option value="credit">Crédito</option></select></Field><Field label="Bandeira"><select value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })}><option>Visa</option><option>Mastercard</option><option>Elo</option><option>American Express</option><option>Não informada</option></select></Field><Field label="Limite total (R$)"><MoneyInput value={form.limit} onChange={(limit) => setForm({ ...form, limit })}/></Field><Field label="Dia de fechamento"><input type="number" min="1" max="31" value={form.closingDay} onChange={(e) => setForm({ ...form, closingDay: e.target.value })}/></Field><Field label="Dia de vencimento"><input type="number" min="1" max="31" value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })}/></Field><Field label="Cor de identificação"><input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}/></Field><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit}>Salvar cartão</Button></div></div></Modal>;
}
function suggestFirstInvoiceMonth(purchaseDate: string, card?: Card) {
  const purchasedMonth = purchaseDate.slice(0, 7);
  const purchaseDay = Number(purchaseDate.slice(8, 10));
  return card && purchaseDay > card.closingDay ? addMonths(purchasedMonth, 1) : purchasedMonth;
}
function PurchaseModal({ data, onClose, act }: { data: Snapshot; onClose: () => void; act: CommonProps['act'] }) {
  const [form, setForm] = useState({ description: '', total: '', cardId: data.cards[0]?.id ?? '', categoryId: '', expenseClass: 'Essencial' as NonNullable<Transaction['expenseClass']>, purchaseDate: today(), firstDueMonth: suggestFirstInvoiceMonth(today(), data.cards[0]), installmentsCount: '1', notes: '' });
  const submit = () => act(() => createCardPurchase({ ...form, totalCents: toCents(form.total), installmentsCount: Number(form.installmentsCount), categoryId: form.categoryId || undefined }), 'Compra e parcelas registradas.').then((ok) => { if (ok) onClose(); });
  return <Modal title="Registrar compra no crédito" onClose={onClose}><div className="form-grid"><Field label="Descrição" wide><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}/></Field><Field label="Valor total (R$)"><MoneyInput value={form.total} onChange={(total) => setForm({ ...form, total })}/></Field><Field label="Cartão"><select value={form.cardId} onChange={(e) => { const cardId = e.target.value; setForm({ ...form, cardId, firstDueMonth: suggestFirstInvoiceMonth(form.purchaseDate, data.cards.find((card) => card.id === cardId)) }); }}>{data.cards.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.institution}</option>)}</select></Field><Field label="Quantidade de parcelas"><input type="number" min="1" max="240" value={form.installmentsCount} onChange={(e) => setForm({ ...form, installmentsCount: e.target.value })}/></Field><Field label="Data da compra"><input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value, firstDueMonth: suggestFirstInvoiceMonth(e.target.value, data.cards.find((card) => card.id === form.cardId)) })}/></Field><Field label="Mês da primeira fatura"><input type="month" value={form.firstDueMonth} onChange={(e) => setForm({ ...form, firstDueMonth: e.target.value })}/></Field><Field label="Categoria"><select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}><option value="">Sem categoria</option>{data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Classificação"><select value={form.expenseClass} onChange={(e) => setForm({ ...form, expenseClass: e.target.value as NonNullable<Transaction['expenseClass']> })}><option value="Investimento">Investimento</option><option value="Essencial">Essencial</option><option value="Supérfluo">Supérfluo</option></select></Field><Field label="Observações" wide><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></Field><div className="form-footnote"><CreditCard size={15}/> A primeira fatura é sugerida pelo fechamento do cartão. Se a compra ocorreu após o fechamento, a primeira parcela vai para o mês seguinte; você ainda pode ajustar o mês manualmente.</div><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit} disabled={!data.cards.length}>Criar parcelamento</Button></div></div></Modal>;
}
function InvoicesPage({ data, month, setMonth, showValues, act, revision }: CommonProps) {
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [installments, setInstallments] = useState<Awaited<ReturnType<typeof getInstallmentsForMonth>>>([]);
  const [modal, setModal] = useState(false);
  useEffect(() => { Promise.all([db.invoicePayments.where('month').equals(month).toArray(), getInstallmentsForMonth(month)]).then(([p, i]) => { setPayments(p); setInstallments(i); }); }, [month, revision]);
  const grouped = data.cards.map((card) => { const rows = installments.filter((item) => item.cardId === card.id); return { card, total: rows.reduce((sum, item) => sum + item.amountCents, 0), paid: rows.reduce((sum, item) => sum + item.paidCents, 0) }; });
  return <><PageHeading eyebrow="FATURAS" title="Acompanhe e pague suas faturas" description="Pagar uma fatura debita uma conta e libera o limite, sem criar uma segunda despesa." action={<div className="inline-actions"><MonthSelector month={month} setMonth={setMonth}/><Button onClick={() => setModal(true)}><Plus size={16}/> Registrar pagamento</Button></div>}/><div className="invoice-cards">{grouped.map(({ card, total, paid }) => <Panel key={card.id} className="invoice-card"><div className="invoice-card-head"><div className="bank-icon"><CreditCard size={17}/></div><div><strong>{card.name}</strong><small>{card.institution}</small></div></div><div className="invoice-total"><span>Fatura do período</span><strong>{showValues ? money(total) : '••••••'}</strong></div><div className="progress-track"><i style={{ width: `${total ? Math.min(100, paid / total * 100) : 0}%` }}/></div><div className="invoice-foot"><span>Alocado como pago</span><strong>{showValues ? money(paid) : '••••'}</strong></div><div className="invoice-foot"><span>Em aberto</span><strong>{showValues ? money(Math.max(0, total - paid)) : '••••'}</strong></div></Panel>)}</div><Panel><PanelHeader title="Pagamentos registrados" subtitle="Histórico de pagamentos da fatura selecionada."/><div className="table-scroll"><table><thead><tr><th>CARTÃO</th><th>CONTA DE PAGAMENTO</th><th>DATA</th><th>VALOR PAGO</th><th></th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id}><td>{data.cards.find((c) => c.id === payment.cardId)?.name ?? '—'}</td><td>{data.accounts.find((a) => a.id === payment.accountId)?.name ?? '—'}</td><td>{dateBR(payment.date)}</td><td className="negative">{showValues ? money(payment.amountCents) : '••••'}</td><td><button className="icon-button mini danger-icon" title="Excluir pagamento e reabrir parcelas" onClick={() => { void act(() => deleteInvoicePayment(payment.id), 'Pagamento removido e parcelas reabertas.'); }}><Trash2 size={14}/></button></td></tr>)}</tbody></table>{!payments.length && <TableEmpty text="Nenhum pagamento registrado neste mês."/>}</div></Panel>{modal && <InvoicePaymentModal data={data} month={month} onClose={() => setModal(false)} act={act}/>}</>;
}
function InvoicePaymentModal({ data, month, onClose, act }: { data: Snapshot; month: string; onClose: () => void; act: CommonProps['act'] }) {
  const [form, setForm] = useState({ cardId: data.cards[0]?.id ?? '', accountId: data.accounts[0]?.id ?? '', amount: '', date: today() });
  const submit = () => act(() => payInvoice({ ...form, month, amountCents: toCents(form.amount) }), 'Pagamento registrado. A conta foi debitada e o limite liberado conforme as parcelas pagas.').then((ok) => { if (ok) onClose(); });
  return <Modal title="Pagar fatura" onClose={onClose}><div className="form-grid"><Field label="Cartão"><select value={form.cardId} onChange={(e) => setForm({ ...form, cardId: e.target.value })}>{data.cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Conta para pagamento"><select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Valor pago (R$)"><MoneyInput value={form.amount} onChange={(amount) => setForm({ ...form, amount })}/></Field><Field label="Data do pagamento"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}/></Field><div className="form-footnote"><ShieldCheck size={15}/> O pagamento será distribuído às parcelas em aberto até {monthBR(month)}. Ele não será lançado como despesa novamente.</div><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit}>Confirmar pagamento</Button></div></div></Modal>;
}

function InstallmentsPage({ data, month, setMonth, showValues, revision, act }: CommonProps) {
  const [items, setItems] = useState<Installment[]>([]);
  const [filter, setFilter] = useState('active');
  useEffect(() => { db.installments.toArray().then(setItems); }, [revision]);
  const purchases = new Map(data.purchases.map((purchase) => [purchase.id, purchase]));
  const filtered = items.filter((item) => item.dueMonth === month && (filter === 'all' || (filter === 'active' ? item.paidCents < item.amountCents : item.paidCents >= item.amountCents))).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const unpaidTotal = filtered.reduce((sum, item) => sum + item.amountCents - item.paidCents, 0);
  return <><PageHeading eyebrow="COMPROMISSOS FUTUROS" title="Parcelamentos" description="Cada compra aparece no mês da parcela, com a data original da compra e o número da parcela atualizado." action={<div className="inline-actions"><MonthSelector month={month} setMonth={setMonth}/><span className="subtle-tag">{filtered.length} PARCELAS NO MÊS</span></div>}/><div className="stat-grid stat-grid-three"><StatCard label="Parcelas no mês" value={String(filtered.length)} icon={CalendarDays}/><StatCard label="Valor restante no mês" value={money(unpaidTotal)} icon={Wallet} hidden={!showValues}/><StatCard label="Parcelamentos ativos" value={String(new Set(items.filter((item) => item.paidCents < item.amountCents).map((item) => item.purchaseId)).size)} icon={CreditCard}/></div><Panel><div className="filter-toolbar"><div><h3>Compras parceladas</h3><p className="panel-subtitle">A compra se repete nos meses seguintes até completar todas as parcelas.</p></div><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="active">Ativos</option><option value="done">Concluídos</option><option value="all">Todos</option></select></div><div className="table-scroll"><table><thead><tr><th>COMPRA</th><th>CARTÃO</th><th>PARCELAS</th><th>DATA DA COMPRA</th><th>VENCIMENTO</th><th>VALOR</th><th>STATUS</th><th></th></tr></thead><tbody>{filtered.map((item) => { const purchase = purchases.get(item.purchaseId); return <tr key={item.id}><td><strong>{purchase?.description ?? 'Compra removida'}</strong><small className="subline">Total: {showValues ? money(purchase?.totalCents ?? 0) : '••••'}</small></td><td>{data.cards.find((card) => card.id === item.cardId)?.name ?? '—'}</td><td>{item.number}/{item.count}</td><td>{purchase ? dateBR(purchase.purchaseDate) : '—'}</td><td>{dateBR(item.dueDate)}</td><td>{showValues ? money(item.amountCents) : '••••'}</td><td><span className={`status-pill ${item.paidCents >= item.amountCents ? 'status-received' : 'status-pending'}`}>{item.paidCents >= item.amountCents ? 'Paga' : item.paidCents > 0 ? 'Parcial' : 'Em aberto'}</span></td><td><button className="icon-button mini danger-icon" title="Excluir compra e todas as parcelas" onClick={() => { void act(() => deletePurchase(item.purchaseId), 'Compra e parcelas excluídas.'); }}><Trash2 size={14}/></button></td></tr>; })}</tbody></table>{!filtered.length && <TableEmpty text="Nenhuma parcela para este mês e filtro."/>}</div></Panel></>;
}
function DebtorsPage({ data, showValues, revision, act }: CommonProps) {
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof getDebtorMetrics>>>([]);
  const [payments, setPayments] = useState<DebtorPayment[]>([]);
  const [modal, setModal] = useState<'new' | string | null>(null);
  const [expandedPerson, setExpandedPerson] = useState<string | null>(null);
  useEffect(() => { Promise.all([getDebtorMetrics(), db.debtorPayments.toArray()]).then(([m, p]) => { setMetrics(m); setPayments(p); }); }, [revision]);
  const people = Array.from(metrics.reduce((groups, metric) => {
    const key = metric.debtor.person.trim().toLocaleLowerCase('pt-BR');
    const group = groups.get(key) ?? { key, person: metric.debtor.person.trim(), debts: [] as typeof metrics, originalCents: 0, receivedCents: 0, remainingCents: 0 };
    group.debts.push(metric); group.originalCents += metric.debtor.originalCents; group.receivedCents += metric.receivedCents; group.remainingCents += metric.remainingCents;
    groups.set(key, group); return groups;
  }, new Map<string, { key: string; person: string; debts: typeof metrics; originalCents: number; receivedCents: number; remainingCents: number }>()).values());
  const outstanding = people.reduce((sum, person) => sum + person.remainingCents, 0);
  const received = people.reduce((sum, person) => sum + person.receivedCents, 0);
  return <>
    <PageHeading eyebrow="VALORES A RECEBER" title="Devedores" description="Cada pessoa aparece uma vez, com suas dívidas detalhadas e o total pendente." action={<Button onClick={() => setModal('new')}><Plus size={16}/> Adicionar dívida</Button>}/>
    <div className="stat-grid stat-grid-three"><StatCard label="Total a receber" value={money(outstanding)} icon={HandCoins} hidden={!showValues}/><StatCard label="Já recebido" value={money(received)} icon={ArrowDownLeft} tone="green" hidden={!showValues}/><StatCard label="Pessoas com saldo" value={String(people.filter((person) => person.remainingCents > 0).length)} icon={Activity}/></div>
    <Panel><PanelHeader title="Pessoas e dívidas" subtitle="Adicione novas dívidas à mesma pessoa; os valores são somados automaticamente."/><div className="table-scroll"><table><thead><tr><th>PESSOA</th><th>QUANTIDADE DE DÍVIDAS</th><th>TOTAL ORIGINAL</th><th>RECEBIDO</th><th>RESTANTE</th><th></th></tr></thead><tbody>{people.map((person) => <Fragment key={person.key}>
      <tr><td><strong>{person.person}</strong></td><td>{person.debts.length} {person.debts.length === 1 ? 'dívida' : 'dívidas'}</td><td>{showValues ? money(person.originalCents) : '••••'}</td><td className="positive">{showValues ? money(person.receivedCents) : '••••'}</td><td><strong>{showValues ? money(person.remainingCents) : '••••'}</strong></td><td><Button size="small" variant="secondary" onClick={() => setExpandedPerson(expandedPerson === person.key ? null : person.key)}>{expandedPerson === person.key ? 'Ocultar' : 'Detalhes'}</Button></td></tr>
      {expandedPerson === person.key && <tr><td colSpan={6}><div className="debtor-details-list">{person.debts.map(({ debtor, receivedCents, remainingCents, status }) => <div className="debtor-detail" key={debtor.id}>
        <div className="debtor-detail-main"><strong>{debtor.description}</strong><span>{dateBR(debtor.originDate)}{debtor.dueDate ? ` · Previsão: ${dateBR(debtor.dueDate)}` : ''}</span>{debtor.originalPayment && <small>Forma original: {debtor.originalPayment}</small>}{debtor.notes && <small>{debtor.notes}</small>}</div>
        <div className="debtor-detail-values"><span>Original: {showValues ? money(debtor.originalCents) : '••••'}</span><span>Recebido: {showValues ? money(receivedCents) : '••••'}</span><strong>Restante: {showValues ? money(remainingCents) : '••••'}</strong></div>
        <div className="debtor-detail-actions"><span className={`status-pill ${status === 'Quitado' ? 'status-received' : status === 'Atrasado' ? 'status-cancelled' : 'status-pending'}`}>{status}</span>{remainingCents > 0 && <Button size="small" onClick={() => setModal(debtor.id)}>Receber</Button>}<Button size="small" variant="danger" onClick={() => { void act(() => deleteDebtor(debtor.id), 'Dívida removida.'); }}><Trash2 size={14}/> Excluir</Button></div>
        {payments.filter((payment) => payment.debtorId === debtor.id).map((payment) => <div className="debtor-payment-row" key={payment.id}><span>Pagamento em {dateBR(payment.date)} · {showValues ? money(payment.amountCents) : '••••'}</span><button className="icon-button mini danger-icon" title="Excluir recebimento" onClick={() => { void act(() => deleteDebtorPayment(payment.id), 'Recebimento excluído.'); }}><Trash2 size={14}/></button></div>)}
      </div>)}</div></td></tr>}
    </Fragment>)}</tbody></table>{!people.length && <EmptyState icon={HandCoins} title="Nenhum valor a receber" text="Cadastre uma dívida para começar o acompanhamento." action={<Button onClick={() => setModal('new')}><Plus size={16}/> Adicionar dívida</Button>}/>}</div></Panel>
    {modal === 'new' && <DebtorModal data={data} onClose={() => setModal(null)} act={act}/>}
    {modal && modal !== 'new' && <ReceiveDebtorModal debtorId={modal} data={data} onClose={() => setModal(null)} act={act}/>}
  </>;
}
function DebtorModal({ data, onClose, act }: { data: Snapshot; onClose: () => void; act: CommonProps['act'] }) {
  const [form, setForm] = useState({ person: '', description: '', amount: '', originDate: today(), dueDate: '', categoryId: '', originAccountId: data.accounts[0]?.id ?? '', originalPayment: 'Pix', notes: '' });
  const submit = () => act(() => createDebtor({ person: form.person, description: form.description, originalCents: toCents(form.amount), originDate: form.originDate, dueDate: form.dueDate || undefined, categoryId: form.categoryId || undefined, originAccountId: form.originAccountId, originalPayment: form.originalPayment || undefined, notes: form.notes }), 'Dívida registrada. O valor saiu da conta selecionada e foi lançado como despesa.').then((ok) => { if (ok) onClose(); });
  return <Modal title="Adicionar dívida" onClose={onClose}><div className="form-grid">
    <Field label="Nome da pessoa"><input value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })}/></Field>
    <Field label="Valor devido (R$)"><MoneyInput value={form.amount} onChange={(amount) => setForm({ ...form, amount })}/></Field>
    <Field label="Descrição"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}/></Field>
    <Field label="Data da saída"><input type="date" value={form.originDate} onChange={(e) => setForm({ ...form, originDate: e.target.value })}/></Field>
    <Field label="Conta de onde saiu o dinheiro"><select value={form.originAccountId} onChange={(e) => setForm({ ...form, originAccountId: e.target.value })}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
    <Field label="Previsão de pagamento"><input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })}/></Field>
    <Field label="Categoria relacionada"><select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}><option value="">Sem categoria</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
    <Field label="Forma de envio"><input value={form.originalPayment} onChange={(e) => setForm({ ...form, originalPayment: e.target.value })} placeholder="Ex.: Pix, transferência…"/></Field>
    <Field label="Observações" wide><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></Field>
    <div className="form-footnote">O empréstimo será lançado como despesa paga e reduzirá o saldo da conta selecionada.</div>
    <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit} disabled={!data.accounts.length}>Salvar dívida</Button></div>
  </div></Modal>;
}
function ReceiveDebtorModal({ debtorId, data, onClose, act }: { debtorId: string; data: Snapshot; onClose: () => void; act: CommonProps['act'] }) {
  const debtor = data.debtors.find((item) => item.id === debtorId);
  const [form, setForm] = useState({ accountId: data.accounts[0]?.id ?? '', amount: '', date: today(), notes: '' });
  const submit = () => act(() => receiveDebtorPayment({ debtorId, ...form, amountCents: toCents(form.amount) }), 'Recebimento registrado e saldo da conta atualizado.').then((ok) => { if (ok) onClose(); });
  return <Modal title={`Receber de ${debtor?.person ?? 'devedor'}`} onClose={onClose}><div className="form-grid">
    <div className="inline-summary field-wide"><span>Dívida</span><strong>{debtor?.description}</strong></div>
    <Field label="Valor recebido (R$)"><MoneyInput value={form.amount} onChange={(amount) => setForm({ ...form, amount })}/></Field>
    <Field label="Conta de recebimento"><select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
    <Field label="Data"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}/></Field>
    <Field label="Observações"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></Field>
    <div className="form-footnote">Esse recebimento reduz o valor pendente da dívida; não é uma nova receita.</div>
    <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit}>Registrar recebimento</Button></div>
  </div></Modal>;
}

function ReservesPage({ data, showValues, revision, act }: CommonProps) {
  const [balances, setBalances] = useState<Awaited<ReturnType<typeof getReserveBalances>>>([]);
  const [movements, setMovements] = useState<ReserveMovement[]>([]);
  const [modal, setModal] = useState<'new' | { id: string; type: 'deposit' | 'withdrawal' | 'edit' } | null>(null);
  useEffect(() => {
    Promise.all([getReserveBalances(), db.reserveMovements.orderBy('date').reverse().toArray()])
      .then(([b, m]) => { setBalances(b); setMovements(m); });
  }, [revision]);
  const total = balances.reduce((sum, item) => sum + item.balanceCents, 0);
  return <>
    <PageHeading eyebrow="OBJETIVOS FINANCEIROS" title="Minhas caixinhas" description="Separe dinheiro por objetivo e configure o rendimento anual de cada caixinha." action={<Button onClick={() => setModal('new')}><Plus size={16}/> Nova caixinha</Button>}/>
    <div className="stat-grid stat-grid-three"><StatCard label="Total nas caixinhas" value={money(total)} icon={PiggyBank} tone="lavender" hidden={!showValues}/><StatCard label="Objetivos ativos" value={String(balances.filter((item) => !item.reserve.closed).length)} icon={Target}/><StatCard label="Metas cadastradas" value={money(balances.reduce((sum, item) => sum + item.reserve.targetCents, 0))} icon={Goal} hidden={!showValues}/></div>
    <div className="reserve-grid">
      {balances.map(({ reserve, balanceCents }) => {
        const percent = reserve.targetCents ? Math.min(100, balanceCents / reserve.targetCents * 100) : 0;
        const missing = Math.max(0, reserve.targetCents - balanceCents);
        return <Panel className="reserve-card" key={reserve.id}>
          <div className="reserve-card-top"><div className="reserve-icon"><PiggyBank size={19}/></div><span className={`status-pill ${percent >= 100 ? 'status-received' : 'status-pending'}`}>{percent >= 100 ? 'Meta atingida' : reserve.closed ? 'Concluída' : 'Em andamento'}</span></div>
          <h3>{reserve.name}</h3><div className="reserve-amount"><strong>{showValues ? money(balanceCents) : '••••••'}</strong><span>de {showValues ? money(reserve.targetCents) : '••••'}</span></div>
          <div className="progress-track tall"><i style={{ width: `${percent}%` }}/></div>
          <div className="reserve-progress-text"><span>{Math.round(percent)}% concluído</span><span>{showValues ? `${money(missing)} faltando` : '••••'}</span></div>
          <div className="reserve-yield-label">Rendimento anual: <strong>{(reserve.annualYieldPercent ?? 0).toFixed(2).replace('.', ',')}%</strong></div>
          <div className="reserve-actions"><Button size="small" onClick={() => setModal({ id: reserve.id, type: 'deposit' })}><Plus size={14}/> Adicionar</Button><Button size="small" variant="secondary" onClick={() => setModal({ id: reserve.id, type: 'withdrawal' })}>Retirar</Button><Button size="small" variant="secondary" onClick={() => setModal({ id: reserve.id, type: 'edit' })}>Editar</Button><Button size="small" variant="danger" onClick={() => { void act(() => deleteReserve(reserve.id), 'Caixinha removida.'); }}><Trash2 size={14}/> Excluir</Button></div>
          {reserve.targetDate && <small className="reserve-deadline">Prazo: {dateBR(reserve.targetDate)}</small>}
        </Panel>;
      })}
      {!balances.length && <Panel><EmptyState icon={PiggyBank} title="Crie sua primeira caixinha" text="Defina um objetivo, uma taxa anual e acompanhe o saldo crescer." action={<Button onClick={() => setModal('new')}><Plus size={16}/> Nova caixinha</Button>}/></Panel>}
    </div>
    <Panel><PanelHeader title="Movimentações das caixinhas" subtitle="Depósitos, retiradas e rendimentos; é possível remover um lançamento individual."/><div className="table-scroll"><table><thead><tr><th>CAIXINHA</th><th>TIPO</th><th>DATA</th><th>OBSERVAÇÕES</th><th>VALOR</th><th></th></tr></thead><tbody>{movements.map((move) => <tr key={move.id}><td>{data.reserves.find((reserve) => reserve.id === move.reserveId)?.name ?? '—'}</td><td>{move.type === 'deposit' ? 'Depósito' : move.type === 'withdrawal' ? 'Retirada' : 'Rendimento'}</td><td>{dateBR(move.date)}</td><td>{move.notes ?? '—'}</td><td className={move.type === 'withdrawal' ? 'negative' : 'positive'}>{showValues ? money(move.amountCents) : '••••'}</td><td><button className="icon-button mini danger-icon" title="Excluir movimentação" onClick={() => { void act(() => deleteReserveMovement(move.id), 'Movimentação excluída.'); }}><Trash2 size={14}/></button></td></tr>)}</tbody></table>{!movements.length && <TableEmpty text="Nenhuma movimentação de caixinha registrada."/>}</div></Panel>
    <div className="info-note"><Activity size={17}/><span>O Nexo calcula rendimento composto por dia corrido usando a taxa anual informada. A atualização é feita quando você abre o sistema; se ficar alguns dias sem entrar, os dias anteriores são calculados na próxima abertura. É uma simulação e pode não incluir impostos, taxas ou regras específicas do banco.</span></div>
    {modal === 'new' && <ReserveModal editing={null} onClose={() => setModal(null)} act={act}/>}
    {modal && typeof modal === 'object' && modal.type === 'edit' && <ReserveModal editing={balances.find((item) => item.reserve.id === modal.id)?.reserve ?? null} onClose={() => setModal(null)} act={act}/>}
    {modal && typeof modal === 'object' && modal.type !== 'edit' && <ReserveMovementModal reserveId={modal.id} type={modal.type} data={data} onClose={() => setModal(null)} act={act}/>}
  </>;
}
function ReserveModal({ editing, onClose, act }: { editing: Reserve | null; onClose: () => void; act: CommonProps['act'] }) {
  const [form, setForm] = useState({ name: editing?.name ?? '', target: fromCents(editing?.targetCents ?? 0), date: editing?.targetDate ?? '', notes: editing?.notes ?? '', annualYieldPercent: String(editing?.annualYieldPercent ?? 0) });
  const submit = () => act(() => saveReserve({ id: editing?.id, name: form.name, targetCents: toCents(form.target), targetDate: form.date || undefined, notes: form.notes, closed: editing?.closed ?? false, annualYieldPercent: Number(form.annualYieldPercent) }), editing ? 'Caixinha atualizada.' : 'Caixinha criada.').then((ok) => { if (ok) onClose(); });
  return <Modal title={editing ? 'Editar caixinha' : 'Criar caixinha'} onClose={onClose}><div className="form-grid">
    <Field label="Nome do objetivo"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Viagem"/></Field>
    <Field label="Meta (R$)"><MoneyInput value={form.target} onChange={(target) => setForm({ ...form, target })}/></Field>
    <Field label="Rendimento anual (%)"><input type="number" min="0" max="100" step="0.01" value={form.annualYieldPercent} onChange={(e) => setForm({ ...form, annualYieldPercent: e.target.value })}/></Field>
    <Field label="Prazo desejado"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}/></Field>
    <Field label="Observações" wide><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></Field>
    <div className="form-footnote"><Activity size={15}/> A taxa anual é convertida em taxa diária equivalente e aplicada ao saldo acumulado da caixinha.</div>
    <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit}>{editing ? 'Salvar alterações' : 'Criar caixinha'}</Button></div>
  </div></Modal>;
}
function ReserveMovementModal({ reserveId, type, data, onClose, act }: { reserveId: string; type: 'deposit' | 'withdrawal'; data: Snapshot; onClose: () => void; act: CommonProps['act'] }) {
  const [form, setForm] = useState({ amount: '', date: today(), notes: '' });
  const submit = () => act(() => moveReserve({ reserveId, type, amountCents: toCents(form.amount), date: form.date, notes: form.notes }), type === 'deposit' ? 'Aporte adicionado.' : 'Retirada registrada.').then((ok) => { if (ok) onClose(); });
  const reserve = data.reserves.find((item) => item.id === reserveId);
  return <Modal title={type === 'deposit' ? `Adicionar à ${reserve?.name ?? 'caixinha'}` : `Retirar da ${reserve?.name ?? 'caixinha'}`} onClose={onClose}><div className="form-grid">
    <Field label="Valor (R$)"><MoneyInput value={form.amount} onChange={(amount) => setForm({ ...form, amount })}/></Field>
    <Field label="Data"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}/></Field>
    <Field label="Observações" wide><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></Field>
    <div className="form-footnote"><PiggyBank size={15}/> A movimentação altera o valor reservado; não cria uma nova despesa ou investimento.</div>
    <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={submit}>Confirmar</Button></div>
  </div></Modal>;
}

function ReportsPage({ data, month, setMonth, showValues, revision }: CommonProps) {
  const [spend, setSpend] = useState<Awaited<ReturnType<typeof getCategorySpend>>>([]);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof getMonthSummary>> | null>(null);
  useEffect(() => { Promise.all([getCategorySpend(month), getMonthSummary(month)]).then(([s, v]) => { setSpend(s); setSummary(v); }); }, [month, revision]);
  const chartData = spend.map((item) => ({ name: item.category.name, gasto: item.spentCents / 100 }));
  const categoryTotalCents = spend.reduce((sum, item) => sum + item.spentCents, 0);
  return <><PageHeading eyebrow="INTELIGÊNCIA FINANCEIRA" title="Relatórios e análises" description="Entenda seus gastos, compare o planejado e identifique tendências." action={<div className="inline-actions"><MonthSelector month={month} setMonth={setMonth}/><Button size="small" variant="secondary" onClick={() => downloadReportCsv(month, spend)}><Download size={14}/> CSV</Button><Button size="small" variant="secondary" onClick={() => downloadReportExcel(month, spend)}><FileText size={14}/> Excel</Button><Button size="small" variant="secondary" onClick={() => window.print()}>PDF / Imprimir</Button></div>}/><div className="stat-grid stat-grid-three"><StatCard label="Receitas" value={money(summary?.incomeCents ?? 0)} icon={TrendingUp} tone="green" hidden={!showValues}/><StatCard label="Despesas e parcelas" value={money((summary?.cashExpensesCents ?? 0) + (summary?.installmentsCents ?? 0))} icon={TrendingDown} tone="pink" hidden={!showValues}/><StatCard label="Saldo projetado" value={money(summary?.freeCents ?? 0)} icon={Wallet} hidden={!showValues}/></div><div className="dashboard-grid"><Panel><PanelHeader title="Despesas por categoria" subtitle={monthBR(month)}/>{chartData.length ? <ResponsiveContainer width="100%" height={320}><BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 22, bottom: 4, left: 24 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0eafa"/><XAxis type="number" tick={{ fontSize: 11, fill: '#8f879d' }} axisLine={false} tickLine={false}/><YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11, fill: '#827b91' }} axisLine={false} tickLine={false}/><Tooltip formatter={(v) => money(Number(v) * 100)}/><Bar dataKey="gasto" fill="#8b5cf6" radius={[0, 6, 6, 0]}/></BarChart></ResponsiveContainer> : <EmptyState title="Sem dados suficientes" text="Registre despesas para preencher este relatório."/>}</Panel><Panel><PanelHeader title="Resumo por categoria" subtitle="Valores contabilizados no mês"/><div className="category-report-list">{spend.map((item, index) => <div className="category-report-row" key={item.category.id}><span className="category-dot" style={{ background: item.category.color }}/><span>{item.category.name}</span><strong>{showValues ? money(item.spentCents) : '••••'}</strong><small>{categoryTotalCents ? `${Math.round(item.spentCents / categoryTotalCents * 100)}%` : '—'}</small></div>)}</div></Panel></div><div className="info-note"><FileText size={17}/><span>Os valores de despesas por categoria somam registros à vista e parcelas de crédito no mês. Exporte este resumo em CSV ou Excel, ou use a impressão do navegador para salvar em PDF.</span></div></>;
}

function CalendarPage({ data, month, setMonth, revision }: CommonProps) {
  const [installments, setInstallments] = useState<Awaited<ReturnType<typeof getInstallmentsForMonth>>>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  useEffect(() => { Promise.all([getInstallmentsForMonth(month), db.transactions.where('month').equals(month).toArray()]).then(([i, t]) => { setInstallments(i); setTransactions(t); }); }, [month, revision]);
  const events = [
    ...installments.map((item) => ({ date: item.dueDate, label: `Parcela ${item.number}/${item.count}`, detail: data.purchases.find((p) => p.id === item.purchaseId)?.description ?? 'Compra no cartão', amount: item.amountCents, kind: 'installment' })),
    ...transactions.filter((tx) => tx.type === 'income').map((tx) => ({ date: tx.date, label: 'Receita', detail: tx.description, amount: tx.amountCents, kind: 'income' })),
    ...transactions.filter((tx) => tx.type === 'expense' && (tx.status === 'pending' || tx.status === 'receivable')).map((tx) => ({ date: tx.date, label: 'Conta pendente', detail: tx.description, amount: tx.amountCents, kind: tx.type })),
    ...transactions.filter((tx) => tx.type === 'expense' && (tx.status === 'paid' || tx.status === 'received')).map((tx) => ({ date: tx.date, label: 'Despesa paga', detail: tx.description, amount: tx.amountCents, kind: tx.type })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return <><PageHeading eyebrow="AGENDA FINANCEIRA" title="Calendário de compromissos" description="Visualize vencimentos de parcelas e movimentações registradas para o mês." action={<MonthSelector month={month} setMonth={setMonth}/>}/><Panel><PanelHeader title={monthBR(month)} subtitle={`${events.length} compromisso(s) registrado(s)`}/><div className="event-list">{events.map((event, index) => <div className="event-row" key={`${event.date}-${index}`}><div className="event-date"><strong>{event.date.slice(8, 10)}</strong><small>{new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(new Date(`${event.date}T12:00:00`))}</small></div><div className={`event-marker ${event.kind}`}/><div className="event-main"><strong>{event.label}</strong><span>{event.detail}</span></div><strong className={event.kind === 'income' ? 'positive' : 'negative'}>{money(event.amount)}</strong></div>)}{!events.length && <EmptyState icon={CalendarDays} title="Agenda livre por enquanto" text="Parcelas e movimentações com datas serão exibidas aqui."/>}</div></Panel><div className="info-note"><CircleHelp size={17}/><span>Este calendário apresenta parcelas e movimentações já cadastradas. Despesas recorrentes, lembretes automáticos e sincronização externa ainda não estão implementados.</span></div></>;
}

function ForecastPage({ data, month, setMonth, showValues, revision }: CommonProps) {
  const [rows, setRows] = useState<Array<{ month: string; income: number; expense: number; installments: number; reserves: number; monthlyFree: number; balance: number }>>([]);
  useEffect(() => {
    let active = true;
    (async () => {
      const records: Array<{ month: string; income: number; expense: number; installments: number; reserves: number; monthlyFree: number; balance: number }> = [];
      let balance = 0;
      for (let offset = 0; offset < 6; offset += 1) {
        const m = addMonths(month, offset);
        const summary = await getMonthSummary(m);
        const row = { month: m, income: summary.incomeCents, expense: summary.cashExpensesCents, installments: summary.installmentsCents, reserves: summary.reserveDepositsCents, balance: summary.freeCents };
        balance += row.balance; records.push({ ...row, monthlyFree: row.balance, balance });
      }
      if (active) setRows(records);
    })();
    return () => { active = false; };
  }, [month, revision]);
  return <><PageHeading eyebrow="PLANEJAMENTO" title="Previsão dos próximos meses" description="Projeção baseada nos registros e parcelas já cadastrados. Valores futuros dependem da qualidade das informações lançadas." action={<MonthSelector month={month} setMonth={setMonth}/>}/><Panel><PanelHeader title="Projeção de seis meses" subtitle="Saldo acumulado estimado, sem incluir receitas e despesas ainda não cadastradas."/><div className="table-scroll"><table><thead><tr><th>MÊS</th><th>RECEITAS</th><th>DESPESAS À VISTA</th><th>PARCELAS</th><th>RESERVAS</th><th>SALDO DO MÊS</th><th>ACUMULADO</th></tr></thead><tbody>{rows.map((row) => <tr key={row.month}><td><strong>{monthBR(row.month)}</strong></td><td className="positive">{showValues ? money(row.income) : '••••'}</td><td className="negative">{showValues ? money(row.expense) : '••••'}</td><td>{showValues ? money(row.installments) : '••••'}</td><td>{showValues ? money(row.reserves) : '••••'}</td><td className={row.balance >= 0 ? 'positive' : 'negative'}>{showValues ? money(row.monthlyFree) : '••••'}</td><td><strong>{showValues ? money(row.balance) : '••••'}</strong></td></tr>)}</tbody></table></div></Panel><div className="info-note"><Activity size={17}/><span>Esta projeção é uma soma de compromissos conhecidos por mês; não é uma previsão bancária nem considera automaticamente recorrências ou rendimento CDI futuro. Registros pendentes são incluídos no planejamento mensal.</span></div></>;
}
function addMonths(month: string, offset: number) { const [year, m] = month.split('-').map(Number); const date = new Date(year, m - 1 + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }

function PatrimonyPage({ showValues, revision }: CommonProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getPatrimony>> | null>(null);
  useEffect(() => { getPatrimony().then(setData); }, [revision]);
  return <><PageHeading eyebrow="VISÃO CONSOLIDADA" title="Patrimônio financeiro" description="Uma visão consolidada do que você possui, do que tem a receber e dos compromissos em aberto."/><div className="patrimony-hero"><span>Patrimônio líquido estimado</span><strong>{showValues ? money(data?.netWorth ?? 0) : '••••••'}</strong><small>Contas + investimentos + valores a receber − compromissos de cartão</small></div><div className="stat-grid stat-grid-three"><StatCard label="Saldos bancários" value={money(data?.cash ?? 0)} icon={Landmark} hidden={!showValues}/><StatCard label="Investimentos" value={money(data?.investmentsTotal ?? 0)} icon={TrendingUp} tone="green" hidden={!showValues}/><StatCard label="Valores a receber" value={money(data?.receivable ?? 0)} icon={HandCoins} tone="lavender" hidden={!showValues}/><StatCard label="Compromissos de cartão" value={money(data?.cardCommitments ?? 0)} icon={CreditCard} tone="pink" hidden={!showValues}/><StatCard label="Dinheiro reservado" value={money(data?.reserved ?? 0)} icon={PiggyBank} hidden={!showValues}/><StatCard label="Dinheiro livre em contas" value={money(data?.freeCash ?? 0)} icon={Wallet} hidden={!showValues}/></div><Panel><PanelHeader title="Composição do patrimônio" subtitle="As caixinhas são uma parte dos saldos bancários, portanto não são somadas novamente."/><div className="composition-list">{[{ label: 'Saldos em contas', amount: data?.cash ?? 0, color: '#7c3aed' }, { label: 'Investimentos CDI', amount: data?.investmentsTotal ?? 0, color: '#a78bfa' }, { label: 'Valores a receber', amount: data?.receivable ?? 0, color: '#c4b5fd' }, { label: 'Compromissos de cartão', amount: -(data?.cardCommitments ?? 0), color: '#ec4899' }].map((item) => <div className="composition-row" key={item.label}><span><i style={{ background: item.color }}/>{item.label}</span><strong className={item.amount < 0 ? 'negative' : ''}>{showValues ? money(item.amount) : '••••'}</strong></div>)}</div></Panel></>;
}

function SettingsPage({ refresh, act }: CommonProps) {
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');
  const exportFile = async (encrypted: boolean) => {
    try {
      const payload = await exportBackup();
      const result = encrypted ? await encryptBackup(payload, password) : payload;
      downloadFile(JSON.stringify(result, null, 2), `nexo-backup-${today()}${encrypted ? '-criptografado' : ''}.json`, 'application/json');
      setMessage(encrypted ? 'Backup criptografado exportado.' : 'Backup exportado. Guarde o arquivo em local seguro.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível exportar.'); }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      let payload = parsed;
      if (parsed && typeof parsed === 'object' && (parsed as { format?: string }).format === 'NEXO-AES-GCM-1') payload = await decryptBackup(parsed as { format: string; salt: string; iv: string; data: string }, password);
      
      await restoreBackup(payload, false); refresh(); setMessage('Backup restaurado sem duplicar registros já existentes.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Arquivo inválido ou senha incorreta.'); }
  };
  return <><PageHeading eyebrow="PRIVACIDADE E DADOS" title="Configurações e backup" description="Gerencie a segurança dos seus dados, exporte cópias e restaure o sistema."/><div className="settings-grid"><Panel><div className="settings-icon purple"><Download size={20}/></div><h3>Backup dos dados</h3><p>Exporte suas informações em JSON para guardar uma cópia completa das contas, movimentações, cartões, parcelas, devedores, reservas e CDI.</p><div className="settings-actions"><Button onClick={() => void exportFile(false)}><Download size={15}/> Exportar JSON</Button></div></Panel><Panel><div className="settings-icon green"><ShieldCheck size={20}/></div><h3>Backup criptografado</h3><p>Use uma senha para proteger o arquivo com AES-GCM e derivação de chave PBKDF2. A senha não é salva pelo Nexo.</p><Field label="Senha (mínimo 8 caracteres)"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Defina uma senha forte"/></Field><div className="settings-actions"><Button variant="secondary" onClick={() => void exportFile(true)} disabled={password.length < 8}>Exportar criptografado</Button></div></Panel><Panel><div className="settings-icon lavender"><Upload size={20}/></div><h3>Restaurar backup</h3><p>Importe um JSON exportado pelo Nexo. A restauração mescla registros e evita duplicatas por identificador.</p><Field label="Senha do backup criptografado (se aplicável)"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)}/></Field><label className="btn btn-secondary file-button"><Upload size={15}/> Selecionar arquivo<input type="file" accept=".json,application/json" onChange={(e) => void importFile(e.target.files?.[0])}/></label></Panel><Panel><div className="settings-icon pink"><Smartphone size={20}/></div><h3>Privacidade e armazenamento</h3><p>Seus dados ficam no IndexedDB deste navegador e não são enviados para um servidor. O armazenamento local não é automaticamente criptografado.</p><ul className="settings-list"><li>Não armazene senhas bancárias ou números completos de cartões.</li><li>Limpar os dados do navegador pode apagar suas informações.</li><li>Faça backups periódicos e guarde uma cópia fora do dispositivo.</li><li>O modo offline depende do primeiro carregamento completo da aplicação.</li></ul></Panel></div><Panel><div className="settings-icon pink"><Trash2 size={20}/></div><h3>Apagar dados de teste</h3><p>Remove os registros deste navegador e recria apenas os cadastros iniciais vazios. Faça um backup antes, caso queira conservar alguma informação.</p><div className="settings-actions"><Button variant="danger" onClick={() => { void act(() => clearTestData(), 'Os dados de teste foram apagados e os cadastros vazios foram recriados.'); }}>Apagar todos os dados</Button></div></Panel>{message && <div className="info-note"><Check size={17}/><span>{message}</span><button className="icon-button mini" onClick={() => setMessage('')}><X size={14}/></button></div>}<Panel className="about-panel"><PanelHeader title="Sobre o Nexo"/><div className="about-grid"><div><span>Versão</span><strong>1.0.0</strong></div><div><span>Banco de dados</span><strong>IndexedDB · Dexie.js</strong></div><div><span>Hospedagem</span><strong>GitHub Pages</strong></div><div><span>Arquitetura</span><strong>100% navegador</strong></div></div></Panel></>;
}
function downloadFile(content: string, filename: string, mime: string) { const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }

function downloadReportCsv(month: string, spend: Awaited<ReturnType<typeof getCategorySpend>>) {
  const rows = [['Mês', 'Categoria', 'Gasto (centavos)'], ...spend.map((item) => [month, item.category.name, String(item.spentCents)])];
  const csv = '\uFEFF' + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  downloadFile(csv, `nexo-relatorio-${month}.csv`, 'text/csv;charset=utf-8');
}
function downloadReportExcel(month: string, spend: Awaited<ReturnType<typeof getCategorySpend>>) {
  const tableRows = spend.map((item) => `<tr><td>${escapeHtml(month)}</td><td>${escapeHtml(item.category.name)}</td><td>${(item.spentCents / 100).toFixed(2).replace('.', ',')}</td></tr>`).join('');
  const html = `<html><head><meta charset="utf-8"></head><body><table><thead><tr><th>Mês</th><th>Categoria</th><th>Gasto (R$)</th></tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
  downloadFile(html, `nexo-relatorio-${month}.xls`, 'application/vnd.ms-excel;charset=utf-8');
}
function escapeHtml(value: string) {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
}
