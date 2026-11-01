// Values match the catalog fields used by dashboard and keyword recommendation queries.
export const INTEREST_FIELDS = [
  { value: '여행', seeds: ['국내여행', '해외여행', '여행준비'] },
  { value: '패션', seeds: ['여성패션', '남성패션', '패션잡화'] },
  { value: '뷰티', seeds: ['스킨케어', '메이크업', '헤어케어'] },
  { value: '푸드', seeds: ['레시피', '맛집', '카페'] },
  { value: 'IT테크', seeds: ['스마트폰', '노트북', 'AI활용'] },
  { value: '자동차', seeds: ['전기차', '중고차', '자동차용품'] },
  { value: '리빙', seeds: ['살림', '인테리어', '생활용품'] },
  { value: '육아', seeds: ['육아용품', '육아놀이', '아이랑가볼만한곳'] },
  { value: '생활건강', seeds: ['건강관리', '건강식단', '수면'] },
  { value: '게임', seeds: ['모바일게임', 'PC게임', '콘솔게임'] },
  { value: '동물/펫', seeds: ['강아지용품', '고양이용품', '반려동물'] },
  { value: '운동/레저', seeds: ['운동', '등산', '캠핑'] },
  { value: '프로스포츠', seeds: ['프로야구', '프로축구', '프로농구'] },
  { value: '방송/연예', seeds: ['드라마', '예능', '방송추천'] },
  { value: '대중음악', seeds: ['신곡', '음악추천', '콘서트'] },
  { value: '영화', seeds: ['영화추천', '개봉영화', '영화리뷰'] },
  { value: '공연/전시/예술', label: '공연/전시', seeds: ['전시회', '뮤지컬', '공연'] },
  { value: '도서', seeds: ['책추천', '독서', '독서모임'] },
  { value: '경제/비즈니스', seeds: ['생활경제', '창업', '마케팅'] },
  { value: '어학/교육', seeds: ['영어공부', '자격증', '학습법'] },
  { value: '기타', seeds: [] },
];

export function normalizeInterestField(value) {
  // Keep the previous selection when members open settings created before the full list.
  return value === '문화/예술' ? '공연/전시/예술' : value || '';
}

export const DASHBOARD_FIELDS = [{ value: '', label: '모든 분야' }, ...INTEREST_FIELDS];

export function defaultDashboardField(interest) {
  const value = normalizeInterestField(interest);
  return INTEREST_FIELDS.some(field => field.value === value) ? value : '';
}
