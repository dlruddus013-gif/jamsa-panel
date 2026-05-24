"""
AI 법률 종합 플랫폼 — 통합 서버 v3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
기획서 기반 엘박스 맞춤형 판례 검색 시스템

구조:
  [모듈 A] Claude → 엘박스 검색 파라미터 추출 (사건부호+키워드)
  [모듈 B] 판례 + 질문 → 법률 자문 리포트 생성
  [DB]    SQLite 판례 캐시 (lbox_precedents 테이블)

사용법: python api_proxy.py
       http://localhost:8401
"""
import os,json,sys,pathlib,threading,webbrowser,time,re,sqlite3
try:
    from fastapi import FastAPI,Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse,HTMLResponse
    import httpx,uvicorn
except ImportError:
    os.system(f"{sys.executable} -m pip install fastapi uvicorn httpx -q")
    from fastapi import FastAPI,Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse,HTMLResponse
    import httpx,uvicorn

HERE=pathlib.Path(__file__).parent
PORT=8401

# ═══════════════════════════════════════════════
# 1. 설정 로드
# ═══════════════════════════════════════════════
API_KEY=''
for a in sys.argv[1:]:
    if a.startswith('sk-'): API_KEY=a
    elif a.startswith('--key='):API_KEY=a.split('=',1)[1]
if not API_KEY:
    kf=HERE/'api_key.txt'
    if kf.exists(): API_KEY=kf.read_text(encoding='utf-8').strip()
if not API_KEY:
    API_KEY=os.environ.get('ANTHROPIC_API_KEY','')
if not API_KEY:
    API_KEY=input("Anthropic API Key: ").strip()
    if API_KEY: (HERE/'api_key.txt').write_text(API_KEY,encoding='utf-8')

LBOX_EMAIL=''; LBOX_PW=''
lf=HERE/'lbox_key.txt'
if lf.exists():
    lines=lf.read_text(encoding='utf-8').strip().split('\n')
    if len(lines)>=2: LBOX_EMAIL,LBOX_PW=lines[0].strip(),lines[1].strip()

# ═══════════════════════════════════════════════
# 2. 카테고리 & 사건부호 매핑 (기획서 §2)
# ═══════════════════════════════════════════════
TAXONOMY = {
    "민사": {
        "sub": {
            "부동산/임대차": {
                "keywords": ["전세사기","보증금반환","기획부동산","임대차","전세","월세","명도","퇴거","부동산"],
                "codes": {"1심":["가합","가단","가소"],"항소":["나"],"상고":["다"]}
            },
            "손해배상/금전": {
                "keywords": ["떼인돈","사기피해","동업","투자","대여금","약정금","매매대금","용역대금","하도급","하자보수","지체상금"],
                "codes": {"1심":["가합","가단","가소"],"항소":["나"],"상고":["다","민상"]}
            },
            "계약분쟁": {
                "keywords": ["계약불이행","계약해제","계약해지","위약금","손해배상","채무불이행","이행지체","이행불능"],
                "codes": {"1심":["가합","가단"],"항소":["나"],"상고":["다"]}
            },
            "IT/소프트웨어": {
                "keywords": ["소프트웨어개발","시스템구축","플랫폼","MVP","앱개발","웹개발","프로그램","용역","SI","SM"],
                "codes": {"1심":["가합","가단"],"항소":["나"],"상고":["다"]}
            }
        },
        "default_codes": ["가합","가단","가소","나","다"]
    },
    "형사": {
        "sub": {
            "재산범죄": {
                "keywords": ["보이스피싱","중고거래사기","횡령","배임","사기","절도","장물"],
                "codes": {"1심":["고합","고단","고정"],"항소":["노"],"상고":["도"]}
            },
            "성범죄/강력": {
                "keywords": ["카메라등이용촬영","통매음","스토킹","성폭력","강간","성추행","아동","디지털성범죄"],
                "codes": {"1심":["고합","고단"],"항소":["노"],"상고":["도"]}
            },
            "교통/기타": {
                "keywords": ["음주운전","교통사고","폭행","상해","협박","명예훼손","모욕"],
                "codes": {"1심":["고단","고정"],"항소":["노"],"상고":["도"]}
            }
        },
        "default_codes": ["고합","고단","고정","노","도"]
    },
    "가사": {
        "sub": {
            "이혼/재산분할": {
                "keywords": ["이혼","위자료","양육비","재산분할","친권","면접교섭"],
                "codes": {"1심":["드합","드단","드소"],"항소":["르"],"상고":["므"]}
            },
            "상속": {
                "keywords": ["유산분할","상속","유류분","유언","상속포기","한정승인"],
                "codes": {"1심":["드합","드단"],"항소":["르"],"상고":["므"]}
            }
        },
        "default_codes": ["드합","드단","드소","르","므"]
    },
    "행정": {
        "sub": {
            "조세/노동": {
                "keywords": ["부당해고","임금체불","산재","세금","과세","국세","지방세"],
                "codes": {"1심":["구합","구단"],"항소":["누"],"상고":["두"]}
            },
            "인허가/기타": {
                "keywords": ["면허","허가","인가","취소","영업정지","행정처분"],
                "codes": {"1심":["구합","구단"],"항소":["누"],"상고":["두"]}
            }
        },
        "default_codes": ["구합","구단","누","두"]
    }
}

def classify_case(text):
    """텍스트에서 대분류/중분류/사건부호를 자동 분류"""
    text_lower=text.replace(' ','')
    best_cat=None; best_sub=None; best_score=0; best_codes=[]
    
    for cat_name, cat_data in TAXONOMY.items():
        for sub_name, sub_data in cat_data["sub"].items():
            score=sum(1 for kw in sub_data["keywords"] if kw in text_lower)
            if score>best_score:
                best_score=score; best_cat=cat_name; best_sub=sub_name
                # 모든 심급 코드 합침
                best_codes=[]
                for codes in sub_data["codes"].values():
                    best_codes.extend(codes)
    
    if not best_cat:
        best_cat="민사"; best_sub="손해배상/금전"; best_codes=TAXONOMY["민사"]["default_codes"]
    
    return {"main_category":best_cat,"sub_category":best_sub,"case_codes":best_codes,"confidence":best_score}

def get_all_codes(category):
    """카테고리의 모든 사건부호 반환"""
    cat=TAXONOMY.get(category,{})
    codes=[]
    for sub in cat.get("sub",{}).values():
        for c in sub.get("codes",{}).values():
            codes.extend(c)
    return list(set(codes)) or cat.get("default_codes",[])

# ═══════════════════════════════════════════════
# 3. SQLite 판례 캐시 DB (기획서 §2②)
# ═══════════════════════════════════════════════
DB_PATH=HERE/'lbox_cache.db'

def init_db():
    conn=sqlite3.connect(str(DB_PATH))
    conn.execute('''CREATE TABLE IF NOT EXISTS lbox_precedents (
        lbox_id TEXT PRIMARY KEY,
        case_number TEXT,
        case_code TEXT,
        main_category TEXT,
        court_name TEXT,
        judgment_date TEXT,
        case_name TEXT,
        facts TEXT,
        holding TEXT,
        dispositive TEXT,
        summary TEXT,
        reasoning TEXT,
        full_content TEXT,
        url TEXT,
        search_query TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_case_code ON lbox_precedents(case_code)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_case_number ON lbox_precedents(case_number)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_main_category ON lbox_precedents(main_category)')
    conn.commit(); conn.close()

def save_precedent(data):
    conn=sqlite3.connect(str(DB_PATH))
    try:
        conn.execute('''INSERT OR REPLACE INTO lbox_precedents 
            (lbox_id,case_number,case_code,main_category,court_name,judgment_date,
             case_name,facts,holding,dispositive,summary,reasoning,full_content,url,search_query)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (data.get('id',''),data.get('caseId',''),data.get('caseCode',''),
             data.get('mainCategory',''),data.get('court',''),data.get('date',''),
             data.get('title',''),data.get('facts',''),data.get('holding',''),
             data.get('dispositive',''),data.get('summary',''),data.get('reasoning',''),
             data.get('content',''),data.get('url',''),data.get('searchQuery','')))
        conn.commit()
    except: pass
    finally: conn.close()

def search_cache(query,case_codes=None,limit=10):
    conn=sqlite3.connect(str(DB_PATH))
    conn.row_factory=sqlite3.Row
    try:
        if case_codes:
            placeholders=','.join('?' for _ in case_codes)
            rows=conn.execute(f'''SELECT * FROM lbox_precedents 
                WHERE case_code IN ({placeholders})
                AND (case_number LIKE ? OR case_name LIKE ? OR facts LIKE ? OR holding LIKE ?)
                ORDER BY judgment_date DESC LIMIT ?''',
                (*case_codes,'%'+query+'%','%'+query+'%','%'+query+'%','%'+query+'%',limit)).fetchall()
        else:
            rows=conn.execute('''SELECT * FROM lbox_precedents 
                WHERE case_number LIKE ? OR case_name LIKE ? OR facts LIKE ? OR holding LIKE ?
                ORDER BY judgment_date DESC LIMIT ?''',
                ('%'+query+'%','%'+query+'%','%'+query+'%','%'+query+'%',limit)).fetchall()
        return [dict(r) for r in rows]
    except: return []
    finally: conn.close()

init_db()

# ═══════════════════════════════════════════════
# 4. FastAPI 앱
# ═══════════════════════════════════════════════
app=FastAPI(title="AI 법률 종합 플랫폼 v3")
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_methods=["*"],allow_headers=["*"])

lbox_logged_in=False; lbox_cookies={}
lbox_headers={"content-type":"application/json","origin":"https://www.lbox.kr","referer":"https://www.lbox.kr",
              "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

# ── HTML 서빙 ──
@app.get("/")
def serve_html():
    hp=HERE/"legal-analyzer.html"
    if hp.exists(): return HTMLResponse(hp.read_text(encoding='utf-8'))
    return HTMLResponse("<h1>legal-analyzer.html not found</h1>")

@app.get("/status")
def proxy_status():
    conn=sqlite3.connect(str(DB_PATH))
    cache_count=conn.execute("SELECT COUNT(*) FROM lbox_precedents").fetchone()[0]
    conn.close()
    return {"ok":True,"key_set":bool(API_KEY),"key_prefix":API_KEY[:12]+"...",
            "cache_count":cache_count,"taxonomy_categories":list(TAXONOMY.keys())}

# ── Claude API 프록시 ──
@app.post("/v1/messages")
async def proxy_claude(request:Request):
    body_bytes=await request.body()
    body=json.loads(body_bytes)
    model=body.get('model','?')
    mt=body.get('max_tokens','?')
    msg_len=len(body_bytes)
    img_count=0
    # 이미지 개수 카운트
    for m in body.get('messages',[]):
        c=m.get('content',[])
        if isinstance(c,list):
            img_count+=sum(1 for x in c if isinstance(x,dict) and x.get('type')=='image')
    print(f"[Claude] model={model} tokens={mt} payload={msg_len//1024}KB images={img_count}")
    
    max_retries=5
    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=600.0,verify=True,limits=httpx.Limits(max_connections=5)) as c:
                # 대용량 이미지 페이로드 지원
                r=await c.post("https://api.anthropic.com/v1/messages",
                    content=json.dumps(body,ensure_ascii=False).encode('utf-8'),
                    headers={"x-api-key":API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"})
                resp=r.json()
                
                if r.status_code==200:
                    out_len=sum(len(x.get('text','')) for x in resp.get('content',[]) if x.get('type')=='text')
                    print(f"[Claude] OK output={out_len}chars")
                    return JSONResponse(content=resp,status_code=200)
                
                elif r.status_code==429:
                    # Rate limit — 대기 후 재시도
                    retry_after=int(r.headers.get('retry-after',15))
                    wait=min(60,max(retry_after,15*(attempt+1)))
                    print(f"[Claude] 429 Rate limit — {wait}초 대기 후 재시도 ({attempt+1}/{max_retries})")
                    import asyncio
                    await asyncio.sleep(wait)
                    continue
                
                else:
                    print(f"[Claude] FAIL {r.status_code}: {json.dumps(resp,ensure_ascii=False)[:300]}")
                    return JSONResponse(content=resp,status_code=r.status_code)
        
        except httpx.ConnectError as e:
            print(f"[Claude] CONNECTION ERROR: {e}")
            return JSONResponse(content={"error":{"message":f"API 연결 실패: {e}"}},status_code=500)
        except httpx.TimeoutException as e:
            print(f"[Claude] TIMEOUT: {e}")
            return JSONResponse(content={"error":{"message":f"API 타임아웃: {e}"}},status_code=504)
        except Exception as e:
            print(f"[Claude] ERROR: {type(e).__name__}: {e}")
            return JSONResponse(content={"error":{"message":str(e)}},status_code=500)
    
    return JSONResponse(content={"error":{"message":"Rate limit 초과 — 잠시 후 다시 시도해주세요"}},status_code=429)

# ═══════════════════════════════════════════════
# 5. 엘박스 인증
# ═══════════════════════════════════════════════
@app.get("/api/status")
def lbox_status():
    conn=sqlite3.connect(str(DB_PATH))
    cache_count=conn.execute("SELECT COUNT(*) FROM lbox_precedents").fetchone()[0]
    conn.close()
    return {"logged_in":lbox_logged_in,"email":LBOX_EMAIL if lbox_logged_in else "",
            "cache_count":cache_count}

@app.post("/api/login")
async def lbox_login(request:Request):
    """엘박스 로그인 — 실제 브라우저 창 열기"""
    global lbox_logged_in,lbox_cookies,LBOX_EMAIL,LBOX_PW
    body=await request.json()
    email=body.get('email','')
    password=body.get('password','')
    provider=body.get('provider','')  # naver, kakao, google, apple, or empty for email
    
    result=await _browser_login(email,password,provider)
    if result.get('ok'):
        return {"ok":True,"method":result.get('method','browser')}
    return JSONResponse(content={"detail":result.get('error','Login failed')},status_code=401)

async def _browser_login(email='',password='',provider=''):
    """실제 브라우저 창을 열어 사용자가 직접 로그인 → 쿠키 캡처"""
    global lbox_logged_in,lbox_cookies,lbox_headers,LBOX_EMAIL,LBOX_PW
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("[LBox] Playwright 설치 중...")
        os.system(f"{sys.executable} -m pip install playwright -q")
        os.system(f"{sys.executable} -m playwright install chromium")
        from playwright.async_api import async_playwright
    
    method=provider or 'email'
    print(f"[LBox] 브라우저 로그인 시작 ({method})")
    
    try:
        async with async_playwright() as p:
            # ★ headless=False — 실제 브라우저 창이 열림 ★
            browser=await p.chromium.launch(headless=False)
            ctx=await browser.new_context()
            page=await ctx.new_page()
            
            await page.goto("https://lbox.kr/v2/login",wait_until="networkidle",timeout=30000)
            await page.wait_for_timeout(2000)
            
            if provider:
                # 소셜 로그인 버튼 클릭
                btn_map={
                    'naver':'네이버','kakao':'카카오톡','google':'구글','apple':'Apple'
                }
                btn_text=btn_map.get(provider,provider)
                try:
                    btn=await page.query_selector(f'button:has-text("{btn_text}")')
                    if not btn: btn=await page.query_selector(f'a:has-text("{btn_text}")')
                    if not btn: btn=await page.query_selector(f'div:has-text("{btn_text}")')
                    if btn:
                        await btn.click()
                        print(f"[LBox] {btn_text} 버튼 클릭됨")
                except Exception as be:
                    print(f"[LBox] 버튼 클릭 실패: {be}")
                print(f"[LBox] 브라우저에서 {btn_text} 로그인을 완료해주세요 (최대 3분)")
            
            elif email and password:
                # 이메일/비밀번호 자동 입력
                try:
                    inputs=await page.query_selector_all('input')
                    for inp in inputs:
                        inp_type=await inp.get_attribute('type') or ''
                        placeholder=await inp.get_attribute('placeholder') or ''
                        if inp_type=='email' or '이메일' in placeholder:
                            await inp.fill(email)
                        elif inp_type=='password' or '비밀번호' in placeholder:
                            await inp.fill(password)
                    print(f"[LBox] 이메일/비밀번호 입력됨 — 로그인 버튼을 클릭해주세요")
                except:
                    print(f"[LBox] 브라우저에서 직접 입력해주세요")
            else:
                print(f"[LBox] 브라우저에서 로그인해주세요 (최대 3분)")
            
            # ★ 로그인 완료 대기 — URL이 /v2/login에서 벗어날 때까지 ★
            import asyncio
            for i in range(180):  # 최대 3분
                await asyncio.sleep(1)
                try:
                    url=page.url
                    if '/v2/login' not in url and '/login' not in url:
                        print(f"[LBox] 로그인 감지: {url}")
                        await asyncio.sleep(2)  # 쿠키 안정화 대기
                        break
                except:
                    break
            
            # 쿠키 캡처
            cookies=await ctx.cookies()
            lbox_cookies={}
            for ck in cookies:
                if 'lbox' in ck.get('domain',''):
                    lbox_cookies[ck['name']]=ck['value']
            
            # 모든 쿠키도 포함 (세션 쿠키가 다른 도메인에 있을 수 있음)
            if len(lbox_cookies)<2:
                for ck in cookies:
                    lbox_cookies[ck['name']]=ck['value']
            
            await browser.close()
            
            if len(lbox_cookies)>0:
                lbox_logged_in=True
                if email: LBOX_EMAIL=email
                if password: LBOX_PW=password
                if email and password:
                    (HERE/'lbox_key.txt').write_text(f"{email}\n{password}",encoding='utf-8')
                cookie_str='; '.join(f"{k}={v}" for k,v in lbox_cookies.items())
                lbox_headers['Cookie']=cookie_str
                (HERE/'lbox_cookies.json').write_text(json.dumps(lbox_cookies),encoding='utf-8')
                print(f"[LBox] 로그인 완료! ({len(lbox_cookies)} cookies)")
                return {"ok":True,"method":method}
            else:
                print(f"[LBox] 로그인 실패 — 쿠키 없음")
                return {"ok":False,"error":"로그인이 완료되지 않았습니다"}
    
    except Exception as e:
        print(f"[LBox] 브라우저 로그인 오류: {e}")
        return {"ok":False,"error":str(e)}

@app.post("/api/social-login")
async def lbox_social_login(request:Request):
    """소셜 로그인 — /api/login으로 통합"""
    body=await request.json()
    provider=body.get('provider','naver')
    result=await _browser_login(provider=provider)
    if result.get('ok'):
        return {"ok":True,"provider":provider}
    return JSONResponse(content={"detail":result.get('error','')},status_code=401)

# ═══════════════════════════════════════════════
# 6. [모듈 A] 엘박스 검색 파라미터 추출 (기획서 §3)
# ═══════════════════════════════════════════════
MODULE_A_SYSTEM = """너는 법률 자문 프로그램의 백엔드 모듈이다. 사용자의 분쟁 상황과 쟁점을 분석하여, 엘박스(L-Box) API에 전달할 최적의 검색 파라미터를 JSON 배열로 추출해야 한다.

[엘박스 사건부호]
- 민사: 1심(가합,가단,가소) 항소(나) 상고(다,민상)
- 형사: 1심(고합,고단,고정) 항소(노) 상고(도)
- 가사: 1심(드합,드단,드소) 항소(르) 상고(므)
- 행정: 1심(구합,구단) 항소(누) 상고(두)

[규칙]
1. 각 쟁점별로 1~2개의 검색 파라미터를 생성 (총 4~8개)
2. lbox_keywords: 법률 명사 위주, 조사/서술어 제외, 2~3개
3. case_codes: 해당 사건 유형의 사건부호 (1심+상고 우선)
4. search_query: 엘박스 검색창에 넣을 최적화된 검색어
5. 대법원 판례 중심으로 검색 (상고심 부호 포함)

JSON배열만 출력. 백틱 없이."""

@app.post("/api/extract-search-params")
async def extract_search_params(request:Request):
    """[모듈 A] Claude가 쟁점에서 엘박스 검색 파라미터 추출"""
    body=await request.json()
    issues=body.get('issues',[])
    situation=body.get('situation','')
    dispute_type=body.get('disputeType','')
    
    # 로컬 분류로 기본 카테고리 결정
    local_class=classify_case(situation+' '+' '.join(issues)+' '+dispute_type)
    
    prompt_input=f"분쟁유형: {dispute_type}\n쟁점: {', '.join(issues)}\n상황: {situation}\n자동분류: {local_class['main_category']}/{local_class['sub_category']}"
    
    try:
        import asyncio
        for attempt in range(3):
            async with httpx.AsyncClient(timeout=120) as c:
                r=await c.post("https://api.anthropic.com/v1/messages",
                    json={"model":"claude-haiku-4-5-20251001","max_tokens":1024,
                          "system":MODULE_A_SYSTEM,
                          "messages":[{"role":"user","content":prompt_input+'\n\n[{"main_category":"","case_codes":[""],"lbox_keywords":[""],"search_query":"","purpose":"","user_summary":""}]'}]},
                    headers={"x-api-key":API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"})
                
                if r.status_code==200:
                    data=r.json()
                    text=''.join(c.get('text','') for c in data.get('content',[]) if c.get('type')=='text')
                    text=text.replace('```json','').replace('```','').strip()
                    params=json.loads(text)
                    if isinstance(params,dict): params=[params]
                    print(f"[ModuleA] Generated {len(params)} search params")
                    return {"params":params,"local_classification":local_class}
                elif r.status_code==429:
                    wait=20*(attempt+1)
                    print(f"[ModuleA] 429 — {wait}초 대기 ({attempt+1}/3)")
                    await asyncio.sleep(wait)
                    continue
                else:
                    print(f"[ModuleA] FAIL {r.status_code}")
                    break
    except Exception as e:
        print(f"[ModuleA] ERR: {e}")
    
    # 폴백: 로컬 분류 기반
    fallback=[{"main_category":local_class["main_category"],"case_codes":local_class["case_codes"],
               "lbox_keywords":issues[:3],"search_query":issue,"purpose":f"{issue} 판례"}
              for issue in issues[:4]]
    return {"params":fallback,"local_classification":local_class,"fallback":True}

# ═══════════════════════════════════════════════
# 7. 엘박스 판례 검색
# ═══════════════════════════════════════════════
def parse_lbox_result(src, raw=None):
    """엘박스 응답을 표준 포맷으로 파싱"""
    case_number=src.get('caseNumber',src.get('case_number',src.get('caseId','')))
    case_code=''
    m=re.search(r'\d{4}([가-힣]{1,3})\d+',case_number)
    if m: case_code=m.group(1)
    
    main_cat=''
    for cat,cdata in TAXONOMY.items():
        all_codes=[]
        for sub in cdata["sub"].values():
            for codes in sub.get("codes",{}).values(): all_codes.extend(codes)
        if case_code in all_codes: main_cat=cat; break
    
    return {
        "caseId":case_number,
        "title":src.get('caseName',src.get('title',src.get('case_name',''))),
        "court":src.get('courtName',src.get('court','')),
        "date":src.get('judgmentDate',src.get('date','')),
        "caseCode":case_code,
        "mainCategory":main_cat,
        "facts":(src.get('facts',src.get('사실관계',''))or'')[:2000],
        "holding":(src.get('holding',src.get('판시사항',''))or'')[:2000],
        "dispositive":(src.get('dispositive',src.get('주문',''))or'')[:500],
        "summary":(src.get('summary',src.get('abstract',src.get('판결요지','')))or'')[:1500],
        "reasoning":(src.get('reasoning',src.get('이유',''))or'')[:3000],
        "url":src.get('url',src.get('link','')),
        "id":src.get('id',raw.get('_id','') if raw else ''),
        "source":"lbox"
    }

@app.post("/api/search")
async def lbox_search(request:Request):
    body=await request.json()
    query=body.get('query','')
    max_results=body.get('max_results',5)
    case_codes=body.get('case_codes',[])
    category=body.get('category','')
    
    if not query: return {"results":[],"total":0}
    
    # 캐시 먼저 확인
    cached=search_cache(query,case_codes if case_codes else None,limit=max_results)
    if cached:
        print(f"[LBox] Cache hit: '{query}' -> {len(cached)} results")
    
    results=[]
    try:
        # 🔧 FIX: 진짜 엘박스 API 엔드포인트 — /api/case/search POST
        # (이전: /api/v2/search, /api/search → 둘 다 404. 익명 검색도 안 됐던 원인)
        # 응답: {"caseList":[{id,title,sub_title,result,content,...}], "count":N, "correctedQuery", ...}
        # 익명도 검색 가능 (로그인 시 더 많은 필드 노출됨)
        async with httpx.AsyncClient(timeout=30,follow_redirects=True,cookies=lbox_cookies) as c:
            search_body={"query":query,"page":1,"size":max_results,"sort":"relevance"}
            if case_codes: search_body["caseCode"]=case_codes
            if category: search_body["mainCategory"]=category
            try:
                r=await c.post("https://www.lbox.kr/api/case/search",json=search_body,headers=lbox_headers)
                if r.status_code==200:
                    data=r.json()
                    items=data.get("caseList",[]) or data.get("results",[]) or []
                    total=data.get("count",len(items))
                    if not isinstance(items,list): items=[]
                    for item in items[:max_results]:
                        # 엘박스 응답 필드 → 표준 포맷 매핑
                        case_id=item.get("id","")
                        title=item.get("title","") or item.get("sub_title","")
                        # 사건부호 추출 (id에서)
                        case_code=""
                        m=re.search(r'\d{4}([가-힣]{1,3})\d+',case_id+' '+title)
                        if m: case_code=m.group(1)
                        # 메인 카테고리 분류
                        main_cat=""
                        for cat,cdata in TAXONOMY.items():
                            all_codes=[]
                            for sub in cdata["sub"].values():
                                for codes in sub.get("codes",{}).values(): all_codes.extend(codes)
                            if case_code in all_codes: main_cat=cat; break
                        # 법원/날짜 추출 (title 파싱)
                        court_m=re.match(r'(.+?(?:법원|지원))',title)
                        date_m=re.search(r'(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})',title)
                        parsed={
                            "caseId":case_id,
                            "title":title,
                            "court":(court_m.group(1) if court_m else "").strip(),
                            "date":(f"{date_m.group(1)}-{int(date_m.group(2)):02d}-{int(date_m.group(3)):02d}" if date_m else ""),
                            "caseCode":case_code,
                            "mainCategory":main_cat,
                            "facts":(item.get("content","") or "")[:2000],
                            "holding":(item.get("title","") or "")[:500],
                            "dispositive":(item.get("result","") or "")[:500],
                            "summary":(item.get("sub_title","") or item.get("content",""))[:1500],
                            "reasoning":(item.get("content","") or "")[:3000],
                            "url":f"https://www.lbox.kr/case/{case_id}" if case_id else "",
                            "id":case_id,
                            "source":"lbox",
                            "searchQuery":query,
                        }
                        if parsed["caseId"] or parsed["title"]:
                            save_precedent(parsed)
                            results.append(parsed)
                    if results:
                        print(f"[LBox] Search '{query}' -> {len(results)}/{total} results")
                else:
                    print(f"[LBox] Search HTTP {r.status_code}: {r.text[:200]}")
            except Exception as se:
                print(f"[LBox] Search exception: {se}")
    except Exception as e:
        print(f"[LBox] ERR: {e}")
    
    # 캐시 결과 병합
    if cached and not results:
        results=[{"caseId":c["case_number"],"title":c["case_name"],"court":c["court_name"],
                  "date":c["judgment_date"],"caseCode":c["case_code"],"mainCategory":c["main_category"],
                  "facts":c["facts"],"holding":c["holding"],"dispositive":c["dispositive"],
                  "summary":c["summary"],"url":c["url"],"source":"cache"} for c in cached]
    
    return {"results":results,"total":len(results),"query":query}

@app.post("/api/case-detail")
async def lbox_case_detail(request:Request):
    body=await request.json()
    case_id=body.get('case_id','')
    url=body.get('url','')
    
    # DB 캐시 확인
    if case_id:
        cached=search_cache(case_id,limit=1)
        if cached and (cached[0].get('facts') or cached[0].get('holding')):
            print(f"[LBox] Detail cache: {case_id}")
            return cached[0]
    
    try:
        async with httpx.AsyncClient(timeout=30,follow_redirects=True,cookies=lbox_cookies) as c:
            detail_urls=[]
            if case_id:
                detail_urls+=[f"https://www.lbox.kr/api/v2/case/{case_id}",f"https://www.lbox.kr/api/case/{case_id}"]
            if url:
                detail_urls.append(url if url.startswith('http') else f"https://www.lbox.kr{url}")
            for durl in detail_urls:
                try:
                    r=await c.get(durl,headers=lbox_headers)
                    if r.status_code==200 and 'json' in r.headers.get('content-type',''):
                        data=r.json()
                        src=data.get('data',data.get('result',data))
                        result=parse_lbox_result(src)
                        result['content']=(src.get('content',src.get('body',''))or'')[:5000]
                        result['reasoning']=(src.get('reasoning',src.get('이유',''))or'')[:3000]
                        save_precedent(result)
                        print(f"[LBox] Detail OK: {case_id}")
                        return result
                except: continue
    except Exception as e:
        print(f"[LBox] Detail ERR: {e}")
    return {"content":"","summary":"","caseId":case_id}

@app.post("/api/lbox-ai")
async def lbox_ai(request:Request):
    body=await request.json()
    try:
        async with httpx.AsyncClient(timeout=60,follow_redirects=True,cookies=lbox_cookies) as c:
            for url in ["https://www.lbox.kr/api/v2/ai/analyze","https://www.lbox.kr/api/ai/analyze"]:
                try:
                    r=await c.post(url,json={"query":body.get('query',''),"context":body.get('context','')},headers=lbox_headers)
                    if r.status_code==200: return r.json()
                except: continue
    except: pass
    return {"analysis":""}

# ═══════════════════════════════════════════════
# 8. [통합] 스마트 판례 검색 파이프라인 (기획서 §5)
# ═══════════════════════════════════════════════
@app.post("/api/smart-search")
async def smart_search(request:Request):
    """
    전체 검색 파이프라인:
    1) [모듈 A] Claude가 검색 파라미터 추출
    2) 엘박스 검색 (사건부호 필터링)
    3) 상위 판례 상세 조회
    4) DB 캐시 저장
    """
    body=await request.json()
    issues=body.get('issues',[])
    situation=body.get('situation','')
    dispute_type=body.get('disputeType','민사')
    max_per_query=body.get('max_per_query',5)
    
    pipeline_log=[]
    
    # Step 1: [모듈 A] 검색 파라미터 추출
    pipeline_log.append({"step":"모듈A","status":"start","message":"Claude가 최적 검색 키워드 생성 중..."})
    
    class ParamReq:
        async def json(self): return {"issues":issues,"situation":situation,"disputeType":dispute_type}
    param_result=await extract_search_params(ParamReq())
    param_data=param_result if isinstance(param_result,dict) else json.loads(param_result.body.decode())
    
    search_params=param_data.get('params',[])
    local_class=param_data.get('local_classification',{})
    
    pipeline_log.append({"step":"모듈A","status":"done",
        "message":f"검색 파라미터 {len(search_params)}개 생성 (분류: {local_class.get('main_category','?')}/{local_class.get('sub_category','?')})",
        "params":search_params})
    
    # Step 2: 엘박스 검색
    all_results=[]; seen_ids=set(); searches_done=[]
    
    for sp in search_params[:6]:
        query=sp.get('search_query','') or ' '.join(sp.get('lbox_keywords',[]))
        if not query: continue
        
        class SearchReq:
            _q=query; _cc=sp.get('case_codes',[]); _cat=sp.get('main_category','')
            async def json(self): return {"query":self._q,"max_results":max_per_query,"case_codes":self._cc,"category":self._cat}
        
        sr=await lbox_search(SearchReq())
        sr_data=sr if isinstance(sr,dict) else json.loads(sr.body.decode())
        found=sr_data.get('results',[])
        
        new_count=0
        for item in found:
            cid=item.get('caseId',item.get('title',''))
            if cid and cid not in seen_ids:
                seen_ids.add(cid)
                item['searchQuery']=query
                item['searchPurpose']=sp.get('purpose','')
                all_results.append(item)
                new_count+=1
        
        searches_done.append({"query":query,"purpose":sp.get('purpose',''),
            "found":len(found),"new":new_count,"case_codes":sp.get('case_codes',[])})
    
    pipeline_log.append({"step":"검색","status":"done",
        "message":f"엘박스 {len(all_results)}건 수집 ({len(searches_done)}개 쿼리)"})
    
    # Step 3: 상위 판례 상세 조회
    detailed_count=0
    for item in all_results[:12]:
        if item.get('id') or item.get('url'):
            class DReq:
                _cid=item.get('id',''); _url=item.get('url','')
                async def json(self): return {"case_id":self._cid,"url":self._url}
            detail=await lbox_case_detail(DReq())
            dd=detail if isinstance(detail,dict) else json.loads(detail.body.decode())
            if dd.get('facts') or dd.get('holding') or dd.get('content'):
                item.update({k:v for k,v in dd.items() if v})
                detailed_count+=1
    
    pipeline_log.append({"step":"상세","status":"done",
        "message":f"상세 조회 {detailed_count}/{min(len(all_results),8)}건"})
    
    return {
        "searches":searches_done,
        "results":all_results,
        "total":len(all_results),
        "detailed":detailed_count,
        "classification":local_class,
        "pipeline":pipeline_log
    }

# ═══════════════════════════════════════════════
# 9. 캐시/분류 API
# ═══════════════════════════════════════════════
@app.post("/api/classify")
async def classify(request:Request):
    """텍스트에서 대분류/사건부호 자동 분류"""
    body=await request.json()
    return classify_case(body.get('text',''))

@app.get("/api/taxonomy")
def get_taxonomy():
    """전체 카테고리 트리 반환"""
    return TAXONOMY

@app.get("/api/cache-stats")
def cache_stats():
    conn=sqlite3.connect(str(DB_PATH))
    stats={}
    stats['total']=conn.execute("SELECT COUNT(*) FROM lbox_precedents").fetchone()[0]
    stats['by_category']={r[0]:r[1] for r in conn.execute("SELECT main_category,COUNT(*) FROM lbox_precedents GROUP BY main_category").fetchall()}
    stats['by_code']={r[0]:r[1] for r in conn.execute("SELECT case_code,COUNT(*) FROM lbox_precedents WHERE case_code!='' GROUP BY case_code ORDER BY COUNT(*) DESC LIMIT 20").fetchall()}
    stats['recent']=conn.execute("SELECT case_number,case_name,judgment_date FROM lbox_precedents ORDER BY created_at DESC LIMIT 5").fetchall()
    conn.close()
    return stats

# ═══════════════════════════════════════════════
# 10. 자동 로그인 & 시작
# ═══════════════════════════════════════════════
async def auto_login_lbox():
    global lbox_logged_in,lbox_cookies,lbox_headers
    # 저장된 쿠키 파일 재사용
    cf=HERE/'lbox_cookies.json'
    if cf.exists():
        try:
            lbox_cookies=json.loads(cf.read_text(encoding='utf-8'))
            if lbox_cookies:
                cookie_str='; '.join(f"{k}={v}" for k,v in lbox_cookies.items())
                lbox_headers['Cookie']=cookie_str
                lbox_logged_in=True
                print(f"[LBox] Cookie cache loaded ({len(lbox_cookies)} cookies)")
                return
        except: pass
    print(f"[LBox] 쿠키 없음 — 웹에서 엘박스 로그인이 필요합니다")

@app.on_event("startup")
async def startup():
    await auto_login_lbox()

def open_browser():
    time.sleep(2); webbrowser.open(f"http://localhost:{PORT}")

if __name__=="__main__":
    print(f"""
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AI 법률 종합 플랫폼 v3
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  http://localhost:{PORT}
  Claude: {API_KEY[:15]}...
  LBox:   {LBOX_EMAIL or '(UI에서 로그인)'}
  DB:     {DB_PATH}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")
    threading.Thread(target=open_browser,daemon=True).start()
    uvicorn.run(app,host="0.0.0.0",port=PORT)
