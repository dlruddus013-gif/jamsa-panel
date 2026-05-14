// 🌦️ 기상청(KMA) 공식 API 프록시
// 단기예보·초단기실황·기상특보를 한 번에 조회하여 정규화된 JSON으로 반환.
// 환경변수 KMA_API_KEY 필요 (data.go.kr 기상청_단기예보 + 기상특보 신청).
// 미설정 시 503 반환 → 프론트엔드는 Open-Meteo로 폴백.
//
// CORS: data.go.kr은 브라우저 직접 호출 차단 → 반드시 서버 프록시 필요.

const KMA_BASE = "https://apis.data.go.kr/1360000";

// 위경도 → 기상청 격자좌표 (Lambert Conformal Conic 투영)
function latLngToKmaGrid(lat, lng) {
  const RE=6371.00877, GRID=5.0, SLAT1=30.0, SLAT2=60.0, OLON=126.0, OLAT=38.0, XO=43, YO=136;
  const DEGRAD = Math.PI/180.0;
  const re = RE/GRID;
  const slat1 = SLAT1*DEGRAD, slat2 = SLAT2*DEGRAD, olon = OLON*DEGRAD, olat = OLAT*DEGRAD;
  let sn = Math.tan(Math.PI*0.25 + slat2*0.5) / Math.tan(Math.PI*0.25 + slat1*0.5);
  sn = Math.log(Math.cos(slat1)/Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI*0.25 + slat1*0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI*0.25 + olat*0.5);
  ro = re*sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI*0.25 + lat*DEGRAD*0.5);
  ra = re*sf / Math.pow(ra, sn);
  let theta = lng*DEGRAD - olon;
  if (theta > Math.PI) theta -= 2*Math.PI;
  if (theta < -Math.PI) theta += 2*Math.PI;
  theta *= sn;
  const x = Math.floor(ra*Math.sin(theta) + XO + 0.5);
  const y = Math.floor(ro - ra*Math.cos(theta) + YO + 0.5);
  return { x, y };
}

// KST(UTC+9) 기준 현재 시각
function kstNow() {
  const now = new Date();
  return new Date(now.getTime() + 9*3600000);
}
function pad(n) { return String(n).padStart(2, "0"); }
function ymd(d) { return d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()); }

// 초단기실황 baseTime — 매시 40분 이후에 정시 데이터 발표
function ultraNcstBase() {
  const k = kstNow();
  let h = k.getUTCHours();
  if (k.getUTCMinutes() < 40) {
    h--;
    if (h < 0) { k.setUTCDate(k.getUTCDate()-1); h = 23; }
  }
  return { base_date: ymd(k), base_time: pad(h) + "00" };
}

// 단기예보 baseTime — 02/05/08/11/14/17/20/23시 발표 (각 발표 후 10~30분 뒤 조회 가능)
function vilageFcstBase() {
  const k = kstNow();
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  const h = k.getUTCHours();
  const m = k.getUTCMinutes();
  // 발표 후 30분 buffer
  const cutoff = h * 100 + m;
  for (const s of slots) {
    const slotCutoff = s * 100 + 30;
    if (cutoff >= slotCutoff || (s === 23 && cutoff < slotCutoff)) {
      // 23시 슬롯이지만 현재 시간이 그 이전이면 어제 23시 사용
      if (s === 23 && cutoff < 2330) {
        const yest = new Date(k); yest.setUTCDate(yest.getUTCDate()-1);
        return { base_date: ymd(yest), base_time: "2300" };
      }
      return { base_date: ymd(k), base_time: pad(s) + "00" };
    }
  }
  // 자정~02:30 사이는 어제 23시
  const yest = new Date(k); yest.setUTCDate(yest.getUTCDate()-1);
  return { base_date: ymd(yest), base_time: "2300" };
}

// 기상특보 발효현황 — 충북 stnId 105 (전국=108, 충청북도=131)
// 기상청 stnId 표 (특보 발표 지점):
//   108 전국  131 충청북도  133 대전·세종·충청남도  ...
const STN_BY_REGION = { "충북":"131", "전국":"108" };

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // 일부 응답이 SERVICE_KEY_IS_NOT_REGISTERED_ERROR 등 XML 에러
    if (text.startsWith("<")) throw new Error("XML error response (key issue)");
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

// 초단기실황 카테고리 매핑
// T1H=기온(℃), REH=습도(%), WSD=풍속(m/s), PTY=강수형태(0없음/1비/2비눈/3눈/5빗방울/6빗방울눈날림/7눈날림),
// RN1=1시간강수량(mm), VEC=풍향(deg), UUU=동서바람, VVV=남북바람
function parseUltraNcst(items) {
  const o = {};
  for (const it of items || []) o[it.category] = it.obsrValue;
  return {
    temp: parseFloat(o.T1H ?? "0"),
    humidity: parseFloat(o.REH ?? "0"),
    windSpeed: parseFloat(o.WSD ?? "0"),
    windDir: parseFloat(o.VEC ?? "0"),
    precipNow: parseFloat(o.RN1 ?? "0"),
    pty: parseInt(o.PTY ?? "0", 10),
    raw: o,
  };
}

// 단기예보 — 시간별 (3일치). 카테고리:
// TMP=기온, REH=습도, WSD=풍속, POP=강수확률, PCP=1시간강수량, PTY=강수형태, SKY=하늘상태,
// TMN=일최저, TMX=일최고
function parseVilageFcst(items) {
  const byTime = new Map();
  for (const it of items || []) {
    const k = `${it.fcstDate}_${it.fcstTime}`;
    if (!byTime.has(k)) byTime.set(k, { fcstDate: it.fcstDate, fcstTime: it.fcstTime });
    byTime.get(k)[it.category] = it.fcstValue;
  }
  const arr = [...byTime.values()].sort((a,b) => (a.fcstDate+a.fcstTime).localeCompare(b.fcstDate+b.fcstTime));
  return arr.slice(0, 24).map(h => ({
    date: h.fcstDate,
    time: h.fcstTime,
    temp: parseFloat(h.TMP ?? "0"),
    humidity: parseFloat(h.REH ?? "0"),
    windGust: parseFloat(h.WSD ?? "0"),
    precipProb: parseInt(h.POP ?? "0", 10),
    precip: h.PCP === "강수없음" ? 0 : parseFloat((h.PCP ?? "0").replace(/[^0-9.]/g,"")) || 0,
    sky: parseInt(h.SKY ?? "0", 10), // 1맑음 3구름많음 4흐림
    pty: parseInt(h.PTY ?? "0", 10),
  }));
}

// 기상특보 — title에서 종류/등급 추출
// 예: "[발표 9시 30분 발효 9시 30분] 충청북도 청주, 보은, 진천: 건조주의보"
function parseWarnings(items) {
  const out = [];
  for (const it of items || []) {
    const title = String(it.title || it.t6 || "");
    const text = title + " " + (it.t6 || "");
    let kind = null;
    if (/폭염/.test(text)) kind = /경보/.test(text) ? "HEAT_WARN" : "HEAT_ADV";
    else if (/한파/.test(text)) kind = /경보/.test(text) ? "COLD_WARN" : "COLD_ADV";
    else if (/강풍/.test(text)) kind = /경보/.test(text) ? "WIND_WARN" : "WIND_ADV";
    else if (/호우/.test(text)) kind = /경보/.test(text) ? "RAIN_WARN" : "RAIN_ADV";
    else if (/건조/.test(text)) kind = /경보/.test(text) ? "DRY_WARN" : "DRY_ADV";
    else if (/대설/.test(text)) kind = "SNOW";
    else if (/태풍/.test(text)) kind = "TYPHOON";
    else if (/뇌우|낙뢰/.test(text)) kind = "THUNDER";
    else if (/황사/.test(text)) kind = "DUST";
    if (!kind) continue;
    out.push({
      k: kind,
      title: title.replace(/\s+/g," ").trim(),
      area: String(it.t1 || it.areaName || "").trim(),
      issuedAt: it.tmFc || it.tm_fc || null,
      endsAt: it.tmEf || it.tm_ef || null,
      official: true, // 기상청 공식 발표
    });
  }
  return out;
}

export default async function handler(req, res) {
  const KMA_KEY = process.env.KMA_API_KEY;
  if (!KMA_KEY) {
    return res.status(503).json({
      ok: false,
      error: "kma_key_not_configured",
      hint: "Vercel 환경변수 KMA_API_KEY를 설정하세요. (data.go.kr → 기상청_단기예보 + 기상청_기상특보 신청)",
    });
  }

  const lat = parseFloat(req.query.lat) || 36.6383333;
  const lng = parseFloat(req.query.lng) || 127.3827778;
  const grid = latLngToKmaGrid(lat, lng);
  const stn = (req.query.stn) || "131"; // 충청북도 기본
  const ncstBase = ultraNcstBase();
  const fcstBase = vilageFcstBase();

  // KMA serviceKey는 이미 URL 인코딩되어 있을 수 있어 양쪽 케이스 모두 처리
  const key = encodeURIComponent(decodeURIComponent(KMA_KEY));

  const ncstUrl =
    `${KMA_BASE}/VilageFcstInfoService_2.0/getUltraSrtNcst` +
    `?serviceKey=${key}&pageNo=1&numOfRows=10&dataType=JSON` +
    `&base_date=${ncstBase.base_date}&base_time=${ncstBase.base_time}` +
    `&nx=${grid.x}&ny=${grid.y}`;

  const fcstUrl =
    `${KMA_BASE}/VilageFcstInfoService_2.0/getVilageFcst` +
    `?serviceKey=${key}&pageNo=1&numOfRows=300&dataType=JSON` +
    `&base_date=${fcstBase.base_date}&base_time=${fcstBase.base_time}` +
    `&nx=${grid.x}&ny=${grid.y}`;

  // 기상특보 발효현황 — 오늘 ~ 내일까지
  const today = ymd(kstNow());
  const tomorrow = ymd(new Date(kstNow().getTime() + 86400000));
  const wrnUrl =
    `${KMA_BASE}/WthrWrnInfoService/getWthrWrnList` +
    `?serviceKey=${key}&pageNo=1&numOfRows=100&dataType=JSON` +
    `&stnId=${stn}&fromTmFc=${today}&toTmFc=${tomorrow}`;

  try {
    const [ncstJson, fcstJson, wrnJson] = await Promise.all([
      fetchJson(ncstUrl).catch(e => ({ _err: "ncst:" + e.message })),
      fetchJson(fcstUrl).catch(e => ({ _err: "fcst:" + e.message })),
      fetchJson(wrnUrl).catch(e => ({ _err: "wrn:" + e.message })),
    ]);

    const errs = [ncstJson._err, fcstJson._err, wrnJson._err].filter(Boolean);
    if (errs.length === 3) {
      return res.status(502).json({ ok: false, error: "all_kma_endpoints_failed", details: errs });
    }

    const current = ncstJson._err ? null : parseUltraNcst(ncstJson?.response?.body?.items?.item);
    const hourly = fcstJson._err ? [] : parseVilageFcst(fcstJson?.response?.body?.items?.item);
    const warnings = wrnJson._err ? [] : parseWarnings(wrnJson?.response?.body?.items?.item);

    // 다음 1h, 24h 강수 합계 (단기예보 기반)
    const precipNext1h = hourly[0]?.precip ?? 0;
    const precipNext24h = hourly.slice(0, 24).reduce((s,h)=>s+(h.precip||0), 0);

    // 응답을 Open-Meteo와 동일한 스키마로 정규화 → 프론트엔드 코드 변경 최소화
    const out = {
      ok: true,
      source: "KMA",
      sourceLabel: "📡 기상청 공식",
      fetchedAt: new Date().toISOString(),
      grid,
      current: current ? {
        temp: current.temp,
        humidity: current.humidity,
        feelsLike: current.temp - (current.windSpeed * 0.5), // 체감온도 근사
        windSpeed: current.windSpeed,
        windGust: current.windSpeed * 1.4, // KMA 실황은 순간풍속 미제공 → 풍속의 1.4배 근사
        weatherCode: pty2Wmo(current.pty, hourly[0]?.sky),
        precipNow: current.precipNow,
        precipNext1h,
        precipNext24h,
        isDay: kstNow().getUTCHours() >= 6 && kstNow().getUTCHours() < 19 ? 1 : 0,
      } : null,
      hourly: hourly.slice(0, 12).map(h => ({
        time: `${h.date.slice(0,4)}-${h.date.slice(4,6)}-${h.date.slice(6,8)}T${h.time.slice(0,2)}:${h.time.slice(2,4)}:00+09:00`,
        temp: h.temp,
        precipProb: h.precipProb,
        precip: h.precip,
        windGust: h.windGust * 1.4,
      })),
      warnings, // 기상청 공식 발효 특보 (이미 추출됨)
      partial: errs.length > 0 ? errs : null,
    };

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// 기상청 PTY/SKY → WMO 코드 (프론트의 wmoLabel 호환용)
function pty2Wmo(pty, sky) {
  if (pty === 1) return 63; // 비
  if (pty === 2) return 65; // 비/눈
  if (pty === 3) return 73; // 눈
  if (pty === 5) return 51; // 빗방울
  if (pty === 6) return 71; // 빗방울눈날림
  if (pty === 7) return 71; // 눈날림
  // 강수 없음 → SKY로 판정
  if (sky === 1) return 0;  // 맑음
  if (sky === 3) return 2;  // 구름많음
  if (sky === 4) return 3;  // 흐림
  return 0;
}
