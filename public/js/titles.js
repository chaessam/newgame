// 칭호 — 서버와 화면이 함께 씀
// 얻은 칭호 중 하나를 대표 칭호로 골라 이름표 옆에 달아요. (고르지 않으면 가장 높은 칭호)
// rank: 순위 칭호(순위에서 밀리면 사라짐). soon: 다음 업데이트에서 열리는 칭호(지금은 목록에만 보임).

export const TITLE_GROUPS = [
  { id: 'rank', name: '🏅 순위' },
  { id: 'week', name: '📅 이번 주' },
  { id: 'win', name: '🏆 승리' },
  { id: 'battle', name: '⚔️ 대결' },
  { id: 'chain', name: '🔥 연쇄' },
  { id: 'answer', name: '🧠 정답' },
  { id: 'skill', name: '⚡ 실력' },
  { id: 'daily', name: '📆 성실' },
  { id: 'robot', name: '🤖 컴퓨터' },
];

// 위에 있을수록 높은 칭호 (대표 칭호를 고르지 않았을 때 이 순서로 정함)
export const TITLES = [
  { id: 'legend', group: 'rank', icon: '🌟', name: '구구팡 레전드', desc: '누적 승리 전국 1위', rank: true },
  { id: 'hall', group: 'rank', icon: '🏛️', name: '명예의 전당', desc: '누적 승리 전국 TOP 10', rank: true },
  { id: 'champion', group: 'week', icon: '🏆', name: '이번 주 챔피언', desc: '지난주 승리 1위 (이번 주 동안)', rank: true },
  { id: 'rate10', group: 'rank', icon: '🎯', name: '승률 장인', desc: '승률 랭킹 TOP 10', rank: true },
  { id: 'week10', group: 'week', icon: '📅', name: '주간 TOP 10', desc: '이번 주 승리 TOP 10', rank: true },
  { id: 'school_ace', group: 'rank', icon: '⭐', name: '우리 학교 에이스', desc: '우리 학교 승리 1위 (학교 친구 3명 이상)', rank: true },
  { id: 'top100', group: 'rank', icon: '💯', name: '전국 100인', desc: '누적 승리 전국 TOP 100', rank: true },
  { id: 'best_school', group: 'rank', icon: '🏫', name: '최강 학교', desc: '학교 랭킹 1위 학교의 학생', rank: true },
  { id: 'win300', group: 'win', icon: '🐉', name: '전설', desc: '온라인 대결 300승' },
  { id: 'win100', group: 'win', icon: '🛡️', name: '백승 장군', desc: '온라인 대결 100승' },
  { id: 'streak5', group: 'battle', icon: '⚡', name: '무적', desc: '온라인 대결 5연승' },
  { id: 'win50', group: 'win', icon: '⚔️', name: '승부사', desc: '온라인 대결 50승' },
  { id: 'games100', group: 'battle', icon: '🎖️', name: '백전노장', desc: '온라인 대결 100판' },
  { id: 'streak3', group: 'battle', icon: '🔥', name: '불꽃 연승', desc: '온라인 대결 3연승' },
  { id: 'win10', group: 'win', icon: '😋', name: '승리의 맛', desc: '온라인 대결 10승' },
  { id: 'first_win', group: 'win', icon: '🎉', name: '첫 승리', desc: '온라인 대결 첫 승리' },

  // 다음 업데이트에서 열리는 칭호
  { id: 'chain8', group: 'chain', icon: '🌋', name: '연쇄의 신', desc: '한 판에 8연쇄', soon: true },
  { id: 'chain6', group: 'chain', icon: '👑', name: '연쇄왕', desc: '한 판에 6연쇄', soon: true },
  { id: 'chain4', group: 'chain', icon: '🔥', name: '연쇄 장인', desc: '한 판에 4연쇄', soon: true },
  { id: 'chain2', group: 'chain', icon: '🌱', name: '연쇄 새싹', desc: '한 판에 2연쇄', soon: true },
  { id: 'answer3000', group: 'answer', icon: '🎓', name: '구구단 교수님', desc: '맞힌 문제 3,000개', soon: true },
  { id: 'answer1000', group: 'answer', icon: '🧠', name: '구구단 박사', desc: '맞힌 문제 1,000개', soon: true },
  { id: 'answer200', group: 'answer', icon: '🧭', name: '곱셈 탐험가', desc: '맞힌 문제 200개', soon: true },
  { id: 'answer50', group: 'answer', icon: '🌱', name: '구구단 새싹', desc: '맞힌 문제 50개', soon: true },
  { id: 'lightning', group: 'skill', icon: '⚡', name: '번개손', desc: '한 판에 10문제 이상, 평균 2초 안에 정답', soon: true },
  { id: 'perfect', group: 'skill', icon: '🎯', name: '백발백중', desc: '한 판에 20문제 이상, 하나도 틀리지 않기', soon: true },
  { id: 'allclear', group: 'skill', icon: '🧹', name: '싹쓸이', desc: '판을 전부 비우기 (올클리어)', soon: true },
  { id: 'wall', group: 'skill', icon: '🧱', name: '철벽 수비', desc: '방해 슬라임 누적 100개 막기', soon: true },
  { id: 'days3', group: 'daily', icon: '📆', name: '3일 연속', desc: '3일 연속 플레이', soon: true },
  { id: 'days10', group: 'daily', icon: '🏅', name: '개근상', desc: '10일 연속 플레이', soon: true },
  { id: 'robot10', group: 'robot', icon: '🦾', name: '로봇 박사', desc: '고급 로봇 10번 이기기', soon: true },
  { id: 'robot1', group: 'robot', icon: '🤖', name: '로봇 사냥꾼', desc: '고급 로봇 이기기', soon: true },
];

const BY_ID = {};
TITLES.forEach((t, i) => { BY_ID[t.id] = Object.assign({ order: i }, t); });
export function titleInfo(id) { return BY_ID[id] || null; }

// s: { wins, games, bestStreak, winsRank, rateRank, weekRank, champion, schoolAce, bestSchool }
// 얻은 칭호 id 목록 (높은 칭호부터)
export function earnedTitles(s) {
  const got = {
    legend: s.winsRank === 1,
    hall: !!s.winsRank && s.winsRank <= 10,
    champion: !!s.champion,
    rate10: !!s.rateRank && s.rateRank <= 10,
    week10: !!s.weekRank && s.weekRank <= 10,
    school_ace: !!s.schoolAce,
    top100: !!s.winsRank && s.winsRank <= 100,
    best_school: !!s.bestSchool,
    win300: s.wins >= 300,
    win100: s.wins >= 100,
    streak5: s.bestStreak >= 5,
    win50: s.wins >= 50,
    games100: s.games >= 100,
    streak3: s.bestStreak >= 3,
    win10: s.wins >= 10,
    first_win: s.wins >= 1,
  };
  return TITLES.filter((t) => got[t.id]).map((t) => t.id);
}

// 대표 칭호: 고른 칭호가 아직 있으면 그것, 아니면 가장 높은 칭호
export function displayTitle(chosen, earned) {
  if (chosen === 'none') return '';
  if (chosen && earned.indexOf(chosen) >= 0) return chosen;
  return earned[0] || '';
}
