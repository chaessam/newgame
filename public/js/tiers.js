// 티어 (온라인 대결만 반영) — 서버와 화면이 함께 씀
// 이기면 +25점, 지면 -10점. 지금 티어 아래로는 떨어지지 않음(강등 보호).
// 그랜드마스터·챌린저는 점수가 아니라 순위: 마스터(1000점 이상) 중 전국 TOP 30 / TOP 10.

export const RP_WIN = 25;
export const RP_LOSE = 10;
export const RP_SEED_PER_WIN = 15; // 티어가 생기기 전 기록: 승리 1번에 15점으로 시작
export const MASTER_RP = 1000;
export const GRANDMASTER_TOP = 30;
export const CHALLENGER_TOP = 10;

// 점수로 정해지는 티어 (낮은 것부터)
export const TIERS = [
  { id: 'bronze', name: '브론즈', min: 0 },
  { id: 'silver', name: '실버', min: 100 },
  { id: 'gold', name: '골드', min: 250 },
  { id: 'platinum', name: '플래티넘', min: 450 },
  { id: 'diamond', name: '다이아', min: 750 },
  { id: 'master', name: '마스터', min: MASTER_RP },
];
// 순위로 정해지는 티어
export const RANK_TIERS = [
  { id: 'grandmaster', name: '그랜드마스터', min: MASTER_RP, top: GRANDMASTER_TOP },
  { id: 'challenger', name: '챌린저', min: MASTER_RP, top: CHALLENGER_TOP },
];
export const ALL_TIERS = TIERS.concat(RANK_TIERS);
const BY_ID = {};
ALL_TIERS.forEach((t, i) => { BY_ID[t.id] = Object.assign({ order: i }, t); });
// 운영자 이름표 (랭크와 상관없이, 서버가 운영자 계정에만 붙임)
BY_ID.admin = { id: 'admin', name: '운영자', min: 0, order: 100, special: true };

export function tierInfo(id) {
  return BY_ID[id] || BY_ID.bronze;
}

// 점수만으로 정한 티어
export function pointTier(rp) {
  let t = TIERS[0];
  for (const x of TIERS) if (rp >= x.min) t = x;
  return t;
}

// rpRank: 마스터 이상 학생 중 점수 순위 (없으면 null)
export function tierOf(rp, rpRank) {
  rp = rp || 0;
  if (rp >= MASTER_RP && rpRank) {
    if (rpRank <= CHALLENGER_TOP) return BY_ID.challenger;
    if (rpRank <= GRANDMASTER_TOP) return BY_ID.grandmaster;
  }
  return BY_ID[pointTier(rp).id];
}

// 한 판 결과를 점수에 반영 (강등 보호: 지금 점수 티어의 시작 점수 아래로는 안 내려감)
export function applyResult(rp, win) {
  rp = rp || 0;
  if (win) return rp + RP_WIN;
  return Math.max(pointTier(rp).min, rp - RP_LOSE);
}

// 다음 티어까지: { next, need, progress(0~1) } — 마스터부터는 순위 티어라 null
export function nextTier(rp) {
  rp = rp || 0;
  const cur = pointTier(rp);
  const i = TIERS.indexOf(cur);
  const next = TIERS[i + 1];
  if (!next) return null;
  return { next: BY_ID[next.id], need: next.min - rp, progress: (rp - cur.min) / (next.min - cur.min) };
}

// 주간 랭킹의 주: 한국 시간 월요일 0시에 시작. 그 주 월요일 날짜 ("2026-10-05")
const KST_MS = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
export function weekKey(now) {
  if (now == null) now = Date.now();
  const d = new Date(now + KST_MS);
  const fromMonday = (d.getUTCDay() + 6) % 7;
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - fromMonday * DAY_MS;
  return new Date(day).toISOString().slice(0, 10);
}
