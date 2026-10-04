// 전국 초등학교 목록 만들기 → public/data/schools.json
//
// 방법 1) NEIS 교육정보 개방 포털 API (추천, https://open.neis.go.kr 에서 무료 인증키 발급)
//   NEIS_API_KEY=발급받은키 node scripts/update-schools.mjs
//
// 방법 2) 공공데이터포털 "전국초중등학교위치표준데이터" CSV 파일
//   node scripts/update-schools.mjs --csv 내려받은파일.csv
//
// 1년에 한 번(새 학교가 문을 여는 3월쯤) 다시 실행하면 됩니다.
// 주의: 랭킹은 학교 코드로 저장되므로, 한 번 정한 방법을 계속 쓰세요.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortSido } from '../public/js/schools.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'schools.json');

// "경기도 포천시 소흘읍 송우로 1" → "포천시", "경기도 수원시 장안구 ..." → "수원시 장안구"
export function sigunguOf(address) {
  const parts = String(address || '').trim().split(/\s+/).slice(1);
  const out = [];
  for (const p of parts) {
    if (/(시|군|구)$/.test(p) && out.length < 2) out.push(p);
    else break;
  }
  return out.join(' ');
}

async function fromNeis(key) {
  const rows = [];
  for (let page = 1; page < 50; page++) {
    const url = new URL('https://open.neis.go.kr/hub/schoolInfo');
    url.search = new URLSearchParams({
      KEY: key, Type: 'json', pIndex: String(page), pSize: '1000', SCHUL_KND_SC_NM: '초등학교',
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NEIS 응답 오류: ${res.status}`);
    const data = await res.json();
    if (!data.schoolInfo) {
      const r = data.RESULT || {};
      if (r.CODE === 'INFO-200') break; // 더 이상 데이터 없음
      throw new Error(`NEIS 오류: ${r.CODE} ${r.MESSAGE}`);
    }
    const total = data.schoolInfo[0].head[0].list_total_count;
    const pageRows = data.schoolInfo[1].row || [];
    rows.push(...pageRows);
    console.log(`  ${rows.length} / ${total}`);
    if (rows.length >= total || pageRows.length < 1000) break;
  }
  return rows.map((r) => [
    r.SD_SCHUL_CODE,
    r.SCHUL_NM,
    shortSido(r.LCTN_SC_NM || String(r.ORG_RDNMA || '').split(/\s+/)[0]),
    sigunguOf(r.ORG_RDNMA),
  ]);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function fromCsv(file) {
  const buf = fs.readFileSync(file);
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('euc-kr').decode(buf); // 공공데이터는 EUC-KR인 경우가 많음
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const col = (...names) => head.findIndex((h) => names.includes(h.trim()));
  const iId = col('학교ID', '표준학교코드', '학교코드');
  const iName = col('학교명');
  const iKind = col('학교급구분', '학교급', '학교종류명');
  const iState = col('운영상태');
  const iAddr = col('소재지도로명주소', '도로명주소', '소재지지번주소');
  if (iId < 0 || iName < 0 || iAddr < 0) throw new Error(`CSV 열을 찾을 수 없어요: ${head.join(', ')}`);
  return rows
    .filter((r) => (iKind < 0 || r[iKind].trim() === '초등학교') && (iState < 0 || ['운영', ''].includes(r[iState].trim())))
    .map((r) => {
      const addr = r[iAddr].trim();
      return [r[iId].trim(), r[iName].trim(), shortSido(addr.split(/\s+/)[0]), sigunguOf(addr)];
    });
}

async function main() {
  const csvAt = process.argv.indexOf('--csv');
  let schools, source;
  if (csvAt > 0) {
    schools = fromCsv(process.argv[csvAt + 1]);
    source = `CSV: ${path.basename(process.argv[csvAt + 1])}`;
  } else if (process.env.NEIS_API_KEY) {
    console.log('NEIS에서 초등학교 목록을 받는 중...');
    schools = await fromNeis(process.env.NEIS_API_KEY);
    source = 'NEIS 교육정보 개방 포털 학교기본정보';
  } else {
    console.error('NEIS_API_KEY 환경 변수 또는 --csv 파일을 주세요. (파일 맨 위 설명 참고)');
    process.exit(1);
  }
  const seen = new Set();
  schools = schools
    .filter((s) => s[0] && s[1] && !seen.has(s[0]) && seen.add(s[0]))
    .sort((a, b) => a[1].localeCompare(b[1], 'ko') || a[2].localeCompare(b[2], 'ko'));
  const data = { updated: new Date().toISOString().slice(0, 10), source, count: schools.length, schools };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(data).replace(/\],\[/g, '],\n[')}\n`);
  console.log(`완료: 초등학교 ${schools.length}곳 → ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
