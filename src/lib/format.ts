export const money = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);
export const dateBR = (date?: string) => date ? new Intl.DateTimeFormat('pt-BR').format(new Date(`${date}T12:00:00`)) : '—';
export const monthBR = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(year, m - 1, 1));
};
export const toCents = (value: string | number) => {
  const raw = String(value).trim().replace(/\s/g, '');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  return Math.round(Number(normalized) * 100);
};
export const fromCents = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
export const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export const thisMonth = () => today().slice(0, 7);
export const firstUsageMonth = () => thisMonth() < '2026-12' ? '2026-12' : thisMonth();
export const makeId = () => crypto.randomUUID();
export const monthOffset = (month: string, offset: number) => {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(year, m - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const daysInMonth = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m, 0).getDate();
};
