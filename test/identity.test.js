import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchool, normalizeNick, identityError, shortSchool } from '../public/js/identity.js';

test('학교 이름은 같은 형태로 맞춘다', () => {
  for (const s of ['한빛초', '한빛 초', '한빛초등학교', '한빛 초등학교', '한빛', '한빛초교', ' 한빛초 ']) {
    assert.equal(normalizeSchool(s), '한빛초등학교', s);
  }
  assert.equal(normalizeSchool(''), '');
  assert.equal(normalizeSchool('<script>'), 'script초등학교');
});

test('닉네임은 앞뒤 공백을 지우고 10글자까지', () => {
  assert.equal(normalizeNick('  민준  '), '민준');
  assert.equal(normalizeNick('가나다라마바사아자차카'), '가나다라마바사아자차');
});

test('지역·학교·닉네임이 모두 있어야 랭킹에 기록한다', () => {
  assert.equal(identityError({ region: '서울', school: '한빛초', nick: '민준' }), null);
  assert.ok(identityError({ region: '', school: '한빛초', nick: '민준' }));
  assert.ok(identityError({ region: '서울', school: '', nick: '민준' }));
  assert.ok(identityError({ region: '서울', school: '한빛초', nick: '민' }));
  assert.ok(identityError({ region: '화성', school: '한빛초', nick: '민준' }));
});

test('짧은 학교 이름 표시', () => {
  assert.equal(shortSchool('한빛초등학교'), '한빛초');
});
