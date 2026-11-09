// Данные для проверки драфта и челленджа на сервере: читаются из файлов сборки (_site/data)
// и держатся в памяти воркера 10 минут. После деплоя воркер стартует заново и читает новые файлы.

let cache = null;

export async function gameData(env) {
  if (cache && cache.at > Date.now() - 10 * 60e3) return cache.data;
  const get = name => env.ASSETS.fetch(new Request(`https://assets.local/data/${name}`)).then(r => r.json());
  const [draftPool, chal, combos, captains, coaches] = await Promise.all([
    get('draft-pool.json'), get('chal-pool.json'), get('combos.json'), get('captains.json'), get('coaches.json'),
  ]);
  const data = { draftPool, combos, captains, coaches, ...expandPlayers(chal) };
  cache = { data, at: Date.now() };
  return data;
}

// chal-pool.json → полные карточки (позиция, зарплата, рейтинг, клуб, страна, имя, тип, лига)
export function expandPlayers(chal) {
  const byId = {};
  for (const [id, pos, salary, ovr, t, n, name, c, l] of chal.players) {
    byId[id] = { id, pos, salary, ovr, team: chal.teams[t], nation: chal.nations[n], name, card: chal.cards[c], league: chal.leagues[l] };
  }
  return { byId };
}
