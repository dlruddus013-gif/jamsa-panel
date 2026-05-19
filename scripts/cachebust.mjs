#!/usr/bin/env node
// 빌드 후 번들 파일의 md5 해시를 계산해서 HTML의 /app.bundle.js URL에 ?v=<hash>를 붙인다.
// 브라우저 캐시 때문에 업데이트가 즉시 반영되지 않는 문제를 방지.
// + git 머지 충돌 마커가 HTML/JSX에 남아있으면 빌드 실패 (재발 방지)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── 머지 충돌 마커 검사 ─────────────────────────────────────
const CHECK_DIRS = [root];
const CHECK_EXT = /\.(html|jsx|js|css|mjs|cjs)$/i;
const SKIP = /node_modules|\.git|dist|public[\\/]app\.bundle\.js/;
const conflictRe = /^(?:<{7} |={7}$|>{7} )/m;
function walk(dir, found) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (SKIP.test(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, found);
    else if (CHECK_EXT.test(name)) {
      const txt = fs.readFileSync(p, "utf8");
      if (conflictRe.test(txt)) found.push(p);
    }
  }
}
const found = [];
walk(root, found);
if (found.length > 0) {
  console.error("✗ git merge conflict markers found in:");
  found.forEach(f => console.error("  -", path.relative(root, f)));
  console.error("\n각 파일을 열어서 <<<<<<<, =======, >>>>>>>를 제거하세요.");
  process.exit(2);
}

// ─── supabase/*.sql → public/migrations/*.sql 동기화 ─────────
// 프론트엔드의 셋업 안내 UI가 /migrations/<name>.sql 을 fetch 해서
// 클립보드에 복사할 수 있도록 정적 자산으로 노출한다.
const sqlSrcDir = path.join(root, "supabase");
const sqlOutDir = path.join(root, "public", "migrations");
if (fs.existsSync(sqlSrcDir)) {
  if (!fs.existsSync(sqlOutDir)) fs.mkdirSync(sqlOutDir, { recursive: true });
  for (const name of fs.readdirSync(sqlSrcDir)) {
    if (!name.endsWith(".sql")) continue;
    fs.copyFileSync(path.join(sqlSrcDir, name), path.join(sqlOutDir, name));
  }
  console.log(`✓ migrations synced → public/migrations/`);
}

// ─── cachebust ───────────────────────────────────────────────
const bundlePath = path.join(root, "public", "app.bundle.js");
if (!fs.existsSync(bundlePath)) { console.error("bundle not found:", bundlePath); process.exit(1); }
const hash = crypto.createHash("md5").update(fs.readFileSync(bundlePath)).digest("hex").slice(0, 8);

const targets = [
  path.join(root, "index.html"),
  path.join(root, "public", "index.html"),
];

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, "utf8");
  const replaced = html.replace(/\/app\.bundle\.js(\?v=[a-f0-9]+)?/g, `/app.bundle.js?v=${hash}`);
  if (replaced !== html) {
    fs.writeFileSync(file, replaced);
    console.log(`✓ cachebust ${path.relative(root, file)} → ?v=${hash}`);
  }
}

