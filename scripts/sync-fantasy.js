// Fantasy Hockey: карточки получают +1 OVR за каждый гол игрока в реальном матче НХЛ.
// Скрипт находит игроков этих карточек в api-web.nhle.com и сохраняет data/fantasy.json:
// голы и очки за сезон, последние матчи, следующий матч, а также историю OVR карточки
// (по данным hutdb — запоминаем каждое изменение рейтинга).
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'fantasy.json');
const API = 'https://api-web.nhle.com/v1';
const CARD = 'Fantasy Hockey';

const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

async function get(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return res.json();
      if (res.status === 404) return null;
    } catch {}
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function main() {
  const players = JSON.parse(fs.readFileSync(path.join(DATA, 'players.json'), 'utf8'));
  const cards = players.filter(p => p.card === CARD);
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { players: {} };
  const now = Math.floor(Date.now() / 1000);

  const standings = await get(`${API}/standings/now`);
  if (!standings?.standings?.length) throw new Error('NHL standings unavailable');
  const abbrevOf = new Map(standings.standings.map(t => [norm(t.teamName.default), t.teamAbbrev.default]));

  // Ростеры команд, в которых есть карточки Fantasy.
  const rosters = new Map();
  for (const abbrev of new Set(cards.map(p => abbrevOf.get(norm(p.team))).filter(Boolean))) {
    const r = await get(`${API}/roster/${abbrev}/current`);
    const list = r ? [...(r.forwards || []), ...(r.defensemen || []), ...(r.goalies || [])] : [];
    rosters.set(abbrev, list);
  }
  const findInRoster = (p, abbrev) => (rosters.get(abbrev) || [])
    .find(q => norm(`${q.firstName.default}${q.lastName.default}`) === norm(p.name));

  // Игрок мог перейти в другую команду или быть в АХЛ — ищем по всем ростерам и в поиске НХЛ.
  async function nhlIdFor(p) {
    if (prev.players[p.id]?.nhlId) return prev.players[p.id].nhlId;
    const abbrev = abbrevOf.get(norm(p.team));
    let q = abbrev && findInRoster(p, abbrev);
    if (!q) for (const a of rosters.keys()) if ((q = findInRoster(p, a))) break;
    if (q) return q.id;
    const found = await get(`https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(p.name.toLowerCase())}`);
    const hit = (found || []).find(x => norm(x.name) === norm(p.name) && x.active) || (found || []).find(x => norm(x.name) === norm(p.name));
    return hit ? Number(hit.playerId) : null;
  }

  const schedules = new Map();
  async function nextGame(abbrev) {
    if (!abbrev) return null;
    if (!schedules.has(abbrev)) {
      const s = await get(`${API}/club-schedule/${abbrev}/week/now`);
      const g = (s?.games || []).find(g => !['OFF', 'FINAL'].includes(g.gameState));
      schedules.set(abbrev, g ? {
        t: Math.floor(Date.parse(g.startTimeUTC) / 1000),
        opp: g.homeTeam.abbrev === abbrev ? g.awayTeam.abbrev : g.homeTeam.abbrev,
        home: g.homeTeam.abbrev === abbrev,
        live: ['LIVE', 'CRIT'].includes(g.gameState),
      } : null);
    }
    return schedules.get(abbrev);
  }

  const out = { updated: now, players: {} };
  let matched = 0, failed = 0;
  for (const p of cards) {
    const old = prev.players[p.id] || {};
    const history = old.history?.length ? old.history : [[now, p.ovr]];
    if (history.at(-1)[1] !== p.ovr) history.push([now, p.ovr]);
    const row = { history };

    const nhlId = await nhlIdFor(p);
    if (nhlId) {
      matched++;
      const [log, landing] = await Promise.all([get(`${API}/player/${nhlId}/game-log/now`), get(`${API}/player/${nhlId}/landing`)]);
      if (!log) {
        // НХЛ не ответил — оставляем прошлые данные игрока, а не нули.
        failed++;
        out.players[p.id] = { ...old, history, nhlId };
        continue;
      }
      const games = (log.gameLog || []).filter(g => g.gameDate);
      const team = landing?.currentTeamAbbrev || abbrevOf.get(norm(p.team)) || null;
      Object.assign(row, {
        nhlId,
        team,
        gp: games.length,
        goals: games.reduce((t, g) => t + (g.goals || 0), 0),
        assists: games.reduce((t, g) => t + (g.assists || 0), 0),
        // последние матчи: [дата, голы, передачи, соперник, дома]
        last: games.sort((a, b) => b.gameDate.localeCompare(a.gameDate)).slice(0, 8)
          .map(g => [g.gameDate, g.goals || 0, g.assists || 0, g.opponentAbbrev, g.homeRoadFlag === 'H']),
        next: (await nextGame(team)) ?? (old.next?.t > now - 4 * 3600 ? old.next : null),
      });
      await new Promise(r => setTimeout(r, 150));
    }
    out.players[p.id] = row;
  }
  if (matched < cards.length * 0.7) throw new Error(`matched only ${matched}/${cards.length}`);
  if (failed > matched * 0.3) throw new Error(`NHL API failed for ${failed}/${matched} players`);
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`fantasy: ${cards.length} cards, ${matched} matched to NHL players, ${failed} kept from previous sync`);
}

main().catch(err => { console.error(err); process.exit(1); });
