// 전국 초등학교 목록 불러오기 + 검색 (브라우저와 서버가 함께 사용)
// 목록 파일: public/data/schools.json  (scripts/update-schools.mjs 로 만듦)
// 형식: { updated, source, schools: [[학교코드, 학교명, 시도, 시군구], ...] }

export const SCHOOLS_PATH = '/data/schools.json';

// "경기도" → "경기", "서울특별시" → "서울", "전북특별자치도" → "전북"
const SIDO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주',
  대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기',
  강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남',
  전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
  제주특별자치도: '제주', 제주도: '제주',
};
export function shortSido(name) {
  const s = String(name || '').trim();
  return SIDO_SHORT[s] || s.replace(/(특별자치시|특별자치도|특별시|광역시)$/, '');
}

// "송우초등학교" → "송우"
export function baseName(name) {
  return String(name || '').replace(/\s+/g, '').replace(/(초등학교|초교|초)$/, '');
}

export function shortSchool(name) {
  return String(name || '').replace(/초등학교$/, '초');
}

// 화면에 보여 줄 위치: "경기 포천시"
export function placeOf(s) {
  return [s.sido, s.addr].filter(Boolean).join(' ');
}

export function indexSchools(data) {
  const list = [];
  const byCode = new Map();
  for (const row of (data && data.schools) || []) {
    const [code, name, sido, addr] = row;
    if (!code || !name) continue;
    const s = { code: String(code), name, sido: sido || '', addr: addr || '', base: baseName(name) };
    list.push(s);
    byCode.set(s.code, s);
  }
  return { list, byCode, updated: data && data.updated };
}

// "송우", "송우초", "송우 초등학교" 모두 같은 결과
export function searchSchools(index, query, limit = 30) {
  const q = baseName(query);
  if (!q) return [];
  const exact = [], starts = [], contains = [];
  for (const s of index.list) {
    if (s.base === q) exact.push(s);
    else if (s.base.startsWith(q)) starts.push(s);
    else if (s.base.includes(q)) contains.push(s);
    if (exact.length >= limit) break;
  }
  const byPlace = (a, b) => a.base.localeCompare(b.base, 'ko') || placeOf(a).localeCompare(placeOf(b), 'ko');
  return [...exact.sort(byPlace), ...starts.sort(byPlace), ...contains.sort(byPlace)].slice(0, limit);
}

// 같은 이름의 학교가 여러 곳인지
export function countSameName(index, name) {
  let n = 0;
  for (const s of index.list) if (s.name === name) n++;
  return n;
}
