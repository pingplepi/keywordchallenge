const sourceHeaders = {
  'content-type': 'application/json',
  'x-api-level': '11',
  'inf-fe-version': '2026.09.16',
};
const query = `query getParticipatedKeywords($input: ParticipatedKeywordsInput!, $paging: PagingInput!) {
  participatedKeywords(input: $input, paging: $paging) {
    items {
      categoryId id lastChallengedAt name rank viewCount challengeCount ownerId
      contents { id title url challengedAt createdAt serviceType }
    }
    paging { nextCursor total }
  }
}`;

export class CollectionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

async function sourceJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', headers: sourceHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25_000), redirect: 'error',
  });
  if (response.status === 404) throw new CollectionError(404, '인플홈을 찾지 못했습니다. 주소나 아이디를 확인해 주세요.');
  if (response.status === 429) throw new CollectionError(429, '네이버 요청이 잠시 제한되었습니다. 잠시 후 다시 수집해 주세요.');
  if (!response.ok) throw new CollectionError(502, '지금은 네이버의 공개 목록을 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.');
  const result = await response.json();
  if (result?.errors?.length) throw new CollectionError(502, '네이버 목록 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result;
}

function compact(row: Record<string, any>, ownerId: number) {
  if (!row || row.id == null || !row.name || String(row.ownerId) !== String(ownerId)) {
    throw new CollectionError(502, '인플홈 정보와 수집 결과가 일치하지 않아 수집을 중단했습니다.');
  }
  const latest = Array.isArray(row.contents) ? row.contents[0] : null;
  return {
    id: String(row.id), categoryId: String(row.categoryId), name: String(row.name),
    ownerId: String(ownerId), lastChallengedAt: row.lastChallengedAt,
    rank: Number.isFinite(row.rank) && row.rank > 0 ? row.rank : null,
    viewCount: row.viewCount, challengeCount: row.challengeCount,
    contents: latest ? [{
      id: String(latest.id), title: latest.title, url: latest.url,
      challengedAt: latest.challengedAt, createdAt: latest.createdAt,
      serviceType: latest.serviceType,
    }] : [],
  };
}

export async function collectProfilePage(id: string, cursor: string | null) {
    const space = await sourceJson(`https://gw.in.naver.com/home/api/v1/space-by-url-id?urlId=${encodeURIComponent(id)}`);
    if (String(space.urlId).toLowerCase() !== id || !Number.isSafeInteger(space.ownerId) || space.ownerId <= 0) {
      throw new CollectionError(404, '해당 주소의 인플홈 정보를 확인하지 못했습니다.');
    }
    const result = await sourceJson('https://in.naver.com/graphql', {
      operationName: 'getParticipatedKeywords', query,
      variables: {
        input: { sort: 'LAST_UPDATE', ownerId: space.ownerId },
        paging: { limit: 100, ...(cursor !== null ? { cursor } : {}) },
      },
    });
    const page = result?.data?.participatedKeywords;
    // Naver includes the total on the first page and returns null on later pages.
    const total = page?.paging?.total;
    const validTotal = Number.isInteger(total) && total >= 0 && total <= 200000;
    if (!Array.isArray(page?.items) || !page?.paging || page.items.length > 100
        || (!validTotal && !(cursor !== null && total === null))) {
      throw new CollectionError(502, '네이버의 목록 형식이 변경되어 수집할 수 없습니다.');
    }
    return {
      influencerId: id, ownerId: String(space.ownerId),
      total, items: page.items.map((row: Record<string, any>) => compact(row, space.ownerId)),
      nextCursor: page.paging.nextCursor == null ? null : String(page.paging.nextCursor),
      collectedAt: new Date().toISOString(),
    };
}

const catalogQuery = `query getSearchCategoryKeywords($input: SearchKeywordInput!, $paging: PagingInput!) {
  searchCategoryKeywords(input: $input, paging: $paging) {
    items { ... on Keyword { categoryId id name participantCount } }
    paging { nextCursor total }
  }
}`;
export async function categories() {
  const groups = await sourceJson('https://gw.in.naver.com/keyword-challenge/api/v1/category-groups');
  if (!Array.isArray(groups)) throw new CollectionError(502, '분야 목록 형식이 변경되었습니다.');
  const fields = groups.flatMap(g => g.categories.map((c: any) => ({...c, group: g.name})));
  if (!fields.length || fields.length > 100 || fields.some(c => !Number.isSafeInteger(c.id) || !c.name || !Number.isInteger(c.keywordCount))) {
    throw new CollectionError(502, '분야 목록 형식이 변경되었습니다.');
  }
  return fields;
}
export async function missions(categoryId: number) {
  const result = await sourceJson(`https://gw.in.naver.com/keyword-challenge/api/v2/categories/${categoryId}/mission-keywords?categoryId=${categoryId}`);
  if (!Array.isArray(result?.data)) throw new CollectionError(502, '미션 키워드 형식이 변경되었습니다.');
  return result.data;
}
export async function catalogPage(categoryId: number, cursor: string | null, limit: number) {
  const result = await sourceJson('https://in.naver.com/graphql', {
    operationName: 'getSearchCategoryKeywords', query: catalogQuery,
    variables: { input: { categoryId, name: '' }, paging: { limit, ...(cursor === null ? {} : {cursor}) } },
  });
  const page = result?.data?.searchCategoryKeywords;
  if (!Array.isArray(page?.items) || !page.paging || page.items.length > limit) {
    throw new CollectionError(502, '공용 목록 형식이 변경되었습니다.');
  }
  return page;
}
