import agentRealtimeAnalysis from '../api_handlers/agent-realtime-analysis.js';
import autoAlerts from '../api_handlers/auto-alerts.js';
import bankWebhook from '../api_handlers/bank-webhook.js';
import bridgeReset from '../api_handlers/bridge-reset.js';
import beaconWebhook from '../api_handlers/beacon-webhook.js';
import cctvAiAnalyze from '../api_handlers/cctv-ai-analyze.js';
import spotLayoutVision from '../api_handlers/spot-layout-vision.js';
import aiStatus from '../api_handlers/ai-status.js';
import staffManage from '../api_handlers/staff-manage.js';
import chatbot from '../api_handlers/chatbot.js';
import config from '../api_handlers/config.js';
import dataBulk from '../api_handlers/data-bulk.js';
import dataKey from '../api_handlers/data/[key].js';
import forecastKpi from '../api_handlers/forecast-kpi.js';
import inventoryAiAnalyze from '../api_handlers/inventory-ai-analyze.js';
import keys from '../api_handlers/keys.js';
import laborAdvice from '../api_handlers/labor-advice.js';
import smsSend from '../api_handlers/sms-send.js';
import smsScheduler from '../api_handlers/sms-scheduler.js';
import surveySubmit from '../api_handlers/survey-submit.js';
import couponVerify from '../api_handlers/coupon-verify.js';
import bookingCreate from '../api_handlers/booking-create.js';
import notifySend from '../api_handlers/notify-send.js';
import openbankingSync from '../api_handlers/openbanking-sync.js';
import operationStats from '../api_handlers/operation-stats.js';
import paymentImport from '../api_handlers/payment-import.js';
import qrCheckin from '../api_handlers/qr-checkin.js';
import roborock from '../api_handlers/roborock.js';
import safetyMonthlyReport from '../api_handlers/safety-monthly-report.js';
import search from '../api_handlers/search.js';
import staffDispatch from '../api_handlers/staff-dispatch.js';
import staffLocations from '../api_handlers/staff-locations.js';
import staffLocationUpdate from '../api_handlers/staff-location-update.js';
import preciseLocation from '../api_handlers/precise-location.js';
import presenceCctvAnalyze from '../api_handlers/presence-cctv-analyze.js';
import consent from '../api_handlers/consent.js';
import correction from '../api_handlers/correction.js';
import customerSession from '../api_handlers/customer-session.js';
import customerOtp from '../api_handlers/customer-otp.js';
import auditData from '../api_handlers/audit-data.js';
import auditPackage from '../api_handlers/audit-package.js';
import stats from '../api_handlers/stats.js';
import tapoAutomations from '../api_handlers/tapo-automations.js';
import tapoCamera from '../api_handlers/tapo-camera.js';
import tapoDevices from '../api_handlers/tapo-devices.js';
import tapoEvents from '../api_handlers/tapo-events.js';
import weatherKma from '../api_handlers/weather-kma.js';
import zoneCrowdStats from '../api_handlers/zone-crowd-stats.js';

const routes = {
  'agent-realtime-analysis': agentRealtimeAnalysis,
  'auto-alerts': autoAlerts,
  'bank-webhook': bankWebhook,
  'bridge/reset': bridgeReset,
  'beacon-webhook': beaconWebhook,
  'cctv-ai-analyze': cctvAiAnalyze,
  'spot-layout-vision': spotLayoutVision,
  'ai-status': aiStatus,
  'staff-manage': staffManage,
  'chatbot': chatbot,
  'config': config,
  'data-bulk': dataBulk,
  'forecast-kpi': forecastKpi,
  'inventory-ai-analyze': inventoryAiAnalyze,
  'keys': keys,
  'labor-advice': laborAdvice,
  'sms-send': smsSend,
  'sms-scheduler': smsScheduler,
  'survey-submit': surveySubmit,
  'coupon-verify': couponVerify,
  'booking-create': bookingCreate,
  'notify-send': notifySend,
  'openbanking-sync': openbankingSync,
  'operation-stats': operationStats,
  'payment-import': paymentImport,
  'qr-checkin': qrCheckin,
  'roborock': roborock,
  'safety-monthly-report': safetyMonthlyReport,
  'search': search,
  'staff-dispatch': staffDispatch,
  'staff-locations': staffLocations,
  'staff-location-update': staffLocationUpdate,
  'precise-location': preciseLocation,
  'presence-cctv-analyze': presenceCctvAnalyze,
  'consent': consent,
  'correction': correction,
  'customer-session': customerSession,
  'customer-otp': customerOtp,
  'audit-data': auditData,
  'audit-package': auditPackage,
  'stats': stats,
  'tapo-automations': tapoAutomations,
  'tapo-camera': tapoCamera,
  'tapo-devices': tapoDevices,
  'tapo-events': tapoEvents,
  'weather-kma': weatherKma,
  'zone-crowd-stats': zoneCrowdStats,
};

export default async function handler(req, res) {
  const rawPath = req.query?.path;
  const parts = Array.isArray(rawPath)
    ? rawPath
    : String(rawPath || '').split('/').filter(Boolean);
  const route = parts.join('/');
  const fn = parts[0] === 'data' && parts[1] ? dataKey : routes[route];

  if (!fn) {
    return res.status(404).json({
      ok: false,
      error: 'api_route_not_found',
      route: `/api/${route}`,
    });
  }

  req.query = { ...(req.query || {}) };
  delete req.query.path;
  if (parts[0] === 'data' && parts[1]) req.query.key = parts.slice(1).join('/');

  return fn(req, res);
}
