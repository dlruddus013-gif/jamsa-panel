// ════════════════════════════════════════════════
//  잠사박물관 통합관리 — Vercel + Supabase 엔트리
// ════════════════════════════════════════════════
import React from 'react';
import ReactDOM from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import App from './source.jsx';

const SYNC_PREFIX = 'jamsa_';
const SYNC_DEBOUNCE_MS = 800;

// 패널이 호스팅된 origin (Vercel 도메인 또는 localhost)
const PANEL_ORIGIN = window.location.origin;

// Supabase 클라이언트는 /api/config 응답 후 생성
let supabase = null;
let session = null;
let supabaseConfig = null;

// ════════════════════════════════════════════════
//  부팅
// ════════════════════════════════════════════════
async function boot() {
  const setMsg = (m) => {
    const el = document.getElementById('loadingMsg');
    if (el) el.textContent = m;
  };

  setMsg('서버 설정 로드 중...');

  // 1) 서버에서 Supabase 설정 받기
  try {
    const r = await fetch(PANEL_ORIGIN + '/api/config');
    if (!r.ok) throw new Error('config fetch failed');
    supabaseConfig = await r.json();
  } catch (e) {
    setMsg('⚠ 서버 설정 실패 — 로컬 모드');
    console.warn('[boot] config:', e);
  }

  // 2) Supabase 사용 가능 여부
  const useSupabase = !!(supabaseConfig?.supabase_url && supabaseConfig?.supabase_anon_key);

  if (useSupabase) {
    setMsg('인증 시스템 초기화...');
    supabase = createClient(supabaseConfig.supabase_url, supabaseConfig.supabase_anon_key, {
      auth: { persistSession: true, autoRefreshToken: true, storage: localStorage, storageKey: 'jamsa_sb_session' },
    });

    // 세션 확인
    const { data: { session: s0 } } = await supabase.auth.getSession();
    session = s0;

    supabase.auth.onAuthStateChange((_event, s) => {
      session = s;
      window.__authToken = s?.access_token || null;
      window.__supabaseUserEmail = s?.user?.email || null;
      updateAuthBadge();
    });

    window.__authToken = session?.access_token || null;
    window.__supabaseUserEmail = session?.user?.email || null;
    window.__supabase = supabase;

    // CCTV 백엔드 URL
    if (supabaseConfig.backend_cctv_url) {
      window.BACKEND_URL = supabaseConfig.backend_cctv_url;
      try {
        if (!localStorage.getItem('jamsa_cctv_snap_server')) {
          _origSetItem('jamsa_cctv_snap_server', supabaseConfig.backend_cctv_url);
        }
      } catch (e) {}
    }

    // 로그인 안 됐으면 로그인 화면 표시 (React 마운트 안 함)
    if (!session) {
      setMsg('로그인 필요');
      window.__hideLoading?.();
      showAuthScreen();
      return;
    }

    // ⚡ 핵심 개선: localStorage에 캐시된 데이터로 React 즉시 마운트
    // 백엔드 동기화는 백그라운드에서 진행 (사용자는 즉시 화면 봄)
    setMsg('화면 준비 중...');
  } else {
    setMsg('로컬 모드 (Supabase 미설정)');
  }

  updateAuthBadge();
  await mountReactApp();
}

// React 앱 마운트 (boot + 로그인 후 재호출 가능)
let _reactRoot = null;
async function mountReactApp() {
  // 3) Hydrate BEFORE React mount — so React 컴포넌트의 useState 초기화 시 클라우드 데이터를 본다.
  //    이전에는 마운트 후 100ms 뒤에 hydrate 했기 때문에 새 기기/시크릿 모드에서
  //    지도 배치·CCTV 매핑 등 모든 jamsa_* 데이터가 기본값으로 보였음.
  //    빠른 응답을 위해 3.5초 타임아웃 — 그 안에 안 오면 일단 로컬로 마운트하고 백그라운드에서 계속.
  let preHydratedCount = 0;
  let preHydrateFailed = false;
  if (supabase && session) {
    const setMsg = (m) => {
      const el = document.getElementById('loadingMsg');
      if (el) el.textContent = m;
    };
    setMsg('클라우드 데이터 동기화 중...');
    try {
      preHydratedCount = await Promise.race([
        hydrateFromBackend(),
        new Promise((resolve) => setTimeout(() => { preHydrateFailed = true; resolve(0); }, 3500)),
      ]) || 0;
    } catch (e) {
      console.warn('[boot] pre-hydrate failed:', e);
      preHydrateFailed = true;
    }
  }

  // 4) React 마운트 (이미 있으면 재사용)
  if (!_reactRoot) {
    _reactRoot = ReactDOM.createRoot(document.getElementById('root'));
  }
  _reactRoot.render(React.createElement(App));

  // 5) hydrate 가 타임아웃됐으면 백그라운드에서 한 번 더 시도 후 강제 리렌더
  if (supabase && session && preHydrateFailed) {
    setTimeout(async () => {
      const updated = await hydrateFromBackend();
      if (updated && updated > 0) {
        // 백그라운드 hydrate 후 갱신된 데이터를 React 가 보도록 강제 리렌더
        // (간단히 root.render 재호출 — React 가 알아서 diff/리마운트)
        try { _reactRoot.render(React.createElement(App)); } catch (e) {}
        const syncBadge = document.getElementById('syncBadge');
        if (syncBadge) {
          const txt = syncBadge.querySelector('.sync-txt');
          if (txt) txt.textContent = `클라우드 ✓ (${updated}건 갱신)`;
          setTimeout(() => { if (txt) txt.textContent = '클라우드 ✓'; }, 5000);
        }
      }
    }, 100);
  } else if (supabase && session && preHydratedCount > 0) {
    const syncBadge = document.getElementById('syncBadge');
    if (syncBadge) {
      const txt = syncBadge.querySelector('.sync-txt');
      if (txt) txt.textContent = `클라우드 ✓ (${preHydratedCount}건 동기화)`;
      setTimeout(() => { if (txt) txt.textContent = '클라우드 ✓'; }, 5000);
    }
  }
}

// ════════════════════════════════════════════════
//  인증된 fetch (모든 API 호출에 토큰 추가)
// ════════════════════════════════════════════════
async function authFetch(path, opts = {}) {
  const token = window.__authToken;
  return fetch(PANEL_ORIGIN + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  });
}

window.authFetch = authFetch;

// ════════════════════════════════════════════════
//  Supabase 백엔드 sync (일괄 API로 1번 호출)
// ════════════════════════════════════════════════
async function hydrateFromBackend() {
  if (!supabase || !session) return;
  try {
    // 한 번의 호출로 모든 데이터 가져오기 (이전: 30-50번 → 이후: 1번)
    const res = await authFetch('/api/data-bulk');
    if (!res.ok) {
      // 폴백: 기존 방식 (병렬)
      console.warn('[hydrate] bulk failed, fallback to parallel:', res.status);
      return await hydrateFromBackendLegacy();
    }
    const result = await res.json();
    if (!result.ok || !result.data) return 0;

    let loaded = 0;
    for (const [key, data] of Object.entries(result.data)) {
      const remoteStr = JSON.stringify(data);
      const localStr = localStorage.getItem(key);
      if (localStr !== remoteStr) {
        _origSetItem(key, remoteStr);
        loaded++;
      }
    }
    return loaded;
  } catch (e) {
    console.warn('[hydrate] failed:', e);
    return 0;
  }
}

// 폴백: 병렬 fetch
async function hydrateFromBackendLegacy() {
  if (!supabase || !session) return;
  try {
    const res = await authFetch('/api/keys');
    if (!res.ok) return 0;
    const keys = await res.json();
    const validKeys = keys.filter(meta => meta.key.startsWith(SYNC_PREFIX));
    if (validKeys.length === 0) return 0;

    const fetchPromises = validKeys.map(meta =>
      authFetch('/api/data/' + encodeURIComponent(meta.key))
        .then(r => r.ok ? r.json().then(data => ({ key: meta.key, data })) : null)
        .catch(() => null)
    );

    const results = await Promise.all(fetchPromises);
    let loaded = 0;
    for (const result of results) {
      if (!result) continue;
      const remoteStr = JSON.stringify(result.data);
      const localStr = localStorage.getItem(result.key);
      if (localStr !== remoteStr) {
        _origSetItem(result.key, remoteStr);
        loaded++;
      }
    }
    return loaded;
  } catch (e) {
    return 0;
  }
}

// localStorage hook
const _origSetItem = localStorage.setItem.bind(localStorage);
const _origRemoveItem = localStorage.removeItem.bind(localStorage);
const _pendingPush = new Map();
let _flushTimer = null;

function setSyncStatus(state, msg) {
  const el = document.getElementById('syncBadge');
  if (!el) return;
  el.dataset.state = state;
  const txt = el.querySelector('.sync-txt');
  if (txt) txt.textContent = msg;
}

function queueCloudSync(key, value) {
  key = String(key || '');
  if (!key.startsWith(SYNC_PREFIX)) return false;
  if (!supabase || !session) return false;
  if (typeof value === 'string' && value.length > 5 * 1024 * 1024) {
    console.warn('[sync] skip huge value:', key, '(' + Math.round(value.length / 1024 / 1024) + 'MB)');
    try {
      window.__syncSkipped = window.__syncSkipped || {};
      window.__syncSkipped[key] = { size: value.length, at: new Date().toISOString() };
      const badge = document.getElementById('syncBadge');
      if (badge) {
        const txt = badge.querySelector('.sync-txt');
        if (txt) txt.textContent = 'cloud blocked: large data';
        badge.dataset.state = 'error';
      }
    } catch (e) {}
    return false;
  }
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch (e) { parsed = value; }
  _pendingPush.set(key, parsed);
  setSyncStatus('pending', 'cloud save pending');
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushPush, SYNC_DEBOUNCE_MS);
  return true;
}

window.__jamsaQueueCloudSync = queueCloudSync;
window.addEventListener('jamsa:storage-sync', (event) => {
  const detail = event?.detail || {};
  if (!detail.key) return;
  queueCloudSync(detail.key, detail.value);
});

async function flushPush() {
  if (_pendingPush.size === 0) return;
  if (!supabase || !session) {
    setSyncStatus('error', '미인증');
    return;
  }
  const items = Array.from(_pendingPush.entries());
  _pendingPush.clear();
  setSyncStatus('syncing', `클라우드 ${items.length}건...`);
  let ok = 0, failed = 0;
  for (const [key, value] of items) {
    try {
      const res = await authFetch('/api/data/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (res.ok) ok++;
      else { failed++; console.warn('[sync] PUT failed', key, res.status); }
    } catch (e) {
      failed++;
      console.warn('[sync] error:', key, e.message);
    }
  }
  setSyncStatus(failed === 0 ? 'ok' : 'partial', `클라우드 ${ok}/${items.length}`);
  setTimeout(() => setSyncStatus('idle', '클라우드 ✓'), 2500);
}

localStorage.setItem = function(key, value) {
  _origSetItem(key, value);
  if (!key.startsWith(SYNC_PREFIX)) return;
  if (!supabase || !session) return; // 미인증 시 sync 안 함
  if (typeof value === 'string' && value.length > 5 * 1024 * 1024) {
    console.warn('[sync] skip huge value:', key, '(' + Math.round(value.length/1024/1024) + 'MB) — 데이터 유실 위험');
    try {
      window.__syncSkipped = window.__syncSkipped || {};
      window.__syncSkipped[key] = { size: value.length, at: new Date().toISOString() };
      const badge = document.getElementById('syncBadge');
      if (badge) {
        const txt = badge.querySelector('.sync-txt');
        if (txt) txt.textContent = '⚠️ 큰 데이터 차단';
        badge.dataset.state = 'error';
      }
    } catch (e) {}
    return;
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch (e) { parsed = value; }
  _pendingPush.set(key, parsed);
  setSyncStatus('pending', '저장 대기...');
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushPush, SYNC_DEBOUNCE_MS);
};

localStorage.setItem = function(key, value) {
  _origSetItem(key, value);
  queueCloudSync(key, value);
};

localStorage.removeItem = function(key) {
  _origRemoveItem(key);
  if (!key.startsWith(SYNC_PREFIX) || !supabase || !session) return;
  authFetch('/api/data/' + encodeURIComponent(key), { method: 'DELETE' })
    .catch(e => console.warn('[sync] delete:', key, e.message));
};

// ════════════════════════════════════════════════
//  로그인 화면 (Supabase 미인증 시)
// ════════════════════════════════════════════════
// ─── 자동 로그인 헬퍼 ─────────────────────────────────────
const LS_LAST_EMAIL    = "jamsa_last_login_email";
const LS_REMEMBER_PW   = "jamsa_remember_pw_v1";    // 암호화된 비번
const LS_REMEMBER_TIME = "jamsa_remember_until";    // expiry timestamp

// 간단한 XOR + base64 (안전한 비번 저장은 아니지만 평문보다 나음)
// 보안 경고: 같은 디바이스에서만 의미 있음. 멀티유저 PC에서는 사용 자제.
function _devKey() {
  // 디바이스 고유 키 (브라우저 첫 사용 시 생성, localStorage 영구)
  let k = localStorage.getItem("jamsa_dev_key");
  if (!k) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    k = Array.from(buf).map(b => b.toString(16).padStart(2,"0")).join("");
    localStorage.setItem("jamsa_dev_key", k);
  }
  return k;
}
function _xorEncrypt(text, key) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(unescape(encodeURIComponent(out)));
}
function _xorDecrypt(b64, key) {
  try {
    const s = decodeURIComponent(escape(atob(b64)));
    let out = "";
    for (let i = 0; i < s.length; i++) {
      out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch (e) { return null; }
}
function saveRememberCreds(email, password, days = 30) {
  try {
    localStorage.setItem(LS_LAST_EMAIL, email);
    const enc = _xorEncrypt(password, _devKey());
    localStorage.setItem(LS_REMEMBER_PW, enc);
    localStorage.setItem(LS_REMEMBER_TIME, String(Date.now() + days * 86400_000));
  } catch (e) {}
}
function loadRememberCreds() {
  try {
    const email = localStorage.getItem(LS_LAST_EMAIL);
    const enc = localStorage.getItem(LS_REMEMBER_PW);
    const until = parseInt(localStorage.getItem(LS_REMEMBER_TIME) || "0", 10);
    if (!email) return null;
    if (!enc || !until || Date.now() > until) {
      // 비번 만료 — 이메일만 반환
      return { email, password: null, expired: !!enc };
    }
    const pw = _xorDecrypt(enc, _devKey());
    return { email, password: pw, expired: false };
  } catch (e) { return null; }
}
function clearRememberCreds() {
  try {
    localStorage.removeItem(LS_REMEMBER_PW);
    localStorage.removeItem(LS_REMEMBER_TIME);
    // 이메일은 유지 (다음 로그인 편의)
  } catch (e) {}
}

function showAuthScreen() {
  const remembered = loadRememberCreds();
  const lastEmail = remembered?.email || "";
  const overlay = document.createElement('div');
  overlay.id = 'authOverlay';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);
                display:flex;align-items:center;justify-content:center;z-index:10000;">
      <div style="background:white;border-radius:16px;padding:36px 40px;width:380px;
                  box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="font-size:48px;margin-bottom:6px;">🏛️</div>
          <div style="font-size:18px;font-weight:700;color:#0f172a;">한국잠사박물관</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">통합관리 시스템</div>
        </div>
        ${remembered?.email && remembered?.password ? `
          <div id="autoLoginBanner" style="background:linear-gradient(135deg,#dcfce7,#bbf7d0);border:1px solid #86efac;color:#14532d;padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:12px;">
            <div style="font-weight:700;margin-bottom:3px;">⚡ 자동 로그인 시도 중</div>
            <div style="font-size:11px;color:#15803d">${remembered.email} · 잠시만 기다려주세요...</div>
          </div>
        ` : ''}
        <div id="authError" style="display:none;background:#fee2e2;color:#991b1b;
                                    padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;"></div>
        <input id="authEmail" type="email" placeholder="이메일" autocomplete="email" value="${lastEmail.replace(/"/g, '&quot;')}"
               style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;
                      font-size:14px;margin-bottom:10px;outline:none;" />
        <input id="authPw" type="password" placeholder="비밀번호" autocomplete="current-password"
               style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;
                      font-size:14px;margin-bottom:10px;outline:none;" />
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#475569;margin-bottom:14px;cursor:pointer;user-select:none;">
          <input id="authRemember" type="checkbox" checked style="width:16px;height:16px;cursor:pointer;accent-color:#3b5bdb;" />
          <span>이 기기에서 30일 자동 로그인 (같은 PC만)</span>
        </label>
        <button id="authBtnLogin" style="width:100%;padding:11px;background:#3b5bdb;color:white;
                                          border:none;border-radius:8px;font-size:14px;font-weight:600;
                                          cursor:pointer;margin-bottom:8px;">로그인</button>
        <button id="authBtnSignup" style="width:100%;padding:11px;background:transparent;color:#3b5bdb;
                                           border:1px solid #3b5bdb;border-radius:8px;font-size:13px;
                                           font-weight:500;cursor:pointer;">계정 만들기</button>
        ${remembered?.email ? `
          <button id="authBtnForget" style="width:100%;padding:8px;background:transparent;color:#dc2626;
                                            border:none;font-size:11px;cursor:pointer;margin-top:6px;">
            🗑 이 기기 저장된 정보 삭제
          </button>
        ` : ''}
        <div style="text-align:center;margin-top:14px;font-size:11px;color:#94a3b8;">
          🔒 Supabase Auth + RLS · HTTPS · XOR 암호화
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const showError = (msg) => {
    const e = document.getElementById('authError');
    e.textContent = msg;
    e.style.display = 'block';
    const banner = document.getElementById('autoLoginBanner');
    if (banner) banner.style.display = 'none';
  };

  // 로그인 처리 공통 함수
  async function doLogin(email, pw, isAuto = false) {
    const btn = document.getElementById('authBtnLogin');
    if (btn) { btn.textContent = isAuto ? '자동 로그인 중...' : '로그인 중...'; btn.disabled = true; }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) {
      if (btn) { btn.textContent = '로그인'; btn.disabled = false; }
      // 자동 로그인 실패 시 저장된 비번 삭제 (만료/변경 등)
      if (isAuto) { clearRememberCreds(); }
      return showError(error.message + (isAuto ? ' (저장된 정보 삭제됨 - 비번 다시 입력)' : ''));
    }
    // 세션 즉시 반영
    session = data.session;
    window.__authToken = session?.access_token || null;
    window.__supabaseUserEmail = session?.user?.email || email;
    // 자동 로그인 체크되어 있으면 비번 저장
    const remember = document.getElementById('authRemember')?.checked;
    if (remember) {
      saveRememberCreds(email, pw, 30);
    } else {
      // 이메일만 저장 (편의)
      try { localStorage.setItem(LS_LAST_EMAIL, email); } catch (e) {}
    }
    overlay.remove();
    const msgEl = document.getElementById('loadingMsg');
    if (msgEl) msgEl.textContent = '화면 준비 중...';
    document.body.classList.add('loading');
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
      loadingEl.classList.remove('hidden');
      loadingEl.style.opacity = '1';
    }
    await mountReactApp();
    setTimeout(() => {
      if (typeof window.__hideLoading === 'function') window.__hideLoading();
    }, 50);
  }

  document.getElementById('authBtnLogin').onclick = async () => {
    const email = document.getElementById('authEmail').value.trim();
    const pw = document.getElementById('authPw').value;
    if (!email || !pw) return showError('이메일/비밀번호 입력');
    await doLogin(email, pw, false);
  };

  document.getElementById('authBtnSignup').onclick = async () => {
    const email = document.getElementById('authEmail').value.trim();
    const pw = document.getElementById('authPw').value;
    if (!email || !pw) return showError('이메일/비밀번호 입력');
    if (pw.length < 8) return showError('비밀번호 8자 이상');
    const { data, error } = await supabase.auth.signUp({ email, password: pw });
    if (error) return showError(error.message);
    showError('✅ 가입 완료. 이메일 확인 후 로그인하세요.');
  };

  const forgetBtn = document.getElementById('authBtnForget');
  if (forgetBtn) forgetBtn.onclick = () => {
    if (!confirm('이 기기에 저장된 로그인 정보를 모두 삭제할까요?')) return;
    try {
      localStorage.removeItem(LS_LAST_EMAIL);
      localStorage.removeItem(LS_REMEMBER_PW);
      localStorage.removeItem(LS_REMEMBER_TIME);
    } catch (e) {}
    location.reload();
  };

  document.getElementById('authPw').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('authBtnLogin').click();
  });
  // 자동 포커스
  setTimeout(() => {
    const focus = (remembered?.email && !remembered?.password)
      ? document.getElementById('authPw')
      : document.getElementById('authEmail');
    focus?.focus();
  }, 100);

  // 🆕 자동 로그인 즉시 시도
  if (remembered?.email && remembered?.password) {
    document.getElementById('authPw').value = remembered.password;
    setTimeout(() => doLogin(remembered.email, remembered.password, true), 200);
  }
}

// ════════════════════════════════════════════════
//  인증 상태 배지 업데이트
// ════════════════════════════════════════════════
function updateAuthBadge() {
  const el = document.getElementById('authBadge');
  if (!el) return;
  if (session?.user) {
    el.dataset.state = 'online';
    el.querySelector('.auth-txt').textContent = '🔒 ' + (session.user.email?.split('@')[0] || '로그인됨');
    el.style.display = 'flex';
  } else {
    el.dataset.state = 'offline';
    el.querySelector('.auth-txt').textContent = '🔓 미로그인';
  }
}

// 글로벌 로그아웃
window.signOut = async () => {
  if (supabase) await supabase.auth.signOut();
  location.reload();
};

// 글로벌 강제 sync
window.forceSyncToBackend = async () => {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith(SYNC_PREFIX) && !key.includes('sb_session')) {
      const v = localStorage.getItem(key);
      if (v) {
        try { _pendingPush.set(key, JSON.parse(v)); } catch (e) { _pendingPush.set(key, v); }
      }
    }
  });
  await flushPush();
};
window.forceSyncFromBackend = hydrateFromBackend;

// 백엔드 검색
window.searchBackend = async (q, opts = {}) => {
  const params = new URLSearchParams({ q, limit: opts.limit || 50 });
  const res = await authFetch('/api/search?' + params.toString());
  if (!res.ok) return null;
  return await res.json();
};

// ════════════════════════════════════════════════
boot();
