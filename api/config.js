// api/config.js - 클라이언트가 부팅 시 호출
// 환경변수의 안전한 부분(ANON_KEY)만 노출
import { applyCors } from '../lib/auth.js';

export default function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  res.json({
    supabase_url: process.env.SUPABASE_URL || '',
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || '',
    org_id: process.env.ORG_ID || 'jamsa',
    backend_cctv_url: process.env.BACKEND_CCTV_URL || '',
    version: 'v12.9-vercel',
  });
}
