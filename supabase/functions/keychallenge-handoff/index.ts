import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const userClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authenticatedUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const jwt = authHeader.slice('Bearer '.length);
  const { data, error } = await userClient.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  try {
    if (action === 'submit' && request.method === 'POST') {
      const body = await request.json();
      const token = typeof body.token === 'string' ? body.token : '';
      const payload = body.payload;
      if (token.length < 40 || !payload || typeof payload !== 'object' || !Array.isArray(payload.items) || typeof payload.influencerId !== 'string') {
        return json(400, { error: 'Invalid handoff payload.' });
      }
      if (JSON.stringify(payload).length > 4_000_000) return json(413, { error: 'Payload is too large.' });
      const tokenHash = await hashToken(token);
      const { data: handoff, error: lookupError } = await adminClient
        .from('keychallenge_handoffs')
        .select('token_hash, expires_at, payload')
        .eq('token_hash', tokenHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (lookupError || !handoff || handoff.payload) return json(404, { error: 'Handoff expired or unavailable.' });
      const { error: saveError } = await adminClient.from('keychallenge_handoffs')
        .update({ payload })
        .eq('token_hash', tokenHash)
        .is('payload', null);
      if (saveError) return json(500, { error: 'Could not save handoff payload.' });
      return json(200, { saved: true });
    }

    const user = await authenticatedUser(request);
    if (!user) return json(401, { error: 'Sign in is required.' });

    if (action === 'create' && request.method === 'POST') {
      const body = await request.json();
      const token = typeof body.token === 'string' ? body.token : '';
      if (token.length < 40 || token.length > 200) return json(400, { error: 'Invalid handoff token.' });
      const tokenHash = await hashToken(token);
      const now = new Date().toISOString();
      await adminClient.from('keychallenge_handoffs').delete().lt('expires_at', now);
      const expiresAt = new Date(Date.now() + 6 * 60 * 1000).toISOString();
      const { error } = await adminClient.from('keychallenge_handoffs').insert({ token_hash: tokenHash, user_id: user.id, expires_at: expiresAt });
      if (error) return json(500, { error: 'Could not create handoff.' });
      return json(201, { created: true, expiresAt });
    }

    if (action === 'read' && request.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (token.length < 40) return json(400, { error: 'Invalid handoff token.' });
      const tokenHash = await hashToken(token);
      const { data, error } = await adminClient.from('keychallenge_handoffs')
        .select('payload, expires_at')
        .eq('token_hash', tokenHash)
        .eq('user_id', user.id)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (error) return json(500, { error: 'Could not read handoff.' });
      if (!data) return json(404, { error: 'Handoff expired or unavailable.' });
      return json(200, { payload: data.payload });
    }

    if (action === 'consume' && request.method === 'POST') {
      const token = url.searchParams.get('token') || '';
      if (token.length < 40) return json(400, { error: 'Invalid handoff token.' });
      const tokenHash = await hashToken(token);
      const { error } = await adminClient.from('keychallenge_handoffs').delete()
        .eq('token_hash', tokenHash).eq('user_id', user.id);
      if (error) return json(500, { error: 'Could not consume handoff.' });
      return json(200, { consumed: true });
    }

    return json(404, { error: 'Unknown action.' });
  } catch (error) {
    console.error('keychallenge-handoff error:', error);
    return json(500, { error: 'Unexpected handoff error.' });
  }
});
