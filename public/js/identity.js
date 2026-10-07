// 랭킹에 쓰는 학교 / 닉네임 규칙 (브라우저와 서버가 함께 사용)
import { hasProfanity } from './profanity.js';

export const MIN_GAMES_FOR_WINRATE = 10; // 승률 랭킹에 오르려면 필요한 판 수
export const MIN_GAME_SECONDS = 30;      // 이보다 짧은 판은 기록하지 않음

const strip = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>"'`\\]/g, '');

export function normalizeNick(s) {
  return strip(s).replace(/\s+/g, ' ').trim().slice(0, 10);
}

export function normalizeSchoolCode(s) {
  const v = String(s == null ? '' : s).trim();
  return /^[0-9A-Za-z]{4,12}$/.test(v) ? v : '';
}

// 닉네임에 문제가 있으면 안내 문장, 없으면 null
export function nickError(nick) {
  const v = normalizeNick(nick);
  if (v.length < 2) return '닉네임은 2글자 이상 적어 주세요.';
  if (hasProfanity(v)) return '사용할 수 없는 말이 들어 있어요. 다른 닉네임을 적어 주세요.';
  return null;
}

// 랭킹에 쓸 수 있는 정보인지 확인 (school: 검색해서 고른 학교 코드)
export function identityError({ schoolCode, nick }) {
  if (!normalizeSchoolCode(schoolCode)) return '학교를 검색해서 골라 주세요.';
  return nickError(nick);
}
