#!/usr/bin/env node
// 빌드 후 번들 파일의 md5 해시를 계산해서 HTML의 /app.bundle.js URL에 ?v=<hash>를 붙인다.
// 브라우저 캐시 때문에 업데이트가 즉시 반영되지 않는 문제를 방지.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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
  // /app.bundle.js 또는 /app.bundle.js?v=xxx 를 새 해시로 교체
  const replaced = html.replace(/\/app\.bundle\.js(\?v=[a-f0-9]+)?/g, `/app.bundle.js?v=${hash}`);
  if (replaced !== html) {
    fs.writeFileSync(file, replaced);
    console.log(`✓ cachebust ${path.relative(root, file)} → ?v=${hash}`);
  }
}
