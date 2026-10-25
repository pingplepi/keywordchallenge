// Text relevance is calculated by key:on, not an official NAVER relevance score.
export function rankKeywords(query, rows, sort = 'relevance') {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
  const needle = normalize(query);
  const tokens = [...new Set(String(query).trim().split(/\s+/).map(normalize).filter(Boolean))];
  const grams = value => new Set(value.length < 2 ? [value] : Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)));
  const queryGrams = grams(needle);
  const tokenLength = tokens.reduce((sum, token) => sum + token.length, 0);
  const scored = rows.map((row, index) => {
    const value = normalize(row.keyword);
    const hitLength = tokens.reduce((sum, token) => sum + (value.includes(token) ? token.length : 0), 0);
    const candidateGrams = grams(value);
    const overlap = [...queryGrams].filter(gram => candidateGrams.has(gram)).length;
    const tier = value === needle ? 3 : value.includes(needle) ? 2 : tokens.length > 1 && hitLength === tokenLength ? 1 : 0;
    return { row, index, exact: value === needle, tier, coverage: hitLength / (tokenLength || 1), similarity: 2 * overlap / (queryGrams.size + candidateGrams.size || 1) };
  });
  scored.sort((a, b) => sort === 'volume'
    ? Number(b.exact) - Number(a.exact) || (b.row.volume_min ?? -1) - (a.row.volume_min ?? -1) || a.index - b.index
    : b.tier - a.tier || b.coverage - a.coverage || b.similarity - a.similarity || a.index - b.index);
  return scored.map(({ row }) => row);
}
