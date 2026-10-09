import test from 'node:test';
import assert from 'node:assert/strict';
import { tierOf, applyResult, nextTier, pointTier, weekKey, RP_WIN, RP_LOSE } from '../public/js/tiers.js';
import { earnedTitles, displayTitle, TITLES } from '../public/js/titles.js';

test('티어 구간: 브론즈~마스터는 점수, 그랜드마스터·챌린저는 마스터 중 순위', () => {
  assert.equal(tierOf(0).id, 'bronze');
  assert.equal(tierOf(99).id, 'bronze');
  assert.equal(tierOf(100).id, 'silver');
  assert.equal(tierOf(250).id, 'gold');
  assert.equal(tierOf(450).id, 'platinum');
  assert.equal(tierOf(750).id, 'diamond');
  assert.equal(tierOf(1000).id, 'master');
  assert.equal(tierOf(1000, 31).id, 'master');
  assert.equal(tierOf(1000, 30).id, 'grandmaster');
  assert.equal(tierOf(1000, 11).id, 'grandmaster');
  assert.equal(tierOf(2970, 10).id, 'challenger');
  assert.equal(tierOf(2970, 1).id, 'challenger');
  assert.equal(tierOf(990, 1).id, 'diamond'); // 마스터 점수가 안 되면 순위가 높아도 아님
});

test('점수: 이기면 +25, 지면 -10, 지금 티어 아래로는 안 떨어짐', () => {
  assert.equal(RP_WIN, 25);
  assert.equal(RP_LOSE, 10);
  assert.equal(applyResult(300, true), 325);
  assert.equal(applyResult(300, false), 290);
  assert.equal(applyResult(255, false), 250); // 골드 바닥
  assert.equal(applyResult(250, false), 250);
  assert.equal(applyResult(1005, false), 1000); // 마스터 바닥
  assert.equal(applyResult(5, false), 0);
  assert.equal(pointTier(applyResult(100, false)).id, 'silver');
});

test('다음 티어까지 남은 점수', () => {
  assert.deepEqual([nextTier(0).next.id, nextTier(0).need], ['silver', 100]);
  assert.deepEqual([nextTier(300).next.id, nextTier(300).need], ['platinum', 150]);
  assert.equal(nextTier(1200), null);
});

test('주간 랭킹의 주는 한국 시간 월요일 0시에 바뀜', () => {
  // 2026-10-05(월) 00:00 KST = 2026-10-04 15:00 UTC
  assert.equal(weekKey(Date.UTC(2026, 9, 4, 14, 59)), '2026-09-28'); // 일요일 밤 23:59 KST
  assert.equal(weekKey(Date.UTC(2026, 9, 4, 15, 0)), '2026-10-05');  // 월요일 0시 KST
  assert.equal(weekKey(Date.UTC(2026, 9, 11, 14, 0)), '2026-10-05'); // 그 주 일요일 23시 KST
});

test('칭호: 승리·연승·순위 조건', () => {
  const base = { wins: 0, games: 0, bestStreak: 0 };
  assert.deepEqual(earnedTitles(base), []);
  assert.deepEqual(earnedTitles({ ...base, wins: 1, games: 1, bestStreak: 1 }), ['first_win']);
  const many = earnedTitles({ wins: 198, games: 300, bestStreak: 6, winsRank: 1, rateRank: 3, weekRank: 2, champion: true, schoolAce: true, bestSchool: true });
  assert.equal(many[0], 'legend'); // 가장 높은 칭호가 먼저
  for (const id of ['legend', 'hall', 'champion', 'rate10', 'week10', 'school_ace', 'top100', 'best_school', 'win100', 'win50', 'win10', 'first_win', 'streak3', 'streak5', 'games100']) {
    assert.ok(many.includes(id), id);
  }
  assert.ok(!many.includes('win300'));
  assert.ok(earnedTitles({ ...base, wins: 5, winsRank: 50 }).includes('top100'));
  assert.ok(!earnedTitles({ ...base, wins: 5, winsRank: 50 }).includes('hall'));
  // 곧 열리는 칭호는 얻을 수 없음
  const soon = TITLES.filter((t) => t.soon).map((t) => t.id);
  assert.ok(soon.length > 0);
  assert.ok(soon.every((id) => !many.includes(id)));
});

test('대표 칭호: 고른 칭호가 있으면 그것, 없으면 가장 높은 칭호, none이면 안 닮', () => {
  assert.equal(displayTitle('win10', ['hall', 'win10']), 'win10');
  assert.equal(displayTitle('legend', ['hall', 'win10']), 'hall'); // 순위에서 밀려 사라진 칭호
  assert.equal(displayTitle('', ['hall', 'win10']), 'hall');
  assert.equal(displayTitle('none', ['hall']), '');
  assert.equal(displayTitle('', []), '');
});

test('운영자: 운영자 이름표와 칭호', async () => {
  const { tierInfo } = await import('../public/js/tiers.js');
  assert.equal(tierInfo('admin').name, '운영자');
  const t = earnedTitles({ admin: true, wins: 0, games: 0, bestStreak: 0 });
  assert.equal(t[0], 'operator');
  assert.ok(!earnedTitles({ wins: 300, games: 400, bestStreak: 9, winsRank: 1 }).includes('operator'));
});
