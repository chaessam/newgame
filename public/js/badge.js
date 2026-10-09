// 티어 이름표 (롤 랭크처럼 이름 옆에 따라다님) + 대표 칭호
import { tierInfo } from './tiers.js';
import { titleInfo } from './titles.js';

// 티어 문장 (방패 + 보석, 마스터부터는 왕관, 그랜드마스터·챌린저는 날개)
export function tierEmblem(tierId) {
  const t = tierInfo(tierId);
  if (t.id === 'admin') {
    // 운영자: 빛줄기가 퍼지는 별
    return '<svg class="np-emb" viewBox="-1 0 26 24" aria-hidden="true">'
      + '<path class="e-ray" d="M12 .5v4M12 19.5v4M.5 12h4M19.5 12h4M3.9 3.9l2.8 2.8M17.3 17.3l2.8 2.8M3.9 20.1l2.8-2.8M17.3 6.7l2.8-2.8"/>'
      + '<path class="e-star" d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z"/>'
      + '<circle class="e-core" cx="12" cy="12" r="2.6"/>'
      + '</svg>';
  }
  const crown = t.order >= 5
    ? '<path class="e-crown" d="M7.2 3.2 9.6 5.4 12 1.6 14.4 5.4 16.8 3.2 16 6.6H8z"/>'
    : '';
  const wings = t.order >= 6
    ? '<path class="e-wing" d="M3 7.5C.6 9 -.6 12 .2 15.5 1.4 13.6 2.4 12.8 3.4 12.6zM21 7.5c2.4 1.5 3.6 4.5 2.8 8-1.2-1.9-2.2-2.7-3.2-2.9z"/>'
    : '';
  return `<svg class="np-emb" viewBox="-1 0 26 24" aria-hidden="true">${wings}`
    + '<path class="e-out" d="M12 3.5 20.5 6.6V12c0 5-3.6 8.6-8.5 10C7.1 20.6 3.5 17 3.5 12V6.6z"/>'
    + '<path class="e-in" d="M12 6.2 18 8.4V12c0 3.6-2.5 6.3-6 7.4-3.5-1.1-6-3.8-6-7.4V8.4z"/>'
    + '<path class="e-gem" d="M12 8.6 15 12.4 12 16.6 9 12.4z"/>'
    + `${crown}</svg>`;
}

// 이름표 요소: [문장 이름] + (칭호)
// opts.title: 칭호 id, opts.small: 작게, opts.suffix: 이름 뒤 작은 글씨 (예: "(나)")
export function nameplate(name, tierId, opts) {
  opts = opts || {};
  const t = tierInfo(tierId);
  const wrap = document.createElement('span');
  wrap.className = 'np-wrap';
  const plate = document.createElement('span');
  plate.className = `np t-${t.id}${opts.small ? ' np-sm' : ''}`;
  plate.title = t.name;
  plate.innerHTML = tierEmblem(t.id);
  const nm = document.createElement('span');
  nm.className = 'np-name';
  nm.textContent = name;
  plate.appendChild(nm);
  if (opts.suffix) {
    const sx = document.createElement('small');
    sx.className = 'np-suffix';
    sx.textContent = opts.suffix;
    plate.appendChild(sx);
  }
  wrap.appendChild(plate);
  const ti = opts.title ? titleInfo(opts.title) : null;
  if (ti) {
    const tt = document.createElement('span');
    tt.className = `np-title${ti.special ? ' admin-title' : ''}`;
    tt.textContent = `${ti.icon} ${ti.name}`;
    wrap.appendChild(tt);
  }
  return wrap;
}

// 티어 이름만 (예: 결과 화면 "골드")
export function tierChip(tierId) {
  const t = tierInfo(tierId);
  const el = document.createElement('span');
  el.className = `np np-chip t-${t.id}`;
  el.innerHTML = tierEmblem(t.id);
  const nm = document.createElement('span');
  nm.className = 'np-name';
  nm.textContent = t.name;
  el.appendChild(nm);
  return el;
}
