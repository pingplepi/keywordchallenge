"""Download public keyword facts. No Naver login, cookies or personal data are used.

python3 scripts/fetch-naver-catalog.py /absolute/path/catalog.json
Import the resulting file through the site's catalog administrator panel.
"""
import datetime
import json
from pathlib import Path
import sys
import time
import urllib.request

HEADERS = {'content-type': 'application/json', 'x-api-level': '11',
           'inf-fe-version': '2026.09.16'}
QUERY = '''query getSearchCategoryKeywords($input: SearchKeywordInput!, $paging: PagingInput!) {
  searchCategoryKeywords(input: $input, paging: $paging) {
    items { ... on Keyword { categoryId id name participantCount } }
    paging { nextCursor total }
  }
}'''


def request(url, payload=None):
    req = urllib.request.Request(url, data=json.dumps(payload).encode() if payload else None,
                                 headers=HEADERS)
    with urllib.request.urlopen(req, timeout=45) as response:
        data = json.load(response)
    if isinstance(data, dict) and data.get('errors'):
        raise RuntimeError(data['errors'])
    return data


def collect(output):
    groups = request('https://gw.in.naver.com/keyword-challenge/api/v1/category-groups')
    categories = [{**c, 'group': g['name']} for g in groups for c in g['categories']]
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    checkpoint = output.with_suffix('.checkpoint.json')
    completed = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    all_items = {}
    coverage = []
    for category in categories:
        cid = str(category['id'])
        if cid in completed:
            result = completed[cid]
        else:
            rows = {}
            total = category['keywordCount']
            for pass_number in range(3):
                cursor, seen = None, set()
                while True:
                    paging = {'limit': 500}
                    if cursor is not None:
                        paging['cursor'] = cursor
                    page = request('https://in.naver.com/graphql', {
                        'operationName': 'getSearchCategoryKeywords', 'query': QUERY,
                        'variables': {'input': {'categoryId': category['id'], 'name': ''}, 'paging': paging}
                    })['data']['searchCategoryKeywords']
                    for item in page['items']:
                        if str(item['categoryId']) != cid:
                            raise RuntimeError('Unexpected keyword category')
                        rows[str(item['id'])] = {
                            'id': str(item['id']), 'name': item['name'], 'categoryId': cid,
                            'field': category['name'], 'fieldGroup': category['group'],
                            'participantCount': item.get('participantCount')
                        }
                    cursor = page['paging']['nextCursor']
                    total = page['paging']['total']
                    if not cursor:
                        break
                    if str(cursor) in seen or not page['items']:
                        raise RuntimeError('Pagination stopped before completion')
                    seen.add(str(cursor))
                    time.sleep(0.3)
                if len(rows) == total:
                    break
                print(f"{category['name']}: reconciling {len(rows):,} / {total:,}", flush=True)
            if len(rows) != total:
                raise RuntimeError(f"{category['name']}: expected {total}, received {len(rows)}; catalog was not published")
            result = {'total': total, 'items': list(rows.values())}
            completed[cid] = result
            checkpoint.write_text(json.dumps(completed, ensure_ascii=False))
        for item in result['items']:
            if item['id'] in all_items:
                raise RuntimeError('Duplicate keyword across categories')
            all_items[item['id']] = item
        coverage.append({'field': category['name'], 'count': result['total']})
        print(f"{category['name']}: {result['total']:,}", flush=True)
    data = {'version': '3.0', 'source': '네이버 공개 키워드 목록', 'coverage': 'all',
            'collectedAt': started, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'categories': coverage, 'items': list(all_items.values())}
    output.write_text(json.dumps(data, ensure_ascii=False))
    print(f"Saved {len(all_items):,} keywords / {len(categories)} fields to {output}", flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/fetch-naver-catalog.py /path/catalog.json')
    collect(Path(sys.argv[1]).resolve())
