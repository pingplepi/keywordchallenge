import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';

const $ = (id) => document.getElementById(id);
const config = window.APP_CONFIG || {};
const storageKey = 'keyon-password-recovery-v1';
const markerKey = `${storageKey}-verified-user-id`;
let client, storage, recoveryUserId = null, busy = false, finished = false;
let resendAt = 0, countdown;

function message(id, text, kind = '') {
  $(id).textContent = text;
  $(id).className = `message ${kind}`.trim();
}

function setScreen(mode, text = '', kind = '') {
  const editing = mode === 'password';
  $('resetRequestForm').hidden = mode !== 'request';
  $('newPasswordForm').hidden = !editing;
  $('recoveryTitle').textContent = mode === 'done' ? '비밀번호를 변경했어요' : editing ? '새 비밀번호 설정' : '비밀번호 재설정';
  $('recoveryDescription').textContent = mode === 'done'
    ? '이제 새 비밀번호로 키온에 로그인해 주세요.'
    : editing ? '아래 계정에 사용할 새 비밀번호를 입력해 주세요.'
      : '가입한 이메일로 새 비밀번호를 설정할 수 있는 링크를 보내드려요.';
  message('recoveryStatus', text, kind);
}

function clearRecovery() {
  recoveryUserId = null;
  // This client has its own per-tab storage. Never remove the dashboard login.
  try {
    if (storage) for (const key of [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`, markerKey]) storage.removeItem(key);
  } catch { /* Storage can be disabled while this page is open. */ }
  $('newPasswordForm').reset();
  $('newPassword').type = 'password';
  $('confirmPassword').type = 'password';
  $('recoveryAccount').textContent = '';
}

function expiredLink() {
  clearRecovery();
  setScreen('request', '재설정 링크가 만료되었거나 이미 사용되었습니다. 이메일을 입력해 새 링크를 받아 주세요.', 'error');
  updateSendButton();
}

function errorText(error, saving = false) {
  const code = error?.code || '';
  if (code === 'same_password') return '현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.';
  if (code === 'weak_password') return '비밀번호가 보안 기준에 맞지 않습니다. 8자 이상으로 영문·숫자·기호를 조합해 주세요.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || error?.status === 429) return '요청이 많아 잠시 기다려야 합니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'email_address_invalid') return '이메일 주소를 확인해 주세요.';
  if (['email_address_not_authorized', 'email_address_not_allowed', 'email_provider_disabled'].includes(code)) return '현재 이 주소로 메일을 발송할 수 없습니다. 운영자에게 메일 발송 설정 확인을 요청해 주세요.';
  if (error?.status >= 500) return saving ? '서버 오류로 비밀번호를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' : '메일을 발송하지 못했습니다. 운영자에게 메일 연결 설정 확인을 요청해 주세요.';
  if (error?.name === 'AuthRetryableFetchError' || error instanceof TypeError) return '인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
  return saving ? '비밀번호를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' : '메일 발송 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요. 계속되면 운영자에게 문의해 주세요.';
}

function updateSendButton() {
  const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
  $('sendResetButton').disabled = busy || !client || seconds > 0;
  $('sendResetButton').textContent = busy ? '요청 중…' : seconds ? `${seconds}초 후 다시 보내기` : '재설정 링크 보내기';
  if (!seconds && countdown) { clearInterval(countdown); countdown = null; }
}

function startCooldown() {
  resendAt = Date.now() + 60_000;
  if (countdown) clearInterval(countdown);
  countdown = setInterval(updateSendButton, 1000);
}

async function initialize() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const hasCallback = ['access_token', 'refresh_token', 'type', 'error', 'error_code'].some(key => fragment.has(key)) || query.has('code') || query.has('error') || query.has('error_code');
  // Remove callback credentials before rendering or making further requests.
  if (location.hash || location.search) history.replaceState(null, '', location.pathname);
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    message('recoveryStatus', '재설정 화면을 준비하지 못했습니다. 잠시 후 다시 접속해 주세요.', 'error');
    return;
  }
  try {
    storage = window.sessionStorage;
    if (hasCallback) clearRecovery();
    client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: {
        storageKey, storage, persistSession: true, autoRefreshToken: true,
        detectSessionInUrl: false, flowType: 'implicit',
      },
    });
    if (hasCallback) {
      if (fragment.get('type') !== 'recovery' || !fragment.get('access_token') || !fragment.get('refresh_token') || fragment.has('error') || fragment.has('error_code') || query.has('error') || query.has('error_code')) {
        expiredLink();
        return;
      }
      const { error } = await client.auth.setSession({ access_token: fragment.get('access_token'), refresh_token: fragment.get('refresh_token') });
      if (error) { expiredLink(); return; }
      const { data, error: userError } = await client.auth.getUser();
      if (userError || !data.user) { expiredLink(); return; }
      recoveryUserId = data.user.id;
      storage.setItem(markerKey, recoveryUserId);
      $('recoveryAccount').textContent = data.user.email || '이메일로 확인한 계정';
      setScreen('password');
    } else if (storage.getItem(markerKey)) {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user || data.user.id !== storage.getItem(markerKey)) { expiredLink(); return; }
      recoveryUserId = data.user.id;
      $('recoveryAccount').textContent = data.user.email || '이메일로 확인한 계정';
      setScreen('password');
    } else {
      clearRecovery();
      setScreen('request');
    }
    // No async auth calls inside the callback: they can deadlock the SDK lock.
    client.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT' && recoveryUserId && !finished) expiredLink();
    });
    updateSendButton();
  } catch {
    clearRecovery();
    message('recoveryStatus', '재설정 화면을 열지 못했습니다. 브라우저의 사이트 저장 허용과 인터넷 연결을 확인한 뒤 새로고침해 주세요.', 'error');
  }
}

$('resetRequestForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!client || busy || Date.now() < resendAt) return;
  busy = true;
  updateSendButton();
  message('requestMessage', '재설정 링크를 요청하고 있습니다…');
  try {
    const { error } = await client.auth.resetPasswordForEmail($('recoveryEmail').value.trim(), {
      redirectTo: `${window.location.origin}/password-reset.html`,
    });
    if (error) throw error;
    startCooldown();
    message('requestMessage', '가입된 이메일이라면 재설정 링크가 발송됩니다. 받은편지함과 스팸함을 확인해 주세요.', 'success');
  } catch (error) {
    if (error?.status === 429 || error?.code === 'over_email_send_rate_limit') startCooldown();
    message('requestMessage', errorText(error), 'error');
  } finally {
    busy = false;
    updateSendButton();
  }
});

$('showPassword').addEventListener('change', event => {
  for (const id of ['newPassword', 'confirmPassword']) $(id).type = event.target.checked ? 'text' : 'password';
});
$('confirmPassword').addEventListener('input', () => $('confirmPassword').removeAttribute('aria-invalid'));
$('newPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !recoveryUserId || finished) return;
  const password = $('newPassword').value;
  if (password.length < 8 || password !== $('confirmPassword').value) {
    message('passwordMessage', password.length < 8 ? '비밀번호를 8자 이상 입력해 주세요.' : '두 비밀번호가 일치하지 않습니다.', 'error');
    $('confirmPassword').setAttribute('aria-invalid', 'true');
    $('confirmPassword').focus();
    return;
  }
  busy = true;
  $('savePasswordButton').disabled = true;
  $('savePasswordButton').textContent = '저장 중…';
  message('passwordMessage', '새 비밀번호를 저장하고 있습니다…');
  try {
    const { data, error: identityError } = await client.auth.getUser();
    if (identityError || !data.user || data.user.id !== recoveryUserId) { expiredLink(); return; }
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    finished = true;
    // A sign-out network error must not report a successfully saved password as failed.
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* Clear our local session below. */ }
    clearRecovery();
    setScreen('done');
    $('recoveryTitle').focus();
  } catch (error) {
    if (['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found'].includes(error?.code) || error?.status === 401) expiredLink();
    else message('passwordMessage', errorText(error, true), 'error');
  } finally {
    busy = false;
    $('savePasswordButton').disabled = false;
    $('savePasswordButton').textContent = '새 비밀번호 저장';
    updateSendButton();
  }
});

initialize();
