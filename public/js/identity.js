// 랭킹에 쓰는 지역 / 학교 / 닉네임 규칙 (브라우저와 서버가 함께 사용)

export const REGIONS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
];

export const MIN_GAMES_FOR_WINRATE = 10; // 승률 랭킹에 오르려면 필요한 판 수
export const MIN_GAME_SECONDS = 30;      // 이보다 짧은 판은 기록하지 않음

const strip = (s) => String(s ?? '').replace(/[\u0000-\u001f<>"'`\\]/g, '');

// "한빛초", "한빛 초등학교", "한빛" → "한빛초등학교"
export function normalizeSchool(s) {
  let v = strip(s).replace(/\s+/g, '').slice(0, 20);
  if (!v) return '';
  if (v.endsWith('초등학교')) return v;
  if (v.endsWith('초교')) v = v.slice(0, -2);
  else if (v.endsWith('초')) v = v.slice(0, -1);
  return v ? `${v}초등학교` : '';
}

export function normalizeNick(s) {
  return strip(s).replace(/\s+/g, ' ').trim().slice(0, 10);
}

export function normalizeRegion(s) {
  return REGIONS.includes(s) ? s : '';
}

// 랭킹에 쓸 수 있는 정보인지 확인. 문제가 있으면 안내 문장, 없으면 null
export function identityError({ region, school, nick }) {
  if (!normalizeRegion(region)) return '지역을 골라 주세요.';
  if (normalizeSchool(school).length < 5) return '학교 이름을 적어 주세요.';
  if (normalizeNick(nick).length < 2) return '닉네임은 2글자 이상 적어 주세요.';
  return null;
}

export function shortSchool(school) {
  return school.endsWith('초등학교') ? `${school.slice(0, -4)}초` : school;
}
