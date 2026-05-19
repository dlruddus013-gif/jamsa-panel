// museum-hr.jsx
// ============================================================================
// 잠사플레이팜 박물관 HR 모듈 — BLE 비콘 출근 관리
//
// 기능:
//   1. parseBeaconPayload()   — Eddystone-UID 페이로드 검증 + dept/uid 추출
//   2. BEACON_DEPT_MAP        — 부서 코드 매핑
//   3. estimateDistance()     — RSSI 기반 거리 추정 (m)
//   4. UI:
//      - 비콘 등록 (직원 선택 → 페이로드 붙여넣기 → 자동 파싱)
//      - 실시간 출근 대시보드 (부서별 색상)
//      - 외국인 노동자 별도 탭 (E-9/H-2 비자 만료 표시)
//
// 환경: React 18 + Tailwind + shadcn/ui + Supabase
// 사용 위치: 메인 패널의 인사관리 탭에서 <MuseumHr/> 마운트
//
// Supabase 사전 작업: supabase/migrations/20260519_beacon_attendance.sql 적용
// ============================================================================

import React, { useEffect, useMemo, useState, useCallback } from "react";
// shadcn/ui (없으면 일반 button/input/select로 대체 — 아래 _ui 폴백 참고)
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

// ── Supabase 클라이언트 — 상위 프로젝트의 client를 그대로 사용 ──────
// 사용 측 예: window.__supabase 또는 직접 import
const getSupabase = () => {
  if (typeof window !== "undefined" && window.__supabase) return window.__supabase;
  throw new Error("Supabase client가 window.__supabase에 없습니다. 부트 코드에서 등록하세요.");
};

// ─── 상수 ────────────────────────────────────────────────────────────
/** 잠사플레이팜 사업장 namespace (10바이트 = 20 hex chars, 고정). */
export const JAMSA_BEACON_NAMESPACE = "00112233445566778899";

/** 부서 코드 → 부서명/색상 매핑 (0x01 ~ 0xFF). */
export const BEACON_DEPT_MAP = {
  0x01: { code: 0x01, name: "관리부",        color: "emerald", tw: "bg-emerald-500", bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
  0x02: { code: 0x02, name: "시설부",        color: "blue",    tw: "bg-blue-500",    bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200" },
  0x03: { code: 0x03, name: "외국인 노동자", color: "orange",  tw: "bg-orange-500",  bg: "bg-orange-50",  text: "text-orange-700",  border: "border-orange-200" },
  // 0x04 ~ 0xFF 는 예비 — 필요 시 동적 추가
};

const RSSI_LABELS = [
  { min: -40, label: "매우 가까움", tw: "bg-emerald-500" },
  { min: -55, label: "가까움",     tw: "bg-blue-500" },
  { min: -70, label: "보통",       tw: "bg-amber-500" },
  { min: -85, label: "약함",       tw: "bg-red-500" },
];

// ─── 핵심 로직 (단위 테스트 가능) ────────────────────────────────────
/**
 * 비콘 Eddystone-UID 페이로드 파싱 + 검증.
 * @returns { ok: true, data: { namespace, instance, dept_code, dept_name, user_uid, rssi, rssi_at_xm, mac, tm } }
 *          또는 { ok: false, error: string }
 */
export function parseBeaconPayload(input) {
  let p;
  try {
    p = typeof input === "string" ? JSON.parse(input) : input;
  } catch (e) {
    return { ok: false, error: "JSON 파싱 실패: " + e.message };
  }
  if (!p || typeof p !== "object") return { ok: false, error: "객체가 아닙니다" };

  // type 검증 (uid / ucid 모두 허용)
  const type = String(p.type || "").toLowerCase();
  if (type && type !== "uid" && type !== "ucid") {
    return { ok: false, error: `type이 'uid'가 아닙니다 (받은 값: ${p.type})` };
  }

  // namespace 검증
  const ns = String(p.namespace || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!ns) return { ok: false, error: "namespace가 비어있습니다" };
  if (ns !== JAMSA_BEACON_NAMESPACE) {
    return { ok: false, error: `잠사플레이팜 namespace가 아닙니다. expected=${JAMSA_BEACON_NAMESPACE}, got=${ns}` };
  }

  // instance 검증 (12 hex chars = 6 bytes)
  const inst = String(p.instance || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (inst.length !== 12) {
    return { ok: false, error: `instance는 12자리 hex여야 합니다 (받은 값: ${p.instance}, 길이 ${inst.length})` };
  }

  // 앞 2자리 = 부서코드(hex), 뒤 10자리 = 개인 UID
  const dept_code = parseInt(inst.slice(0, 2), 16);
  const user_uid  = inst.slice(2);
  if (Number.isNaN(dept_code)) return { ok: false, error: "부서코드 파싱 실패" };

  const dept = BEACON_DEPT_MAP[dept_code] || {
    code: dept_code, name: `예비(0x${dept_code.toString(16).padStart(2, "0").toUpperCase()})`,
    color: "slate", tw: "bg-slate-500", bg: "bg-slate-50", text: "text-slate-700", border: "border-slate-200",
  };

  const rssi = p.rssi != null ? Number(p.rssi) : null;
  const rssi_at_xm = p.rssi_at_xm != null ? Number(p.rssi_at_xm) : null;

  return {
    ok: true,
    data: {
      type: "uid",
      namespace: ns,
      instance: inst,
      dept_code,
      dept_name: dept.name,
      dept,
      user_uid,
      rssi: Number.isFinite(rssi) ? rssi : null,
      rssi_at_xm: Number.isFinite(rssi_at_xm) ? rssi_at_xm : null,
      mac: p.mac ? String(p.mac).toLowerCase() : null,
      tm: p.tm || null,
      estimated_distance_m: estimateDistance(rssi, rssi_at_xm),
    },
  };
}

/**
 * RSSI 기반 거리 추정.
 * rssi_at_xm은 비콘 측정 기준점 (1m 거리에서의 RSSI).
 * 환경 영향 큼 — 대략적 참고용.
 */
export function estimateDistance(rssi, txPowerAt1m) {
  if (rssi == null || !Number.isFinite(rssi)) return null;
  const tx = Number.isFinite(txPowerAt1m) ? txPowerAt1m : -59; // 합리적 디폴트
  if (rssi === 0) return null;
  const ratio = rssi / tx;
  if (ratio < 1) return Math.round(Math.pow(ratio, 10) * 10) / 10;
  const d = 0.89976 * Math.pow(ratio, 7.7095) + 0.111;
  return Math.round(d * 10) / 10;
}

function rssiLabel(rssi) {
  if (rssi == null) return { label: "측정안됨", tw: "bg-slate-300" };
  for (const l of RSSI_LABELS) if (rssi >= l.min) return l;
  return { label: "이탈 가능성", tw: "bg-rose-700" };
}

// ─── 메인 컴포넌트 ──────────────────────────────────────────────────
export default function MuseumHr() {
  const [tab, setTab] = useState("dashboard");

  return (
    <div className="p-4 lg:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">🏛️ 잠사 인사·출근 (BLE 비콘)</h1>
          <p className="text-sm text-slate-500">Eddystone-UID 기반 자동 출근 + 부서별 실시간 모니터</p>
        </div>
        <Badge variant="outline" className="font-mono text-xs">
          NS {JAMSA_BEACON_NAMESPACE.slice(0, 8)}…
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="dashboard">📊 실시간 출근</TabsTrigger>
          <TabsTrigger value="staff">👥 직원 관리</TabsTrigger>
          <TabsTrigger value="register">📡 비콘 등록</TabsTrigger>
          <TabsTrigger value="foreign">🌏 외국인 노동자</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4"><AttendanceDashboard/></TabsContent>
        <TabsContent value="staff" className="mt-4"><StaffList/></TabsContent>
        <TabsContent value="register" className="mt-4"><BeaconRegister/></TabsContent>
        <TabsContent value="foreign" className="mt-4"><ForeignWorkerTab/></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── 1) 실시간 출근 대시보드 ───────────────────────────────────────
function AttendanceDashboard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const sb = getSupabase();
      // attendance ← staff 조인 (최근 5분 내 출근)
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data, error } = await sb
        .from("attendance")
        .select(`
          id, check_in_at, raw_rssi, estimated_distance_m, beacon_mac,
          staff:staff_id ( id, name, dept_code, beacon_instance, contract_type, visa_type, visa_expires_at )
        `)
        .gte("check_in_at", since)
        .order("check_in_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);  // 5초 폴링
    return () => clearInterval(id);
  }, [load]);

  // 부서별 그룹
  const grouped = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const dc = r.staff?.dept_code ?? 0;
      if (!m.has(dc)) m.set(dc, []);
      m.get(dc).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>❌ 출근 데이터 로드 실패</AlertTitle>
        <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* 부서별 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {Object.values(BEACON_DEPT_MAP).map((d) => {
          const list = rows.filter(r => r.staff?.dept_code === d.code);
          const unique = new Set(list.map(r => r.staff?.id)).size;
          return (
            <Card key={d.code} className={`${d.bg} ${d.border} border-2`}>
              <CardHeader className="pb-2">
                <div className={`w-2 h-2 rounded-full ${d.tw}`}/>
                <CardTitle className={`${d.text} text-base`}>{d.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-slate-900">{unique}</div>
                <div className="text-xs text-slate-500">현재 감지된 인원 (5분 내)</div>
                <div className="text-xs text-slate-400 mt-1">감지 이벤트 {list.length}건</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">실시간 출근 로그 (최근 5분)</CardTitle>
          <CardDescription>5초마다 자동 갱신 · 총 {rows.length}건</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && rows.length === 0 ? (
            <div className="text-center py-10 text-slate-400">불러오는 중...</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-10 text-slate-400">최근 감지된 직원이 없습니다.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>시각</TableHead>
                  <TableHead>이름</TableHead>
                  <TableHead>부서</TableHead>
                  <TableHead>RSSI</TableHead>
                  <TableHead>거리</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead className="text-xs">비콘 MAC</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.map(([deptCode, list]) => {
                  const d = BEACON_DEPT_MAP[deptCode] || { name: `예비${deptCode}`, tw: "bg-slate-500", text: "text-slate-700", bg: "bg-slate-50" };
                  return list.map((r, i) => {
                    const r2 = rssiLabel(r.raw_rssi);
                    return (
                      <TableRow key={r.id} className={i === 0 ? d.bg : ""}>
                        <TableCell className="font-mono text-xs">
                          {new Date(r.check_in_at).toLocaleTimeString("ko-KR")}
                        </TableCell>
                        <TableCell className="font-semibold">{r.staff?.name || "(미등록)"}</TableCell>
                        <TableCell>
                          <Badge className={`${d.tw} text-white`}>{d.name}</Badge>
                        </TableCell>
                        <TableCell className="font-mono">{r.raw_rssi ?? "—"} dBm</TableCell>
                        <TableCell>{r.estimated_distance_m != null ? `${r.estimated_distance_m}m` : "—"}</TableCell>
                        <TableCell><Badge className={`${r2.tw} text-white`}>{r2.label}</Badge></TableCell>
                        <TableCell className="font-mono text-xs text-slate-500">{r.beacon_mac || "—"}</TableCell>
                      </TableRow>
                    );
                  });
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── 2) 직원 목록 ────────────────────────────────────────────────
function StaffList() {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const sb = getSupabase();
        const { data } = await sb.from("staff").select("*").order("dept_code", { ascending: true });
        setStaff(data || []);
      } finally { setLoading(false); }
    })();
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>전체 직원 ({staff.length}명)</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? <div className="py-10 text-center text-slate-400">로딩...</div> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead><TableHead>부서</TableHead>
                <TableHead>계약유형</TableHead><TableHead>비콘 instance</TableHead>
                <TableHead>비자(외국인)</TableHead><TableHead>상태</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map(s => {
                const d = BEACON_DEPT_MAP[s.dept_code];
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-semibold">{s.name}</TableCell>
                    <TableCell>{d ? <Badge className={`${d.tw} text-white`}>{d.name}</Badge> : <span className="text-slate-400">미배정</span>}</TableCell>
                    <TableCell>{s.contract_type || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{s.beacon_instance || <span className="text-rose-500">미등록</span>}</TableCell>
                    <TableCell>{s.visa_type ? `${s.visa_type} · ${s.visa_expires_at || ""}` : "—"}</TableCell>
                    <TableCell><Badge variant={s.is_active ? "default" : "secondary"}>{s.is_active ? "재직" : "퇴사"}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 3) 비콘 등록 ────────────────────────────────────────────────
function BeaconRegister() {
  const [staff, setStaff] = useState([]);
  const [staffId, setStaffId] = useState("");
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    (async () => {
      const sb = getSupabase();
      const { data } = await sb.from("staff").select("id,name,dept_code").order("name");
      setStaff(data || []);
    })();
  }, []);

  // raw 변경 시 자동 파싱
  useEffect(() => {
    if (!raw.trim()) { setParsed(null); setError(null); return; }
    const r = parseBeaconPayload(raw);
    if (r.ok) { setParsed(r.data); setError(null); }
    else { setParsed(null); setError(r.error); }
  }, [raw]);

  const save = async () => {
    if (!staffId) { setError("직원을 먼저 선택하세요"); return; }
    if (!parsed) { setError("페이로드를 먼저 입력하세요"); return; }
    setSaving(true); setMsg(null); setError(null);
    try {
      const sb = getSupabase();
      const { error } = await sb
        .from("staff")
        .update({
          beacon_namespace: parsed.namespace,
          beacon_instance:  parsed.instance,
          dept_code:        parsed.dept_code,
        })
        .eq("id", staffId);
      if (error) throw error;
      setMsg(`✓ ${staff.find(s => String(s.id) === String(staffId))?.name}님에게 비콘 등록 완료 (${parsed.dept_name})`);
      setRaw(""); setParsed(null);
    } catch (e) {
      // unique 제약 위반 등
      setError(e.message);
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>📡 비콘 등록 / 재등록</CardTitle>
        <CardDescription>
          직원 선택 → 비콘 페이로드(JSON) 붙여넣기 → 자동으로 namespace/instance 파싱 → 등록
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>1) 직원 선택</Label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger><SelectValue placeholder="직원을 선택하세요"/></SelectTrigger>
              <SelectContent>
                {staff.map(s => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name} {BEACON_DEPT_MAP[s.dept_code] ? `(${BEACON_DEPT_MAP[s.dept_code].name})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>2) 비콘 페이로드 (Eddystone-UID JSON)</Label>
            <Textarea
              rows={6}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={`{
  "type": "uid",
  "namespace": "${JAMSA_BEACON_NAMESPACE}",
  "instance": "01000000000A",
  "rssi": -29,
  "rssi_at_xm": -24,
  "mac": "c300002a772a",
  "tm": "2026-05-19T06:14:36.666Z"
}`}
              className="font-mono text-xs"
            />
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>❌ 파싱/저장 오류</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {parsed && (
          <Card className={`${parsed.dept.bg} ${parsed.dept.border} border-2`}>
            <CardHeader className="pb-2">
              <CardTitle className={`${parsed.dept.text} text-base`}>✓ 파싱 성공</CardTitle>
            </CardHeader>
            <CardContent className="grid md:grid-cols-3 gap-3 text-sm">
              <div><div className="text-slate-500 text-xs">부서</div><Badge className={`${parsed.dept.tw} text-white mt-1`}>{parsed.dept_name} (0x{parsed.dept_code.toString(16).padStart(2,"0").toUpperCase()})</Badge></div>
              <div><div className="text-slate-500 text-xs">개인 UID</div><div className="font-mono text-xs">{parsed.user_uid}</div></div>
              <div><div className="text-slate-500 text-xs">비콘 MAC</div><div className="font-mono text-xs">{parsed.mac || "—"}</div></div>
              <div><div className="text-slate-500 text-xs">RSSI</div><div>{parsed.rssi ?? "—"} dBm</div></div>
              <div><div className="text-slate-500 text-xs">기준 RSSI@1m</div><div>{parsed.rssi_at_xm ?? "—"} dBm</div></div>
              <div><div className="text-slate-500 text-xs">추정 거리</div><div>{parsed.estimated_distance_m != null ? `${parsed.estimated_distance_m}m` : "—"}</div></div>
            </CardContent>
          </Card>
        )}

        {msg && (
          <Alert>
            <AlertTitle>{msg}</AlertTitle>
          </Alert>
        )}
      </CardContent>
      <CardFooter>
        <Button onClick={save} disabled={saving || !staffId || !parsed} className="w-full">
          {saving ? "저장 중..." : "💾 비콘 등록"}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ─── 4) 외국인 노동자 탭 (E-9/H-2 비자 + 4대보험 연계) ───────────
function ForeignWorkerTab() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = getSupabase();
        const { data, error } = await sb
          .from("staff")
          .select(`
            id, name, dept_code, contract_type, beacon_instance,
            visa_type, visa_expires_at, insurance_status, country,
            phone, hire_date, is_active
          `)
          .eq("dept_code", 0x03)
          .order("visa_expires_at", { ascending: true });
        if (error) throw error;
        setList(data || []);
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const today = new Date();
  const expiryStatus = (iso) => {
    if (!iso) return { tw: "bg-slate-400", label: "미입력" };
    const d = new Date(iso);
    const days = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
    if (days < 0)      return { tw: "bg-rose-700",   label: `만료 (${Math.abs(days)}일 초과)` };
    if (days <= 30)    return { tw: "bg-rose-500",   label: `${days}일 후 만료` };
    if (days <= 90)    return { tw: "bg-amber-500",  label: `${days}일 남음` };
    return                  { tw: "bg-emerald-500", label: `${days}일 남음` };
  };

  if (error) return <Alert variant="destructive"><AlertTitle>로드 실패</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;

  return (
    <div className="space-y-4">
      <Alert className="bg-orange-50 border-orange-200">
        <AlertTitle className="text-orange-800">🌏 외국인 노동자 관리 (RLS: 관리부만 조회)</AlertTitle>
        <AlertDescription className="text-orange-700 text-sm">
          E-9 (비전문취업) / H-2 (방문취업) 비자 만료 + 4대보험 가입 상태 통합 관리.
          비콘 부서 코드 = 0x03.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>외국인 노동자 ({list.length}명)</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <div className="py-10 text-center text-slate-400">로딩...</div> : list.length === 0 ? (
            <div className="py-10 text-center text-slate-400">등록된 외국인 노동자가 없습니다.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead><TableHead>국적</TableHead>
                  <TableHead>비자</TableHead><TableHead>만료일</TableHead>
                  <TableHead>4대보험</TableHead><TableHead>계약</TableHead>
                  <TableHead>비콘</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map(s => {
                  const e = expiryStatus(s.visa_expires_at);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-semibold">{s.name}</TableCell>
                      <TableCell>{s.country || "—"}</TableCell>
                      <TableCell><Badge variant="outline">{s.visa_type || "—"}</Badge></TableCell>
                      <TableCell>
                        <div className="text-xs">{s.visa_expires_at || "—"}</div>
                        <Badge className={`${e.tw} text-white mt-1`}>{e.label}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.insurance_status === "active" ? "default" : "secondary"}>
                          {s.insurance_status === "active" ? "가입" : "미가입"}
                        </Badge>
                      </TableCell>
                      <TableCell>{s.contract_type || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.beacon_instance ? s.beacon_instance.slice(-6) : <span className="text-rose-500">미등록</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
