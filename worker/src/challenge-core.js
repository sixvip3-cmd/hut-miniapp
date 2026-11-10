// Челлендж недели: общие правила для приложения и сервера (в приложение — как обычный скрипт, без export).
// Каждую неделю (с понедельника по Москве) — новое условие из списка по кругу. Состав собирается как драфт:
// 21 пик (капитан, 19 игроков, тренер) по 1 из 4 случайных вариантов, но варианты — только из карточек, подходящих под условие.
// Лимита зарплаты нет: в каждом раунде может выпасть любая подходящая карточка. В зачёт — лучшая попытка недели.

export const CHALLENGE_PER_DAY = 3; // попыток челленджа в день

export const CONFERENCES = {
  east: ['BOSTON BRUINS', 'BUFFALO SABRES', 'DETROIT RED WINGS', 'FLORIDA PANTHERS', 'MONTREAL CANADIENS', 'OTTAWA SENATORS',
    'TAMPA BAY LIGHTNING', 'TORONTO MAPLE LEAFS', 'CAROLINA HURRICANES', 'COLUMBUS BLUE JACKETS', 'NEW JERSEY DEVILS',
    'NEW YORK ISLANDERS', 'NEW YORK RANGERS', 'PHILADELPHIA FLYERS', 'PITTSBURGH PENGUINS', 'WASHINGTON CAPITALS'],
  west: ['CHICAGO BLACKHAWKS', 'COLORADO AVALANCHE', 'DALLAS STARS', 'MINNESOTA WILD', 'NASHVILLE PREDATORS', 'ST. LOUIS BLUES',
    'UTAH MAMMOTH', 'WINNIPEG JETS', 'ANAHEIM DUCKS', 'CALGARY FLAMES', 'EDMONTON OILERS', 'LOS ANGELES KINGS',
    'SAN JOSE SHARKS', 'SEATTLE KRAKEN', 'VANCOUVER CANUCKS', 'VEGAS GOLDEN KNIGHTS'],
};

export const ORIGINAL_SIX = ['BOSTON BRUINS', 'CHICAGO BLACKHAWKS', 'DETROIT RED WINGS', 'MONTREAL CANADIENS', 'NEW YORK RANGERS', 'TORONTO MAPLE LEAFS'];

// «Один за всех»: клуб меняется каждый раз, когда челлендж выпадает (только клубы, из которых собирается полный состав).
export const ONE_CLUB = [
  ['EDMONTON OILERS', 'Эдмонтон'], ['TORONTO MAPLE LEAFS', 'Торонто'], ['PITTSBURGH PENGUINS', 'Питтсбург'],
  ['MONTREAL CANADIENS', 'Монреаль'], ['DETROIT RED WINGS', 'Детройт'], ['CHICAGO BLACKHAWKS', 'Чикаго'],
  ['BOSTON BRUINS', 'Бостон'], ['NEW YORK RANGERS', 'Рейнджерс'], ['WASHINGTON CAPITALS', 'Вашингтон'],
  ['TAMPA BAY LIGHTNING', 'Тампа'], ['COLORADO AVALANCHE', 'Колорадо'], ['VEGAS GOLDEN KNIGHTS', 'Вегас'],
  ['FLORIDA PANTHERS', 'Флорида'], ['NEW YORK ISLANDERS', 'Айлендерс'], ['LOS ANGELES KINGS', 'Лос-Анджелес'],
  ['PHILADELPHIA FLYERS', 'Филадельфия'], ['DALLAS STARS', 'Даллас'], ['ST. LOUIS BLUES', 'Сент-Луис'],
  ['OTTAWA SENATORS', 'Оттава'], ['VANCOUVER CANUCKS', 'Ванкувер'], ['CALGARY FLAMES', 'Калгари'],
  ['WINNIPEG JETS', 'Виннипег'], ['NEW JERSEY DEVILS', 'Нью-Джерси'], ['CAROLINA HURRICANES', 'Каролина'],
  ['MINNESOTA WILD', 'Миннесота'], ['NASHVILLE PREDATORS', 'Нэшвилл'], ['BUFFALO SABRES', 'Баффало'],
  ['COLUMBUS BLUE JACKETS', 'Коламбус'], ['ANAHEIM DUCKS', 'Анахайм'], ['SAN JOSE SHARKS', 'Сан-Хосе'],
];

// Порядок недель. «Ледяная стена» — первая неделя (2 ноября 2026), дальше по кругу.
export const CHALLENGES = [
  { id: 'ice-wall', title: 'Ледяная стена', conference: 'east', goalieMin: 85,
    rules: ['🏒 Только Восточная конференция', '🧤 Вратари 85+'] },
  { id: 'red-machine', title: 'Красная машина', nations: ['RUSSIA'], rules: ['🇷🇺 Только русские'] },
  { id: 'wild-west', title: 'Дикий Запад', conference: 'west', rules: ['🤠 Только Западная конференция'] },
  { id: 'original-six', title: 'Оригинальная шестёрка', teams: ORIGINAL_SIX,
    rules: ['🏛 Бостон, Чикаго, Детройт, Монреаль, Рейнджерс, Торонто'] },
  { id: 'maple', title: 'Кленовый лист', nations: ['CANADA'], rules: ['🇨🇦 Только канадцы'] },
  { id: 'legends', title: 'Легенды', legends: true, rules: ['🏆 Только легенды: Alumni и ICONS'] },
  { id: 'no-stars', title: 'Без звёзд', maxOvr: 85, rules: ['⭐ Карточки не выше 85 OVR'] },
  { id: 'one-club', title: 'Один за всех', oneClub: true, rules: [] },
  { id: 'current', title: 'Действующие', noLegends: true, rules: ['🏒 Только нынешние игроки — без Alumni и ICONS'] },
  { id: 'base-school', title: 'Базовая школа', baseOnly: true, rules: ['🃏 Только Base-карточки'] },
  { id: 'stars-stripes', title: 'Звёзды и полосы', nations: ['USA'], rules: ['🇺🇸 Только американцы'] },
  { id: 'outside-nhl', title: 'Вне НХЛ', outsideNhl: true, rules: ['🌍 АХЛ, Европа и юниоры — без НХЛ и легенд'] },
  { id: 'europe', title: 'Европейский экспресс', excludeNations: ['CANADA', 'USA'], rules: ['🇪🇺 Без канадцев и американцев'] },
  { id: 'cap3', title: 'Потолок $3M', maxSalary: 3, rules: ['💵 Каждая карточка не дороже $3M'] },
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
  const L = CHALLENGES.length;
  let ch = CHALLENGES[((n % L) + L) % L];
  if (ch.oneClub) {
    // клуб — следующий по списку при каждом новом круге челленджей
    const [team, ru] = ONE_CLUB[((Math.floor(n / L) % ONE_CLUB.length) + ONE_CLUB.length) % ONE_CLUB.length];
    ch = { ...ch, title: `Один за всех: ${ru}`, teams: [team], rules: [...ch.rules, `🏒 Только ${ru} и его легенды`] };
  }
  return { week: new Date(start).toISOString().slice(0, 10), ch, endsAt: Math.floor((start + WEEK - MSK) / 1000) };
}

export const teamKey = team => String(team || '').toUpperCase().replace(/\s+ALUMNI$/, '').trim();

const isLegend = p => p.league === 'NHLAA' || /\sALUMNI$/i.test(String(p.team || '')) || /ICONS/i.test(String(p.card || ''));

// p: { pos, ovr, team, nation, card, league, salary }
export function challengeAllows(ch, p) {
  if (ch.conference && !CONFERENCES[ch.conference].includes(teamKey(p.team))) return false;
  if (ch.teams && !ch.teams.includes(teamKey(p.team))) return false;
  if (ch.legends && !isLegend(p)) return false;
  if (ch.noLegends && isLegend(p)) return false;
  if (ch.baseOnly && !/^base$/i.test(String(p.card || '').trim())) return false;
  if (ch.outsideNhl && (p.league === 'NHL' || p.league === 'NHLAA')) return false;
  if (ch.maxSalary && p.salary > ch.maxSalary) return false;
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
  if (ch.cap && salary > ch.cap + 0.05) return `Зарплата $${salary.toFixed(1)}M — больше лимита $${ch.cap}M`;
  return null;
}

// Правила генератора вариантов (draft-core.js) для челленджа: только подходящие карточки, без лимита зарплаты.
// Капитан тоже стоит в составе, поэтому и он — только из подходящих (draft-core добирает игроками, если капитанов мало).
// byId: { [id]: карточка с клубом, страной, типом, лигой } — у приложения и сервера свой, данные те же.
export function challengeRules(ch, byId) {
  return {
    key: `ch:${ch.id}:${(ch.teams || []).join('|')}`,
    cap: ch.cap || Infinity,
    salBonus: false,
    allow: id => { const p = byId[id]; return !!p && challengeAllows(ch, p); },
  };
}
