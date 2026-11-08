// Челлендж недели: общие правила для приложения и сервера (в приложение — как обычный скрипт, без export).
// Каждую неделю (с понедельника по Москве) — новое условие из списка по кругу. Состав собирается свободно,
// как в обычной сборке, но только из подходящих карточек и в пределах лимита зарплаты.

export const CONFERENCES = {
  east: ['BOSTON BRUINS', 'BUFFALO SABRES', 'DETROIT RED WINGS', 'FLORIDA PANTHERS', 'MONTREAL CANADIENS', 'OTTAWA SENATORS',
    'TAMPA BAY LIGHTNING', 'TORONTO MAPLE LEAFS', 'CAROLINA HURRICANES', 'COLUMBUS BLUE JACKETS', 'NEW JERSEY DEVILS',
    'NEW YORK ISLANDERS', 'NEW YORK RANGERS', 'PHILADELPHIA FLYERS', 'PITTSBURGH PENGUINS', 'WASHINGTON CAPITALS'],
  west: ['CHICAGO BLACKHAWKS', 'COLORADO AVALANCHE', 'DALLAS STARS', 'MINNESOTA WILD', 'NASHVILLE PREDATORS', 'ST. LOUIS BLUES',
    'UTAH MAMMOTH', 'WINNIPEG JETS', 'ANAHEIM DUCKS', 'CALGARY FLAMES', 'EDMONTON OILERS', 'LOS ANGELES KINGS',
    'SAN JOSE SHARKS', 'SEATTLE KRAKEN', 'VANCOUVER CANUCKS', 'VEGAS GOLDEN KNIGHTS'],
};

export const CHALLENGES = [
  { id: 'ice-wall', title: 'Ледяная стена', cap: 60, conference: 'east', goalieMin: 85,
    rules: ['💰 Зарплата до $60M', '🏒 Только Восточная конференция', '🧤 Вратари 85+'] },
  { id: 'wild-west', title: 'Дикий Запад', cap: 70, conference: 'west', rules: ['💰 Зарплата до $70M', '🤠 Только Западная конференция'] },
  { id: 'maple', title: 'Кленовый лист', cap: 75, nations: ['CANADA'], rules: ['💰 Зарплата до $75M', '🇨🇦 Только канадцы'] },
  { id: 'no-stars', title: 'Без звёзд', cap: 80, maxOvr: 85, rules: ['💰 Зарплата до $80M', '⭐ Карточки не выше 85 OVR'] },
  { id: 'budget', title: 'Экономия', cap: 50, rules: ['💰 Зарплата до $50M', '🎴 Любые карточки'] },
  { id: 'stars-stripes', title: 'Звёзды и полосы', cap: 75, nations: ['USA'], rules: ['💰 Зарплата до $75M', '🇺🇸 Только американцы'] },
  { id: 'europe', title: 'Европейский экспресс', cap: 80, excludeNations: ['CANADA', 'USA'], rules: ['💰 Зарплата до $80M', '🇪🇺 Без канадцев и американцев'] },
];
export const CHALLENGE_SLOTS = [
  'F1-LW', 'F1-C', 'F1-RW', 'F2-LW', 'F2-C', 'F2-RW', 'F3-LW', 'F3-C', 'F3-RW', 'F4-LW', 'F4-C', 'F4-RW',
  'D1-LD', 'D1-RD', 'D2-LD', 'D2-RD', 'D3-LD', 'D3-RD', 'G-STARTER', 'G-BACKUP',
];

const EPOCH = Date.UTC(2026, 10, 2); // понедельник 2 ноября 2026 — первая неделя («Ледяная стена»)
const WEEK = 7 * 86400e3;
const MSK = 3 * 3600e3;

// Текущая неделя по Москве: { week: 'YYYY-MM-DD' (понедельник), ch, endsAt (unix, с) }
export function challengeNow(ms = Date.now()) {
  const n = Math.floor((ms + MSK - EPOCH) / WEEK);
  const start = EPOCH + n * WEEK;
  return {
    week: new Date(start).toISOString().slice(0, 10),
    ch: CHALLENGES[((n % CHALLENGES.length) + CHALLENGES.length) % CHALLENGES.length],
    endsAt: Math.floor((start + WEEK - MSK) / 1000),
  };
}

export const teamKey = team => String(team || '').toUpperCase().replace(/\s+ALUMNI$/, '').trim();

// p: { pos, ovr, team, nation }
export function challengeAllows(ch, p) {
  if (ch.conference && !CONFERENCES[ch.conference].includes(teamKey(p.team))) return false;
  const nation = String(p.nation || '').toUpperCase();
  if (ch.nations && !ch.nations.includes(nation)) return false;
  if (ch.excludeNations && ch.excludeNations.includes(nation)) return false;
  if (ch.maxOvr && p.ovr > ch.maxOvr) return false;
  if (ch.goalieMin && p.pos === 'G' && p.ovr < ch.goalieMin) return false;
  return true;
}

// lineup: { slot: { pos, ovr, team, nation, salary, name } } → текст ошибки или null
export function challengeCheck(ch, lineup) {
  const names = new Set();
  let salary = 0;
  for (const key of CHALLENGE_SLOTS) {
    const p = lineup[key];
    if (!p) return 'Заполни все 20 слотов';
    const slot = key.split('-')[1];
    const okPos = slot === 'STARTER' || slot === 'BACKUP' ? p.pos === 'G' : p.pos === slot;
    if (!okPos) return `${p.name}: не своя позиция`;
    if (!challengeAllows(ch, p)) return `${p.name} не подходит под условия`;
    const n = String(p.name).trim().toLowerCase();
    if (names.has(n)) return `${p.name} уже в составе`;
    names.add(n);
    salary += p.salary;
  }
  if (salary > ch.cap + 0.05) return `Зарплата $${salary.toFixed(1)}M — больше лимита $${ch.cap}M`;
  return null;
}
