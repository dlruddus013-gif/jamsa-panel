// api/notify-send.js
// 다채널 알림 발송 (텔레그램/SMS/카카오/이메일/웹훅)
// 인증 불필요 (사용자 자신의 채널 자격증명을 본문에 담아 보냄)
// IP rate limit만 적용.

import { applyCors, checkRateLimit } from '../lib/auth.js';
import crypto from 'node:crypto';

const RESEND_API_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });

  const { channel, config = {}, message = '' } = req.body || {};
  if (!channel || !message) return res.status(400).json({ ok: false, error: 'missing_channel_or_message' });

  try {
    switch (channel) {
      case 'telegram': return res.status(200).json(await sendTelegram(config, message));
      case 'sms':      return res.status(200).json(await sendSolapiSms(config, message));
      case 'kakao':    return res.status(200).json(await sendKakaoSelf(config, message));
      case 'email':    return res.status(200).json(await sendEmail(config, message));
      case 'webhook':  return res.status(200).json(await sendWebhook(config, message));
      default:         return res.status(400).json({ ok: false, error: 'unknown_channel' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─── Telegram Bot API ─────────────────────────────────────────────
async function sendTelegram(cfg, message) {
  if (!cfg.botToken || !cfg.chatId) return { ok: false, error: 'Telegram: botToken/chatId 필요' };
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.chatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
  return { ok: true, messageId: data.result?.message_id };
}

// ─── Solapi SMS (https://developers.solapi.com) ───────────────────
async function sendSolapiSms(cfg, message) {
  if (!cfg.apiKey || !cfg.apiSecret || !cfg.from || !cfg.to) {
    return { ok: false, error: 'Solapi: apiKey/apiSecret/from/to 모두 필요' };
  }
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const sig = crypto.createHmac('sha256', cfg.apiSecret).update(date + salt).digest('hex');
  const authorization = `HMAC-SHA256 apiKey=${cfg.apiKey}, date=${date}, salt=${salt}, signature=${sig}`;

  const res = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authorization },
    body: JSON.stringify({
      message: {
        to: cfg.to,
        from: cfg.from,
        text: message.length > 90 ? message.slice(0, 1500) : message, // LMS 자동 분할
      },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.errorCode) return { ok: false, error: data.errorMessage || `HTTP ${res.status}` };
  return { ok: true, messageId: data.messageId };
}

// ─── 카카오 "나에게 보내기" (Kakao Talk Memo API) ──────────────────
async function sendKakaoSelf(cfg, message) {
  if (!cfg.accessToken) return { ok: false, error: 'Kakao: accessToken 필요' };
  const url = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
  const template = {
    object_type: 'text',
    text: message,
    link: { web_url: 'https://jamsa-panel.vercel.app', mobile_web_url: 'https://jamsa-panel.vercel.app' },
    button_title: '대시보드 열기',
  };
  const body = new URLSearchParams({ template_object: JSON.stringify(template) });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${cfg.accessToken}`,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok || data.result_code !== 0) return { ok: false, error: data.msg || `HTTP ${res.status}` };
  return { ok: true };
}

// ─── 이메일 (Resend) ───────────────────────────────────────────────
async function sendEmail(cfg, message) {
  if (!RESEND_API_KEY) return { ok: false, error: '서버에 RESEND_API_KEY 미설정' };
  if (!cfg.to || !cfg.from) return { ok: false, error: 'to/from 필요' };
  const subject = message.split('\n')[0] || '🏛️ 잠사박물관 알림';
  const html = `<pre style="font-family: 'Noto Sans KR', sans-serif; white-space: pre-wrap; line-height: 1.6;">${
    message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  }</pre>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: cfg.from, to: cfg.to, subject, html }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.message || `HTTP ${res.status}` };
  return { ok: true, messageId: data.id };
}

// ─── 웹훅 (Slack/Discord/n8n) ──────────────────────────────────────
async function sendWebhook(cfg, message) {
  if (!cfg.url) return { ok: false, error: 'webhook URL 필요' };
  // Slack/Discord 호환 페이로드
  const isDiscord = /discord\.com\/api\/webhooks/.test(cfg.url);
  const body = isDiscord ? { content: message } : { text: message };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(()=> '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0,200)}` };
  }
  return { ok: true };
}
