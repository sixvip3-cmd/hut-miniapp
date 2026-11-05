// Тарифы HUT Builder: разовая оплата в рублях через RollyPay.
// «Навсегда» — доступ до LIFETIME_UNTIL (1 января 2100 года).

export const LIFETIME_UNTIL = 4102444800;
export const isLifetime = until => until >= LIFETIME_UNTIL;

export const PLANS = [
  { id: 'm1', days: 30, rub: 99, title: '1 месяц', short: 'месяц' },
  { id: 'm3', days: 90, rub: 249, title: '3 месяца', short: '3 месяца', note: '83 ₽/мес · −16%' },
  { id: 'y1', days: 365, rub: 799, title: '1 год', short: 'год', note: '67 ₽/мес · −33%', hit: true },
  { id: 'life', days: null, rub: 1990, title: 'Навсегда', short: 'навсегда', note: 'один платёж — и больше никогда' },
];

export const planById = id => PLANS.find(p => p.id === id) || null;
export const rub = n => `${Number(n).toLocaleString('ru-RU')} ₽`;

// Кнопки выбора тарифа в боте: buy:<id>.
export const plansKeyboard = () => ({
  inline_keyboard: [
    PLANS.slice(0, 2).map(p => ({ text: `${p.title} — ${rub(p.rub)}`, callback_data: `buy:${p.id}` })),
    PLANS.slice(2).map(p => ({ text: `${p.hit ? '🔥 ' : p.days ? '' : '👑 '}${p.title} — ${rub(p.rub)}`, callback_data: `buy:${p.id}` })),
  ],
});

export const plansText = () => PLANS.map(p =>
  `${p.hit ? '🔥' : p.days ? '▫️' : '👑'} <b>${p.title}</b> — ${rub(p.rub)}${p.note ? ` (${p.note})` : ''}`).join('\n');
