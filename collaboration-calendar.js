import { outstanding } from './collaboration-import.js';

export const EVENT_TYPES = {
  visit: '방문·예약', draft: '원고 제출', publish: '발행 마감', output: '결과물 마감', payment: '정산 예정',
};
export const koreanDateTime = value => value ? new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(value)).replace(' ', 'T') : '';
const isoDay = date => date.toISOString().slice(0, 10);

// Work with UTC calendar dates so a viewer's device timezone cannot shift a day.
export function monthDays(month) {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((first.getUTCDay() + length) / 7) * 7 }, (_, i) => {
    const date = new Date(first); date.setUTCDate(1 - first.getUTCDay() + i);
    return { date: isoDay(date), day: date.getUTCDate(), inMonth: date.getUTCMonth() === number - 1 };
  });
}
export function moveMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  return isoDay(new Date(Date.UTC(year, number - 1 + offset, 1))).slice(0, 7);
}
export function calendarEvents(row) {
  if (row.deleted_at || row.status === 'cancelled') return [];
  const done = ['published', 'completed'].includes(row.status);
  const events = [];
  const add = (type, date, completed, extra = {}) => { if (date) events.push({ type, date, done: completed, label: EVENT_TYPES[type], row, ...extra }); };
  const visit = koreanDateTime(row.visit_at);
  add('visit', visit.slice(0, 10), done, { time: visit.slice(11) });
  add('draft', row.draft_due, done || ['submitted', 'review'].includes(row.status));
  add('publish', row.publish_due, done);
  for (const output of row.deliverables || []) {
    add('output', output.due_on, output.status === 'published' || row.status === 'completed', { label: output.name || EVENT_TYPES.output });
  }
  if (Number(row.cash_fee) > 0) add('payment', row.payment_due, outstanding(row) === 0);
  return events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
}
