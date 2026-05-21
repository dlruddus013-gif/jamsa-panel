// staff-manage-modal.jsx
// 직원/알바 관리 모달 — CRUD UI (인증된 사용자만 사용)

import React, { useEffect, useMemo, useState } from "react";

const PRESET_NEW_STAFF = [
  // 사용자 요청: 김효진/윤승수/윤찬미 자동 시드 (이미 등록되어 있으면 무시됨)
  { name: "김효진", dept_id: 1, is_part_time: false },
  { name: "윤승수", dept_id: 1, is_part_time: false },
  { name: "윤찬미", dept_id: 1, is_part_time: false },
];

async function apiFetch(method, body) {
  const res = await fetch("/api/staff-manage" + (body?._query || ""), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(typeof window !== "undefined" && window.__authToken
        ? { "Authorization": "Bearer " + window.__authToken }
        : {}),
    },
    ...(method !== "GET" && body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

export function StaffManageModal({ depts = [], onClose, onChanged }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all"); // all | regular | parttime | inactive
  const [editing, setEditing] = useState(null); // 편집 중인 직원 객체
  const [showAddForm, setShowAddForm] = useState(false);
  const [seedRunning, setSeedRunning] = useState(false);

  const load = async () => {
    setLoading(true); setError("");
    try {
      const d = await apiFetch("GET");
      setStaff(d.staff || []);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (filter === "regular")  return staff.filter(s => !s.is_part_time && s.active);
    if (filter === "parttime") return staff.filter(s =>  s.is_part_time && s.active);
    if (filter === "inactive") return staff.filter(s => !s.active);
    return staff;
  }, [staff, filter]);

  const stats = useMemo(() => ({
    total: staff.length,
    regular: staff.filter(s => !s.is_part_time && s.active).length,
    parttime: staff.filter(s => s.is_part_time && s.active).length,
    inactive: staff.filter(s => !s.active).length,
  }), [staff]);

  // 김효진/윤승수/윤찬미 일괄 추가
  const runSeed = async () => {
    if (!confirm("김효진, 윤승수, 윤찬미를 직원으로 추가합니다.\n(이미 있으면 활성화만 갱신)")) return;
    setSeedRunning(true);
    let okCount = 0, errCount = 0;
    for (const p of PRESET_NEW_STAFF) {
      try {
        await apiFetch("POST", p);
        okCount++;
      } catch (e) { errCount++; console.warn("seed fail:", p.name, e); }
    }
    setSeedRunning(false);
    alert(`✅ ${okCount}명 추가 완료${errCount ? ` (실패 ${errCount})` : ""}`);
    await load();
    onChanged?.();
  };

  const addStaff = async (form) => {
    try {
      await apiFetch("POST", form);
      alert(`✅ ${form.name} ${form.is_part_time ? "알바" : "직원"} 추가됨`);
      setShowAddForm(false);
      await load();
      onChanged?.();
    } catch (e) { alert("추가 실패: " + e.message); }
  };

  const updateStaff = async (id, patch) => {
    try {
      await apiFetch("PATCH", { id, ...patch });
      await load();
      onChanged?.();
    } catch (e) { alert("수정 실패: " + e.message); }
  };

  const deactivate = async (s) => {
    if (!confirm(`${s.name} 비활성화? (목록에서 숨김 — 영구 삭제 X)`)) return;
    try {
      await apiFetch("PATCH", { id: s.id, active: false });
      await load();
      onChanged?.();
    } catch (e) { alert("실패: " + e.message); }
  };

  const reactivate = async (s) => {
    try {
      await apiFetch("PATCH", { id: s.id, active: true });
      await load();
      onChanged?.();
    } catch (e) { alert("실패: " + e.message); }
  };

  const hardDelete = async (s) => {
    if (!confirm(`⚠ ${s.name} 영구 삭제? 출퇴근 기록은 남지만 staff에서 완전 제거됩니다. 계속?`)) return;
    if (!confirm(`정말 영구 삭제하시겠습니까?`)) return;
    try {
      await fetch(`/api/staff-manage?id=${s.id}&hard=1`, {
        method: "DELETE",
        headers: { ...(window.__authToken ? { "Authorization": "Bearer " + window.__authToken } : {}) },
      });
      await load();
      onChanged?.();
    } catch (e) { alert("실패: " + e.message); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 10500, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 820, maxHeight: "94vh", overflowY: "auto", background: "#0f172a", color: "#f1f5f9", borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)" }}>
        {/* 헤더 */}
        <div style={{ padding: "16px 20px", background: "linear-gradient(135deg,#10b981,#0891b2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, opacity: 0.9 }}>직원 · 알바 관리</div>
            <div style={{ fontSize: 17, fontWeight: 900 }}>👥 인력 관리</div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", width: 30, height: 30, borderRadius: "50%" }}>×</button>
        </div>

        {/* 통계 + 시드 + 필터 */}
        <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <FilterChip label={`전체 ${stats.total}`} active={filter==="all"} onClick={()=>setFilter("all")} color="#94a3b8" />
          <FilterChip label={`정직원 ${stats.regular}`} active={filter==="regular"} onClick={()=>setFilter("regular")} color="#10b981" />
          <FilterChip label={`알바 ${stats.parttime}`} active={filter==="parttime"} onClick={()=>setFilter("parttime")} color="#a855f7" />
          <FilterChip label={`비활성 ${stats.inactive}`} active={filter==="inactive"} onClick={()=>setFilter("inactive")} color="#64748b" />
          <div style={{ flex: 1 }} />
          <button onClick={runSeed} disabled={seedRunning}
            style={{ padding: "7px 12px", borderRadius: 5, background: seedRunning ? "#475569" : "#0891b2", color: "#fff", border: "none", fontSize: 11, fontWeight: 800, cursor: seedRunning ? "wait" : "pointer", whiteSpace: "nowrap" }}>
            {seedRunning ? "추가 중..." : "👥 김효진·윤승수·윤찬미 일괄 추가"}
          </button>
          <button onClick={() => setShowAddForm(s => !s)}
            style={{ padding: "7px 14px", borderRadius: 5, background: showAddForm ? "#dc2626" : "#10b981", color: "#fff", border: "none", fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
            {showAddForm ? "✕ 닫기" : "＋ 신규 추가"}
          </button>
        </div>

        {/* 신규 추가 폼 */}
        {showAddForm && <AddForm depts={depts} onSubmit={addStaff} onCancel={() => setShowAddForm(false)} />}

        {/* 직원 목록 */}
        <div style={{ padding: 16 }}>
          {loading ? (
            <div style={{ padding: 30, textAlign: "center", color: "#94a3b8" }}>불러오는 중...</div>
          ) : error ? (
            <div style={{ padding: 14, background: "rgba(220,38,38,0.15)", color: "#fca5a5", borderRadius: 6, fontSize: 12 }}>⚠ {error}</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "#94a3b8" }}>해당하는 직원이 없습니다</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.map(s => (
                <StaffRow key={s.id} staff={s} depts={depts}
                  editing={editing?.id === s.id}
                  onEdit={() => setEditing(s)}
                  onCancelEdit={() => setEditing(null)}
                  onSave={(patch) => { updateStaff(s.id, patch); setEditing(null); }}
                  onDeactivate={() => deactivate(s)}
                  onReactivate={() => reactivate(s)}
                  onDelete={() => hardDelete(s)}
                />
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: 10, background: "rgba(255,255,255,0.03)", borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 10, color: "#94a3b8", textAlign: "center" }}>
          비활성 = 출퇴근 화면에서 숨김 (기록은 보존). 영구 삭제는 출퇴근 기록 외래키 제약 시 실패할 수 있음.
        </div>
      </div>
    </div>
  );
}

function FilterChip({ label, active, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 16, fontSize: 11, fontWeight: 700,
      background: active ? color : "rgba(255,255,255,0.06)",
      color: active ? "#fff" : "#94a3b8",
      border: active ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.1)",
      cursor: "pointer", whiteSpace: "nowrap",
    }}>{label}</button>
  );
}

function AddForm({ depts, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: "", dept_id: depts[0]?.id || 1, phone: "", beacon_id: "",
    is_part_time: false, hired_at: new Date().toISOString().slice(0,10),
    contract_end: "", memo: "",
  });
  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  return (
    <div style={{ padding: 14, background: "rgba(16,185,129,0.06)", borderBottom: "1px solid rgba(16,185,129,0.2)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
        <Field label="이름 *">
          <input value={form.name} onChange={e => set({ name: e.target.value })} placeholder="홍길동" style={inputStyle} autoFocus />
        </Field>
        <Field label="부서">
          <select value={form.dept_id} onChange={e => set({ dept_id: parseInt(e.target.value)||1 })} style={inputStyle}>
            {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="연락처">
          <input value={form.phone} onChange={e => set({ phone: e.target.value })} placeholder="010-1234-5678" style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
        <Field label="구분">
          <select value={form.is_part_time ? "pt" : "ft"} onChange={e => set({ is_part_time: e.target.value === "pt" })} style={inputStyle}>
            <option value="ft">정직원</option>
            <option value="pt">알바 (단기)</option>
          </select>
        </Field>
        <Field label="시작일">
          <input type="date" value={form.hired_at} onChange={e => set({ hired_at: e.target.value })} style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
        </Field>
        <Field label={form.is_part_time ? "종료일 (자동 비활성)" : "비콘 ID"}>
          {form.is_part_time ? (
            <input type="date" value={form.contract_end} onChange={e => set({ contract_end: e.target.value })} style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
          ) : (
            <input value={form.beacon_id} onChange={e => set({ beacon_id: e.target.value })} placeholder="(선택) BCN-A001" style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
          )}
        </Field>
      </div>
      <Field label="메모 (선택)">
        <input value={form.memo} onChange={e => set({ memo: e.target.value })} placeholder="비고/특이사항" style={inputStyle} />
      </Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 }}>
        <button onClick={onCancel} style={{ padding: "7px 14px", borderRadius: 5, background: "rgba(255,255,255,0.06)", color: "#94a3b8", border: "1px solid rgba(255,255,255,0.12)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>취소</button>
        <button onClick={() => {
          if (!form.name.trim()) { alert("이름을 입력하세요"); return; }
          onSubmit(form);
        }} style={{ padding: "7px 16px", borderRadius: 5, background: "#10b981", color: "#0f172a", border: "none", fontSize: 12, fontWeight: 900, cursor: "pointer" }}>
          {form.is_part_time ? "알바 등록" : "직원 등록"}
        </button>
      </div>
    </div>
  );
}

function StaffRow({ staff: s, depts, editing, onEdit, onCancelEdit, onSave, onDeactivate, onReactivate, onDelete }) {
  const [edit, setEdit] = useState({ ...s });
  useEffect(() => { setEdit({ ...s }); }, [s.id, editing]);
  const dept = depts.find(d => d.id === s.dept_id);
  const isActive = s.active !== false;
  const isPart = !!s.is_part_time;

  if (editing) {
    return (
      <div style={{ padding: 10, background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.35)", borderRadius: 6 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
          <Field label="이름"><input value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})} style={inputStyle} /></Field>
          <Field label="부서">
            <select value={edit.dept_id||""} onChange={e=>setEdit({...edit,dept_id:parseInt(e.target.value)||null})} style={inputStyle}>
              <option value="">— 미지정 —</option>
              {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="연락처"><input value={edit.phone||""} onChange={e=>setEdit({...edit,phone:e.target.value})} style={{...inputStyle,fontFamily:"ui-monospace,monospace"}} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
          <Field label="구분">
            <select value={edit.is_part_time ? "pt" : "ft"} onChange={e=>setEdit({...edit,is_part_time:e.target.value==="pt"})} style={inputStyle}>
              <option value="ft">정직원</option><option value="pt">알바</option>
            </select>
          </Field>
          <Field label="비콘 ID"><input value={edit.beacon_id||""} onChange={e=>setEdit({...edit,beacon_id:e.target.value})} placeholder="BCN-..." style={{...inputStyle,fontFamily:"ui-monospace,monospace"}} /></Field>
          <Field label="종료일 (알바)">
            <input type="date" value={edit.contract_end||""} onChange={e=>setEdit({...edit,contract_end:e.target.value||null})} style={{...inputStyle,fontFamily:"ui-monospace,monospace"}} disabled={!edit.is_part_time} />
          </Field>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button onClick={onCancelEdit} style={{ padding: "5px 12px", borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#94a3b8", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>취소</button>
          <button onClick={() => onSave(edit)} style={{ padding: "5px 16px", borderRadius: 4, background: "#10b981", border: "none", color: "#0f172a", fontSize: 11, fontWeight: 900, cursor: "pointer" }}>저장</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 10, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "center",
      background: isActive ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.015)",
      border: `1px solid ${isPart ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 6, opacity: isActive ? 1 : 0.55,
    }}>
      <span style={{
        padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 800, letterSpacing: ".04em",
        background: isPart ? "rgba(168,85,247,0.2)" : "rgba(16,185,129,0.2)",
        color: isPart ? "#ddd6fe" : "#6ee7b7",
      }}>{isPart ? "알바" : "직원"}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          {s.name}
          {!isActive && <span style={{ marginLeft: 6, fontSize: 9, color: "#94a3b8" }}>(비활성)</span>}
        </div>
        <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
          {dept?.name || "부서 미지정"}
          {s.phone && <> · 📞 {s.phone}</>}
          {s.beacon_id && <> · 📡 {s.beacon_id}</>}
          {s.contract_end && <> · 종료 {s.contract_end}</>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={onEdit} style={btnIcon("#a5b4fc","rgba(99,102,241,0.15)","rgba(99,102,241,0.3)")} title="편집">✎</button>
        {isActive ? (
          <button onClick={onDeactivate} style={btnIcon("#fcd34d","rgba(245,158,11,0.15)","rgba(245,158,11,0.3)")} title="비활성">⏸</button>
        ) : (
          <button onClick={onReactivate} style={btnIcon("#6ee7b7","rgba(16,185,129,0.15)","rgba(16,185,129,0.3)")} title="활성화">▶</button>
        )}
        <button onClick={onDelete} style={btnIcon("#fca5a5","rgba(220,38,38,0.15)","rgba(220,38,38,0.3)")} title="영구 삭제">🗑</button>
      </div>
    </div>
  );
}

const inputStyle = { width: "100%", padding: "6px 10px", background: "#0b1220", border: "1px solid rgba(255,255,255,0.12)", color: "#f1f5f9", borderRadius: 4, fontSize: 12 };
const btnIcon = (color, bg, border) => ({ padding: "5px 10px", borderRadius: 4, background: bg, border: `1px solid ${border}`, color, fontSize: 13, fontWeight: 700, cursor: "pointer" });
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  );
}
