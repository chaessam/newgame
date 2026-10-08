import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeNick, identityError, nickError } from '../public/js/identity.js';
import { hasProfanity } from '../public/js/profanity.js';
import { indexSchools, searchSchools, countSameName, baseName, shortSido, placeOf, currentSido } from '../public/js/schools.js';
import { sigunguOf } from '../scripts/update-schools.mjs';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/schools-sample.json', import.meta.url)));
const idx = indexSchools(sample);

test('학교 검색: "송우", "송우초", "송우 초등학교" 모두 같은 결과, 정확히 같은 이름이 먼저', () => {
  for (const q of ['송우', '송우초', '송우 초등학교', ' 송우초등학교 ']) {
    const names = searchSchools(idx, q).map((s) => s.code);
    assert.deepEqual(names.slice(0, 2).sort(), ['T000001', 'T000002'], q);
    assert.equal(names.length, 4, q); // 분교장과 '남송우'도 함께 나옴
  }
  assert.equal(searchSchools(idx, '').length, 0);
  assert.equal(searchSchools(idx, '없는학교').length, 0);
});

test('같은 이름의 학교는 위치로 구분한다', () => {
  assert.equal(countSameName(idx, '송우초등학교'), 2);
  const places = searchSchools(idx, '송우초').slice(0, 2).map(placeOf).sort();
  assert.deepEqual(places, ['경기 포천시', '전남광주 광산구']); // 목록 파일의 옛 '광주'도 지금 이름으로
});

test('학교 이름/주소 다듬기', () => {
  assert.equal(baseName('송우초등학교'), '송우');
  assert.equal(shortSido('경기도'), '경기');
  assert.equal(shortSido('서울특별시'), '서울');
  assert.equal(shortSido('전북특별자치도'), '전북');
  // 2026년 7월 1일 전남광주통합특별시 출범: 옛 광주·전남 모두 "전남광주"
  assert.equal(shortSido('전남광주통합특별시(광주)'), '전남광주');
  assert.equal(shortSido('전남광주통합특별시(전남)'), '전남광주');
  assert.equal(shortSido('전남광주통합특별시'), '전남광주');
  assert.equal(shortSido('광주광역시'), '전남광주'); // CSV로 만들 때
  assert.equal(shortSido('전라남도'), '전남광주');
  assert.equal(currentSido('광주'), '전남광주');
  assert.equal(currentSido('전남'), '전남광주');
  assert.equal(currentSido('전북'), '전북');
  assert.equal(currentSido('경기'), '경기');
  assert.equal(sigunguOf('경기도 포천시 소흘읍 송우로 1'), '포천시');
  assert.equal(sigunguOf('경기도 수원시 장안구 정자로 1'), '수원시 장안구');
  assert.equal(sigunguOf('세종특별자치시 한누리대로 1'), '');
});

test('CSV에서 운영 중인 초등학교만 가져온다', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = new URL('../public/data/schools.json', import.meta.url);
  const backup = fs.existsSync(out) ? fs.readFileSync(out) : null;
  try {
    execFileSync('node', ['scripts/update-schools.mjs', '--csv', 'test/fixtures/schools-sample.csv'], { stdio: 'pipe' });
    const data = JSON.parse(fs.readFileSync(out));
    assert.deepEqual(data.schools.map((s) => s[0]).sort(), ['B1', 'B4']);
    assert.deepEqual(data.schools.find((s) => s[0] === 'B4'), ['B4', '수원 "별" 초등학교', '경기', '수원시 장안구']);
  } finally {
    if (backup) fs.writeFileSync(out, backup); else fs.rmSync(out);
  }
});

test('닉네임 규칙과 비속어 거르기', () => {
  assert.equal(normalizeNick('  민준  '), '민준');
  assert.equal(nickError('민준'), null);
  assert.ok(nickError('민'));
  for (const bad of ['씨발', '씨 1 발', 'ㅅㅂ', '개 새 끼', 'f.u.c.k', '18놈', '관리자']) assert.ok(hasProfanity(bad), bad);
  for (const ok of ['민준', '시발점왕', '호로록', '강아지새끼', '구구단 대결', '송우초 대결']) assert.equal(hasProfanity(ok), false, ok);
  assert.ok(nickError('병신'));
});

test('학교를 고르고 닉네임을 적어야 랭킹에 기록한다', () => {
  assert.equal(identityError({ schoolCode: 'T000001', nick: '민준' }), null);
  assert.ok(identityError({ schoolCode: '', nick: '민준' }));
  assert.ok(identityError({ schoolCode: 'T000001', nick: '민' }));
});

test('실제 학교 목록: 옛 광주·전남 학교는 "전남광주"로, 학교 코드는 그대로', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../public/data/schools.json', import.meta.url)));
  const real = indexSchools(data);
  const gakhwa = searchSchools(real, '각화초').find((s) => s.name === '각화초등학교');
  assert.equal(placeOf(gakhwa), '전남광주 북구');
  assert.equal(gakhwa.code, '7392135');
  const gageodo = searchSchools(real, '가거도').find((s) => s.name === '가거도초등학교');
  assert.equal(placeOf(gageodo), '전남광주 신안군');
  assert.equal(gageodo.code, '8722030');
  // 화면에 옛 이름이 남은 학교가 없음
  assert.equal(real.list.filter((s) => s.sido === '광주' || s.sido === '전남').length, 0);
});
