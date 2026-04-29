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
      updateAuthBadge();
    });

    window.__authToken = session?.access_token || null;
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

    setMsg('데이터 동기화 중...');
    await hydrateFromBackend();
  } else {
    setMsg('로컬 모드 (Supabase 미설정)');
  }

  updateAuthBadge();

  // 3) React 마운트
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(App));
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
//  Supabase 백엔드 sync
// ════════════════════════════════════════════════
async function hydrateFromBackend() {
  if (!supabase || !session) return;
  try {
    const res = await authFetch('/api/keys');
    if (!res.ok) {
      console.warn('[hydrate] keys fetch failed:', res.status);
      return;
    }
    const keys = await res.json();
    let loaded = 0;
    for (const meta of keys) {
      const key = meta.key;
      if (!key.startsWith(SYNC_PREFIX)) continue;
      try {
        const r = await authFetch('/api/data/' + encodeURIComponent(key));
        if (r.ok) {
          const data = await r.json();
          const remoteStr = JSON.stringify(data);
          const localStr = localStorage.getItem(key);
          if (localStr !== remoteStr) {
            _origSetItem(key, remoteStr);
            loaded++;
          }
        }
      } catch (e) {}
    }
    return loaded;
  } catch (e) {
    console.warn('[hydrate] failed:', e);
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
    console.warn('[sync] skip huge value:', key);
    return;
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch (e) { parsed = value; }
  _pendingPush.set(key, parsed);
  setSyncStatus('pending', '저장 대기...');
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushPush, SYNC_DEBOUNCE_MS);
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
function showAuthScreen() {
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
        <div id="authError" style="display:none;background:#fee2e2;color:#991b1b;
                                    padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;"></div>
        <input id="authEmail" type="email" placeholder="이메일" autocomplete="email"
               style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;
                      font-size:14px;margin-bottom:10px;outline:none;" />
        <input id="authPw" type="password" placeholder="비밀번호" autocomplete="current-password"
               style="width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;
                      font-size:14px;margin-bottom:14px;outline:none;" />
        <button id="authBtnLogin" style="width:100%;padding:11px;background:#3b5bdb;color:white;
                                          border:none;border-radius:8px;font-size:14px;font-weight:600;
                                          cursor:pointer;margin-bottom:8px;">로그인</button>
        <button id="authBtnSignup" style="width:100%;padding:11px;background:transparent;color:#3b5bdb;
                                           border:1px solid #3b5bdb;border-radius:8px;font-size:13px;
                                           font-weight:500;cursor:pointer;">계정 만들기</button>
        <div style="text-align:center;margin-top:14px;font-size:11px;color:#94a3b8;">
          🔒 Supabase Auth + RLS · HTTPS
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const showError = (msg) => {
    const e = document.getElementById('authError');
    e.textContent = msg;
    e.style.display = 'block';
  };

  document.getElementById('authBtnLogin').onclick = async () => {
    const email = document.getElementById('authEmail').value.trim();
    const pw = document.getElementById('authPw').value;
    if (!email || !pw) return showError('이메일/비밀번호 입력');
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) return showError(error.message);
    overlay.remove();
    location.reload();
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

  // 엔터로 로그인
  document.getElementById('authPw').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('authBtnLogin').click();
  });
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
