import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { collectProfilePage, categories, missions, catalogPage, CollectionError } from './naver.ts';
import { fetchVolumes, SearchAdError } from '../_shared/searchad.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const now = () => new Date().toISOString();
async function result(query: any) {
  const value = await query;
  if (value.error) throw new Error(`Database operation failed (${value.error.code || 'unknown'})`);
  return value;
}
async function checkpoint(job: any, extra: Record<string, unknown> = {}) {
  const { data } = await result(db.from('keychallenge_sync_jobs')
    .update({ state: job.state, updated_at: now(), ...extra })
    .eq('id', job.id).eq('lease_token', job.lease_token).gt('lease_until', now()).select('id'));
  if (!data?.length) throw new Error('Worker lease expired');
}
async function status(job: any, value: string, error: string | null = null) {
  if (job.kind === 'profile') {
    await result(db.from('keychallenge_profiles').update({ scheduled_status: value, scheduled_error: error }).eq('id', job.profile_id));
  } else if (job.kind === 'catalog') {
    await result(db.from('keychallenge_refresh_schedule').update({ catalog_status: value, catalog_error: error }).eq('singleton', true));
  } else {
    await result(db.from('keychallenge_searchad_status').update({ last_error: error, updated_at: now() }).eq('singleton', true));
  }
}
async function cancel(job: any) {
  await checkpoint(job, { status: 'cancelled', state: {}, completed_at: now(), lease_token: null, lease_until: null });
  await status(job, 'skipped');
}

async function profileStep(job: any) {
  const { data: profile } = await result(db.from('keychallenge_profiles')
    .select('id,influencer_id,auto_refresh_enabled,updated_at').eq('id', job.profile_id).maybeSingle());
  if (!profile || !profile.auto_refresh_enabled) { await cancel(job); return true; }
  const s = job.state;
  if (!s.baseline) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(profile.influencer_id)) throw new Error('Invalid influencer ID');
    Object.assign(s, { baseline: profile.updated_at, influencerId: profile.influencer_id, items: {}, cursors: [], cursor: null });
  }
  if (profile.updated_at !== s.baseline || profile.influencer_id !== s.influencerId) {
    await cancel(job); return true;
  }
  const page = await collectProfilePage(s.influencerId, s.cursor);
  s.ownerId ??= page.ownerId;
  s.total ??= page.total;
  if (!Number.isInteger(s.total) || s.ownerId !== page.ownerId || (page.total !== null && s.total !== page.total)) {
    throw new CollectionError(409, '수집 중 참여 목록이 변경되었습니다.');
  }
  for (const item of page.items) s.items[item.id] = item;
  const count = Object.keys(s.items).length;
  if (count > s.total) throw new CollectionError(409, '참여 목록 개수가 일치하지 않습니다.');
  const cursor = page.nextCursor;
  if (cursor === null || cursor === '') {
    if (count !== s.total) throw new CollectionError(409, '일부 참여 키워드가 누락되어 기존 데이터를 유지합니다.');
    await result(db.rpc('keychallenge_finish_profile_sync', {
      p_job: job.id, p_lease: job.lease_token, p_baseline: s.baseline,
      p_payload: { version: '3.2', source: 'naver-public', refreshMode: 'scheduled',
        influencerId: s.influencerId, ownerId: s.ownerId, total: s.total,
        collectedAt: page.collectedAt, items: Object.values(s.items) },
    }));
    return true;
  }
  if (!page.items.length || s.cursors.includes(cursor) || s.cursors.length >= 2000) {
    throw new CollectionError(409, '참여 목록의 다음 페이지를 확인하지 못했습니다.');
  }
  s.cursor = cursor;
  s.cursors.push(cursor);
  await checkpoint(job);
  return false;
}

function catalogRows(items: any[], category: any, catalogId: string, isMission = false) {
  const rows = items.map(item => {
    if (!item?.id || !item.name || (!isMission && String(item.categoryId) !== String(category.id))) {
      throw new CollectionError(502, '키워드의 분야 정보가 일치하지 않습니다.');
    }
    return { catalog_id: catalogId, keyword_id: String(item.id), name: String(item.name),
      category_id: String(category.id), field: String(category.name), field_group: String(category.group),
      participant_count: item.participantCount == null ? null : item.participantCount };
  });
  return [...new Map(rows.map(row => [row.keyword_id, row])).values()];
}
async function catalogStep(job: any) {
  const s = job.state;
  if (!s.catalogId) {
    const fields = await categories();
    const { data: admins } = await result(db.from('keychallenge_admins').select('user_id').order('created_at').limit(1));
    if (!admins?.length) throw new Error('Catalog administrator missing');
    const catalogId = crypto.randomUUID();
    await result(db.from('keychallenge_catalogs').insert({ id: catalogId, source_label: '자동 수집 중',
      coverage: 'partial', expected_count: 1, collected_at: now(), created_by: admins[0].user_id, scheduled_snapshot: true }));
    Object.assign(s, { catalogId, fields, fieldIndex: 0, pass: 0, cursor: null,
      cursors: [], missionsDone: false, counts: [], expected: 0, difference: 0 });
    await checkpoint(job);
  }
  const field = s.fields[s.fieldIndex];
  if (!field) {
    await result(db.rpc('keychallenge_finish_catalog_sync', { p_job: job.id, p_lease: job.lease_token,
      p_catalog: s.catalogId, p_expected: s.expected, p_difference: s.difference, p_fields: s.fields.length }));
    return true;
  }
  if (!s.missionsDone) {
    const missionRows = catalogRows(await missions(field.id), field, s.catalogId, true);
    if (missionRows.length) await result(db.from('keychallenge_catalog_items').upsert(missionRows, { onConflict: 'catalog_id,keyword_id' }));
    s.missionsDone = true;
    s.sourceTotal = field.keywordCount;
  }
  const page = await catalogPage(field.id, s.cursor, [500, 333, 257][s.pass]);
  if (page.paging.total !== null && page.paging.total !== undefined) {
    if (!Number.isInteger(page.paging.total) || page.paging.total < 0 || page.paging.total > 200000) {
      throw new CollectionError(502, '공용 목록 개수 형식이 변경되었습니다.');
    }
    s.sourceTotal = page.paging.total;
  }
  const rows = catalogRows(page.items, field, s.catalogId);
  if (rows.length) await result(db.from('keychallenge_catalog_items').upsert(rows, { onConflict: 'catalog_id,keyword_id' }));
  const cursor = page.paging.nextCursor == null ? null : String(page.paging.nextCursor);
  if (cursor !== null && cursor !== '') {
    if (!rows.length || s.cursors.includes(cursor) || s.cursors.length >= 2000) {
      throw new CollectionError(409, '공용 목록의 다음 페이지를 확인하지 못했습니다.');
    }
    s.cursor = cursor;
    s.cursors.push(cursor);
  } else {
    const { count } = await result(db.from('keychallenge_catalog_items').select('keyword_id', { count: 'exact', head: true })
      .eq('catalog_id', s.catalogId).eq('category_id', String(field.id)));
    if (count !== s.sourceTotal && s.pass < 2) {
      s.pass += 1; s.cursor = null; s.cursors = [];
    } else {
      const difference = Math.abs(count - s.sourceTotal);
      if (!count || difference > Math.max(10, s.sourceTotal * 0.01)) {
        throw new CollectionError(409, '공용 목록의 누락이 커서 이전 목록을 유지합니다.');
      }
      s.counts.push({ field: field.name, count, sourceTotal: s.sourceTotal });
      s.expected += count; s.difference += difference;
      s.fieldIndex += 1; s.pass = 0; s.cursor = null; s.cursors = []; s.missionsDone = false;
    }
  }
  await checkpoint(job);
  return false;
}

async function volumeStep(job: any) {
  const { data: settings } = await result(db.from('keychallenge_searchad_status').select('enabled').eq('singleton', true).single());
  if (!settings.enabled) { await cancel(job); return true; }
  const { data: hints } = await result(db.rpc('keychallenge_volume_candidates', { p_limit: 5 }));
  if (!hints.length || (job.state.processed || 0) >= 4000) {
    await checkpoint(job, { status: 'succeeded', state: {}, completed_at: now(), lease_token: null, lease_until: null });
    await result(db.from('keychallenge_searchad_status').update({ last_success_at: now(), last_error: null }).eq('singleton', true));
    return true;
  }
  if (!job.credentials) ({ data: job.credentials } = await result(db.rpc('keychallenge_searchad_credentials')));
  if (!job.credentials) throw new SearchAdError(401, '관리자가 검색광고 API 연결을 완료해야 합니다.');
  const rows = await fetchVolumes(job.credentials, hints.map((item: any) => item.name));
  await result(db.rpc('keychallenge_store_search_volumes', { p_rows: rows }));
  job.state.processed = (job.state.processed || 0) + hints.length;
  await checkpoint(job);
  return false;
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed' });
  // This endpoint is server-to-server. Its private Vault credential is checked before work is claimed.
  const token = request.headers.get('x-keychallenge-token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return reply(401, { error: 'Unauthorized' });
  let job: any;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const { data: credential } = await result(db.from('keychallenge_sync_auth').select('token_hash').eq('singleton', true).single());
    if (hash !== credential.token_hash) return reply(401, { error: 'Unauthorized' });
    const { data: schedule } = await result(db.from('keychallenge_refresh_schedule').select('enabled').eq('singleton', true).single());
    if (!schedule.enabled) return reply(200, { status: 'disabled' });
    ({ data: job } = await result(db.rpc('keychallenge_claim_sync_job')));
    if (!job) return reply(200, { status: 'idle' });
    await status(job, 'running');
    const started = Date.now();
    for (let pages = 0; pages < 20 && Date.now() - started < 22_000; pages += 1) {
      const done = job.kind === 'profile' ? await profileStep(job) : job.kind === 'volume' ? await volumeStep(job) : await catalogStep(job);
      if (done) return reply(200, { status: 'finished', kind: job.kind });
      await new Promise(resolve => setTimeout(resolve, job.kind === 'volume' ? 500 : 300));
    }
    await checkpoint(job, { status: 'queued', attempts: 0, last_error: null, lease_token: null, lease_until: null });
    return reply(200, { status: 'continuing', kind: job.kind });
  } catch (error) {
    console.error('keychallenge-sync failed', error instanceof Error ? error.name : 'UnknownError');
    if (job) {
      const attempts = job.attempts + 1;
      const failed = attempts >= 4;
      const sourceError = error instanceof CollectionError || error instanceof SearchAdError;
      const message = sourceError ? error.message : '서버 연결 문제로 예약 수집을 완료하지 못했습니다.';
      // Rate limits back off for at least 15 minutes. Other failures back off 5/15/45 minutes.
      const delay = sourceError && error.status === 429 ? Math.max(15, 5 * 3 ** (attempts - 1)) : 5 * 3 ** (attempts - 1);
      try {
        await checkpoint(job, { status: failed ? 'failed' : 'queued', attempts, last_error: message,
          next_attempt_at: new Date(Date.now() + delay * 60_000).toISOString(),
          lease_token: null, lease_until: null, ...(failed ? { completed_at: now() } : {}) });
        await status(job, failed ? 'failed' : 'retrying', message);
      } catch { console.error('Could not persist worker failure'); }
      return reply(200, { status: failed ? 'failed' : 'retrying' });
    }
    return reply(503, { error: 'Worker unavailable' });
  }
});
