// 잠사 Minew 대시보드 — 5초 폴링 (SSE 대신 단순 폴링으로 충분)
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const escapeHtml = (s) => String(s ?? "").replace(/[<>&"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;"}[c]));

const fmtTime = (iso) => {
  if (!iso) return "-";
  try { return new Date(iso).toLocaleTimeString("ko-KR", { hour12:false }); }
  catch(_) { return iso; }
};
const fmtFull = (iso) => {
  if (!iso) return "-";
  try { return new Date(iso).toLocaleString("ko-KR"); }
  catch(_) { return iso; }
};

const rssiBadge = (status) => {
  if (!status) return '<span class="badge">-</span>';
  const cls = status.label === "이탈 가능성" ? "badge-err"
    : status.label === "약함" ? "badge-warn"
    : status.label === "보통" ? "badge"
    : "badge-fresh";
  return `<span class="badge ${cls}">${escapeHtml(status.label)}</span>`;
};

const typeBadge = (t) => {
  const cls = t === "tlm" ? "tag-tlm"
    : (t === "uid" || t === "ucid") ? "tag-uid"
    : (t === "ibeacon" || t === "ib") ? "tag-ibeacon"
    : "tag-unmapped";
  return `<span class="badge ${cls}">${escapeHtml(t || "?")}</span>`;
};

function tagBadge(e) {
  if (e.tag_id) {
    return `<span class="badge tag-mapped">${escapeHtml(e.tag_id)}</span>`
      + (e.identity?.label ? ` <span class="dim">${escapeHtml(e.identity.label)}</span>` : "");
  }
  return `<span class="badge tag-unmapped">미등록</span>`
    + (e.identity?.label ? ` <span class="dim">${escapeHtml(e.identity.label)}</span>` : "");
}

let _lastEventId = 0;

async function loadSummary() {
  try {
    const r = await fetch("/api/dashboard-summary", {cache:"no-store"});
    const d = await r.json();
    $("#summary").innerHTML = `
      <div class="card"><div class="label">서버 상태</div><div class="value ok">✓ ok</div></div>
      <div class="card"><div class="label">총 패킷</div><div class="value">${d.packets ?? 0}</div></div>
      <div class="card"><div class="label">총 이벤트</div><div class="value">${d.events ?? 0}</div></div>
      <div class="card"><div class="label">게이트웨이</div><div class="value">${d.gateways ?? 0}</div></div>
      <div class="card"><div class="label">활성 태그(전체)</div><div class="value">${d.active_tags ?? 0}</div></div>
      <div class="card"><div class="label">유니크 비콘 MAC</div><div class="value">${d.unique_beacons ?? 0}</div></div>
      <div class="card"><div class="label">현재 온라인 태그(5분)</div><div class="value ${d.online_count>0?'ok':'warn'}">${d.online_count ?? 0}</div></div>
      <div class="card"><div class="label">마지막 이벤트</div><div class="value" style="font-size:13px">${fmtFull(d.last_event_at)}</div></div>
    `;
    // unmapped
    const um = d.unmapped_recent || [];
    $("#unmapped-table tbody").innerHTML = um.length === 0
      ? '<tr><td colspan="4" class="dim" style="text-align:center;padding:14px">미등록 식별자 없음 ✓</td></tr>'
      : um.map(r => `<tr>
          <td class="mono">${escapeHtml(r.beacon_mac ?? "-")}</td>
          <td>${r.major != null ? `${r.major} / ${r.minor}` : "-"}</td>
          <td class="mono">${r.namespace ? escapeHtml((r.namespace).slice(0,12)+"…") + " / " + escapeHtml((r.instance||"").slice(0,12)) : "-"}</td>
          <td class="mono">${fmtTime(r.last_seen)}</td>
        </tr>`).join("");
  } catch(e) { console.warn(e); }
}

async function loadTags() {
  try {
    const r = await fetch("/api/tags", {cache:"no-store"});
    const d = await r.json();
    const now = Date.now();
    $("#tags-table tbody").innerHTML = d.tags.length === 0
      ? '<tr><td colspan="9" class="dim" style="text-align:center;padding:14px">등록된 태그 없음</td></tr>'
      : d.tags.map(t => {
          const isOnline = t.last_seen && (now - new Date(t.last_seen).getTime() < 5*60*1000);
          return `<tr class="${isOnline?'fresh':''}">
            <td><span class="badge tag-staff">${escapeHtml(t.tag_id)}</span></td>
            <td><strong>${escapeHtml(t.owner_name||'-')}</strong> · ${escapeHtml(t.department||'-')}</td>
            <td>${escapeHtml(t.role||'-')}</td>
            <td><strong>${t.rssi_recent ?? '-'}</strong> dBm</td>
            <td>${rssiBadge(t.rssi_status)}</td>
            <td>${t.battery_mv ? (t.battery_mv/1000).toFixed(2)+'V' : '-'}</td>
            <td>${t.temperature != null ? t.temperature+'°C' : '-'}</td>
            <td class="mono">${fmtFull(t.last_seen)}</td>
            <td class="mono">
              ${t.uuid ? `<div>UUID ${escapeHtml((t.uuid||'').slice(0,8))}… <strong>${t.major}/${t.minor}</strong></div>`:''}
              ${t.namespace ? `<div>NS ${escapeHtml((t.namespace||'').slice(0,8))}…</div>`:''}
              ${t.beacon_mac ? `<div>MAC ${escapeHtml(t.beacon_mac)}</div>`:''}
            </td>
          </tr>`;
        }).join("");
  } catch(e) { console.warn(e); }
}

async function loadGateways() {
  try {
    const r = await fetch("/api/gateways", {cache:"no-store"});
    const d = await r.json();
    $("#gateways-table tbody").innerHTML = d.gateways.length === 0
      ? '<tr><td colspan="4" class="dim" style="text-align:center;padding:14px">수신된 게이트웨이 없음</td></tr>'
      : d.gateways.map(g => `<tr>
          <td class="mono"><strong>${escapeHtml(g.gateway_mac||'-')}</strong></td>
          <td class="mono">${escapeHtml(g.gateway_ip||'-')}</td>
          <td><strong>${g.packets}</strong></td>
          <td class="mono">${fmtFull(g.last_seen)}</td>
        </tr>`).join("");
  } catch(e) { console.warn(e); }
}

async function loadEvents() {
  try {
    const r = await fetch("/api/events/recent?limit=100", {cache:"no-store"});
    const d = await r.json();
    const newest = d.events[0]?.id || 0;
    const fresh = newest > _lastEventId;
    if (fresh) {
      _lastEventId = newest;
      $("#live-status").className = "badge badge-fresh";
      $("#live-status").textContent = "실시간";
    }
    $("#last-update").textContent = "갱신: " + new Date().toLocaleTimeString("ko-KR");
    $("#events-table tbody").innerHTML = d.events.length === 0
      ? '<tr><td colspan="10" class="dim" style="text-align:center;padding:14px">수신된 이벤트가 없습니다. curl로 테스트해보세요.</td></tr>'
      : d.events.slice(0,100).map(e => `<tr>
          <td class="mono">${fmtTime(e.received_at)}</td>
          <td>${tagBadge(e)}</td>
          <td>${typeBadge(e.packet_type)}</td>
          <td>${e.major != null ? `${e.major}/${e.minor}` : '-'}</td>
          <td><strong>${e.rssi ?? '-'}</strong></td>
          <td>${rssiBadge(e.rssi_status)}</td>
          <td>${e.battery_mv ? (e.battery_mv/1000).toFixed(2)+'V' : '-'}</td>
          <td class="mono">${escapeHtml(e.gateway_mac||'-')}</td>
          <td class="mono">${escapeHtml(e.beacon_mac||'-')}</td>
          <td><button class="json-btn" data-adv='${escapeHtml(e.raw_adv || "")}'>📄</button></td>
        </tr>`).join("");

    // JSON 모달 핸들러
    $$("#events-table .json-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const adv = btn.getAttribute("data-adv");
        try {
          $("#json-content").textContent = JSON.stringify(JSON.parse(adv), null, 2);
        } catch (_) {
          $("#json-content").textContent = adv;
        }
        $("#json-modal").classList.add("open");
      });
    });
  } catch(e) { console.warn(e); }
}

function closeModal(e) {
  if (e.target.id === "json-modal") {
    $("#json-modal").classList.remove("open");
  }
}

async function refresh() {
  await Promise.all([loadSummary(), loadTags(), loadGateways(), loadEvents()]);
}

refresh();
setInterval(refresh, 5000);
