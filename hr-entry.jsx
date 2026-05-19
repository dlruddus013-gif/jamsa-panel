// hr-entry.jsx — public/hr.html 의 진입점
// /api/config → Supabase 클라이언트 → window.__supabase → MuseumHrPage 마운트
import React from "react";
import ReactDOM from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import MuseumHrPage from "./museum-hr-page.jsx";

async function boot() {
  const setMsg = (m) => {
    const el = document.getElementById("hr-loading");
    if (el) el.textContent = m;
  };

  setMsg("서버 설정 로드 중...");
  let cfg = null;
  try {
    const r = await fetch(window.location.origin + "/api/config");
    if (r.ok) cfg = await r.json();
  } catch (e) { /* fall through */ }

  if (!cfg?.supabase_url || !cfg?.supabase_anon_key) {
    setMsg("⚠ Supabase 설정을 불러올 수 없습니다. /api/config 응답을 확인하세요.");
    return;
  }

  setMsg("인증 시스템 초기화...");
  const supabase = createClient(cfg.supabase_url, cfg.supabase_anon_key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: localStorage,
      storageKey: "jamsa_sb_session", // 메인 패널과 세션 공유
    },
  });
  window.__supabase = supabase;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    setMsg("로그인이 필요합니다. 메인 패널에서 먼저 로그인 후 다시 접속하세요.");
    const link = document.getElementById("hr-login-link");
    if (link) link.style.display = "inline-block";
    return;
  }

  // 로딩 영역 숨기고 React 마운트
  const loading = document.getElementById("hr-loading-wrap");
  if (loading) loading.style.display = "none";
  const root = document.getElementById("hr-root");
  ReactDOM.createRoot(root).render(<MuseumHrPage/>);
}

boot();
