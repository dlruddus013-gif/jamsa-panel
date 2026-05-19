/**
 * Express 진입점. 환경변수 로드 + DB 초기화 + 정적 + 라우트.
 */
require("dotenv").config();
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const db = require("./db");
const minewRoutes = require("./routes/minewRoutes");

const PORT = parseInt(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();

// 큰 payload 허용 + JSON/form 모두
app.use(express.json({ limit: "5mb", strict: false }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.text({ type: ["text/*"], limit: "5mb" }));

// CORS (개발 편의)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 요청 로그 (POST만 간단히)
app.use((req, _res, next) => {
  if (req.method === "POST") {
    console.log(`[HTTP] ${new Date().toISOString()} ${req.method} ${req.path} from ${req.ip}`);
  }
  next();
});

// DB 초기화
db.init();

// 정적 대시보드
app.use("/static", express.static(PUBLIC_DIR));
app.get(["/", "/dashboard"], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});

// API/수신 라우트
app.use(minewRoutes);

// 전역 에러 핸들러 — 서버 다운 방지
app.use((err, req, res, _next) => {
  console.error("[unhandled]", err);
  try {
    fs.appendFileSync(path.join(__dirname, "..", "logs", "error.log"),
      JSON.stringify({ at: new Date().toISOString(), path: req.path, error: err.message, stack: err.stack }) + "\n");
  } catch (_) {}
  if (!res.headersSent) {
    res.status(200).json({ ok: false, error: err.message });  // 200 → 게이트웨이 재시도 폭주 방지
  }
});

const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log("═".repeat(64));
  console.log(`  🛰️  Jamsa Minew Edge Server`);
  console.log(`  📡  http://${HOST}:${PORT}`);
  console.log(`  📊  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  ⬇️   POST 엔드포인트:`);
  console.log(`        /minew  /api/minew  /webhook/minew  /api/beacon`);
  console.log("═".repeat(64));
});
