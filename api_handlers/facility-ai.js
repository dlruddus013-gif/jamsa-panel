// api/facility-ai — 시설 유지보수 페이지(/facility)의 AI 지시·사진 분석
// 인증: 재고관리와 같은 관리자 세션 토큰(inv_login) → Supabase RPC inv_me 로 확인
// 모드:
//   plan  — 자연어 지시를 프로그램 동작(JSON actions)으로 변환. 실제 실행은 브라우저에서 확인 후 수행
//   json  — 사진 분석 인포그래픽 등 JSON 응답 (이미지 1장 선택)
// 환경변수: ANTHROPIC_API_KEY(또는 OPENAI_API_KEY), ANTHROPIC_MODEL, SUPABASE_URL

const SB_URL = process.env.SUPABASE_URL || 'https://ewxquecxsxsfhyzfaaci.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_G2wWHOhRazQUn2nkNr7ZWg_xasgzW_O';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const hits = new Map(); // 토큰별 분당 호출 제한
function limited(key) {
  const now = Date.now(), w = 60_000, max = 20;
  const arr = (hits.get(key) || []).filter(t => now - t < w);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}

async function whoami(token) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/inv_me', {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const PLAN_SYSTEM = `너는 한국잠사박물관 "시설 유지보수·개발 관리" 프로그램 안에서 일하는 실행 비서다.
사용자의 한국어 지시를 이 프로그램이 실행할 수 있는 동작 목록(JSON)으로 바꾼다. 너는 데이터를 직접 바꾸지 않는다. 브라우저가 동작을 보여주고 사용자가 확인하면 실행한다.

반드시 JSON 객체 하나만 답한다:
{"reply":"사용자에게 보여줄 짧은 한국어 설명(무엇을 할지, 2~3문장)","actions":[ ... ]}

사용할 수 있는 동작(type) — 필드는 필요한 것만 쓴다:
1) {"type":"view","tab":"dash|orders|assets|photos|safety|projects|weather|routine|vendors|cost","photoMode":"grid|list|matrix|edit|zone","filter":{...사진필터}}
   화면 이동·필터 적용. 조회 요청이면 이것과 query를 함께 쓴다.
2) {"type":"query","target":"photos|orders|assets|routines","where":{...},"groupBy":"zone|cat|year|month|sev|status|tag|none","title":"표 제목"}
   개수·목록 질문에 답할 때. 숫자는 네가 지어내지 말고 query로 브라우저가 계산하게 한다.
3) {"type":"update_photos","where":{...사진필터},"set":{"st":"조치 필요|조치중|조치완료|해당없음","zone":"","cat":"","sev":"상|중|하","issue":true,"note":"","subj":"","desc":""}}
4) {"type":"create_order","fields":{"title":"","zone":"","type":"고장수리|정기점검|개선|청소·미화|안전조치|공사","category":"","priority":"긴급|높음|보통|낮음","dueDate":"YYYY-MM-DD","assignee":"","desc":""},"fromPhotos":{...사진필터, 선택}}
   fromPhotos를 주면 조건에 맞는 문제 사진마다 작업지시를 하나씩 만든다(최대 50).
5) {"type":"update_orders","where":{"zone":"","status":"접수|진행|보류|완료|기록|미완료","q":"검색어","from":"YYYY-MM-DD","to":"YYYY-MM-DD","priority":""},"set":{"status":"","priority":"","assignee":"","dueDate":""}}
6) {"type":"create_routine","fields":{"title":"","freq":"매일|매주|매월|매년","dom":1,"dows":[1],"months":[3],"zone":"","category":"","legal":false,"assignee":"","detail":"","basis":""}}
7) {"type":"note","text":"사용자가 알아야 할 주의·한계"}

사진필터(where/filter) 필드: {"zone":"시설명","cat":"분류","from":"YYYY-MM","to":"YYYY-MM","issue":true,"sev":"상|중|하","status":"미처리|미확인|조치 필요|조치중|조치완료|해당없음","q":"검색어(태그·내용, 띄어쓰기는 AND)","tag":"태그"}
- 시설명은 아래 목록에서 가장 가까운 것을 쓴다. 분류도 목록에서 고른다.
- "올해", "작년", "지난달" 같은 기간은 오늘 날짜 기준으로 YYYY-MM으로 바꾼다.
- 지시가 모호하면 가장 합리적인 해석을 쓰고 reply에 어떻게 해석했는지 적는다. 위험한 대량 변경(100건 넘게)은 note로 경고한다.
- 프로그램 기능 밖의 요청(외부 발송, 결제 등)은 actions 없이 reply로 할 수 없다고 말한다.`;

async function callClaude({ system, prompt, imageB64, maxTokens }) {
  const content = [{ type: 'text', text: prompt }];
  const m = (imageB64 || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw Object.assign(new Error('api_error'), { status: r.status, raw: (await r.text()).slice(0, 300) });
  const j = await r.json();
  return { text: (j.content || []).map(b => b.text || '').join(''), model: ANTHROPIC_MODEL };
}

async function callOpenAI({ system, prompt, imageB64, maxTokens }) {
  const content = [{ type: 'text', text: prompt }];
  if (imageB64) content.push({ type: 'image_url', image_url: { url: imageB64 } });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: maxTokens, response_format: { type: 'json_object' },
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }] }),
  });
  if (!r.ok) throw Object.assign(new Error('api_error'), { status: r.status, raw: (await r.text()).slice(0, 300) });
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || '', model: OPENAI_MODEL };
}

function parseJSON(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.json({ ok: true, ready: !!(ANTHROPIC_API_KEY || OPENAI_API_KEY), model: ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : OPENAI_API_KEY ? OPENAI_MODEL : null });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { token, mode = 'plan', prompt = '', context = '', imageB64 = '' } = body || {};
  if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const user = await whoami(token);
  if (!user || !user.id) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (limited(user.id)) return res.status(429).json({ ok: false, error: 'rate_limited', message: '요청이 많습니다. 1분 뒤 다시 시도해 주세요.' });
  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) return res.status(503).json({ ok: false, error: 'no_api_key', message: 'Vercel 환경변수에 ANTHROPIC_API_KEY(또는 OPENAI_API_KEY)가 없습니다.' });
  if (!String(prompt).trim() || String(prompt).length > 6000) return res.status(400).json({ ok: false, error: 'bad_prompt' });
  if (String(context).length > 80_000) return res.status(413).json({ ok: false, error: 'context_too_large' });
  if (imageB64 && imageB64.length > 4_500_000) return res.status(413).json({ ok: false, error: 'image_too_large' });

  const isPlan = mode === 'plan';
  const system = isPlan ? PLAN_SYSTEM : undefined;
  const userPrompt = isPlan ? `[프로그램 현황]\n${context}\n\n[사용자 지시]\n${prompt}` : String(prompt);
  try {
    const call = ANTHROPIC_API_KEY ? callClaude : callOpenAI;
    const out = await call({ system, prompt: userPrompt, imageB64: isPlan ? '' : imageB64, maxTokens: isPlan ? 2000 : 2500 });
    const parsed = parseJSON(out.text);
    if (!parsed) return res.status(502).json({ ok: false, error: 'invalid_json', text: out.text.slice(0, 500) });
    return res.json({ ok: true, model: out.model, result: parsed });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'api_error', status: e.status || null, message: '모델 호출 실패' });
  }
}
