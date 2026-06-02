'use strict';
require('dotenv').config();

const express    = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const SHOP_NAME   = process.env.SHOP_NAME || '';
const SHOP_DOMAIN = `${SHOP_NAME}.myshopify.com`;
const CLIENT_ID   = process.env.SHOPIFY_CLIENT_ID   || '';
const CLIENT_SEC  = process.env.SHOPIFY_CLIENT_SECRET || '';
const SERVER_URL  = (process.env.SERVER_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, '');
const BRAND_NAME  = process.env.BRAND_NAME || 'Fit Check';
const MONGO_URI   = process.env.MONGO_URI  || '';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'admin123';

let SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

// ─── MongoDB ─────────────────────────────────────────────────────────────────
let mdb;
async function connectMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  mdb = client.db();
  console.log('✅  MongoDB connected');
  // Indexes
  await Promise.allSettled([
    mdb.collection('admin_sessions').createIndex({ token: 1 }, { unique: true }),
    mdb.collection('admin_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    mdb.collection('staff_profiles').createIndex({ username: 1 }, { unique: true }),
    mdb.collection('order_stage').createIndex({ shopify_id: 1 }),
    mdb.collection('return_requests').createIndex({ request_id: 1 }, { unique: true }),
    mdb.collection('audit_log').createIndex({ created_at: -1 }),
  ]);
}

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('.'));

// CORS
app.use((req, res, next) => {
  const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const origin  = req.headers.origin || '';
  if (origins.includes('*') || origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Shopify Helpers ─────────────────────────────────────────────────────────
async function shopifyREST(path, opts = {}) {
  const url = `https://${SHOP_DOMAIN}/admin/api/2025-01${path}`;
  const res  = await fetch(url, {
    ...opts,
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  return res.json();
}

async function shopifyGQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function fetchAllOrders(status = 'any', createdAtMin, createdAtMax) {
  let orders = [], pageInfo = null, first = true;
  while (first || pageInfo?.hasNextPage) {
    first = false;
    const vars = { first: 250, query: buildOrderQuery(status, createdAtMin, createdAtMax), after: pageInfo?.endCursor || null };
    const data = await shopifyGQL(`
      query($first:Int!,$query:String,$after:String){
        orders(first:$first,query:$query,after:$after){
          pageInfo{hasNextPage endCursor}
          edges{node{
            id name createdAt totalPriceSet{shopMoney{amount}}
            displayFinancialStatus displayFulfillmentStatus
            email phone tags
            customer{firstName lastName email phone}
            shippingAddress{name address1 address2 city province zip phone}
            lineItems(first:50){edges{node{id title quantity vendor sku originalUnitPriceSet{shopMoney{amount}}}}}
            fulfillments{status trackingInfo{number url company} createdAt}
            note
          }}
        }
      }`, vars);
    const conn = data?.data?.orders;
    if (!conn) break;
    orders.push(...conn.edges.map(e => normaliseOrder(e.node)));
    pageInfo = conn.pageInfo;
  }
  return orders;
}

function buildOrderQuery(status, min, max) {
  const parts = [];
  if (status !== 'any') parts.push(`status:${status}`);
  if (min) parts.push(`created_at:>='${min}'`);
  if (max) parts.push(`created_at:<='${max}'`);
  return parts.join(' ') || 'status:any';
}

function normaliseOrder(node) {
  const id = node.id.replace('gid://shopify/Order/', '');
  return {
    id,
    name: node.name,
    created_at: node.createdAt,
    total_price: parseFloat(node.totalPriceSet?.shopMoney?.amount || 0),
    financial_status: node.displayFinancialStatus?.toLowerCase(),
    fulfillment_status: node.displayFulfillmentStatus?.toLowerCase(),
    email: node.email || node.customer?.email || '',
    phone: node.phone || node.customer?.phone || '',
    tags: node.tags || [],
    customer: node.customer,
    shipping_address: node.shippingAddress,
    line_items: (node.lineItems?.edges || []).map(e => ({
      id: e.node.id.replace('gid://shopify/LineItem/', ''),
      title: e.node.title,
      quantity: e.node.quantity,
      vendor: e.node.vendor,
      sku: e.node.sku,
      price: parseFloat(e.node.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
    fulfillments: (node.fulfillments || []).map(f => ({
      status: f.status,
      tracking_number: f.trackingInfo?.[0]?.number,
      tracking_url: f.trackingInfo?.[0]?.url,
      company: f.trackingInfo?.[0]?.company,
      created_at: f.createdAt,
    })),
    note: node.note,
  };
}

// ─── Order Stage ─────────────────────────────────────────────────────────────
const STAGE_ORDER = ['new','confirmed','ready','pickup','transit','delivered','rto','cancelled','misc'];
function higherStage(a, b) {
  const ai = STAGE_ORDER.indexOf(a || 'new');
  const bi = STAGE_ORDER.indexOf(b || 'new');
  return ai >= bi ? (a || 'new') : (b || 'new');
}

const OS = {
  async get(shopify_id) {
    return mdb.collection('order_stage').findOne({ shopify_id: String(shopify_id) }, { projection: { _id: 0 } });
  },
  async upsert(shopify_id, fields) {
    await mdb.collection('order_stage').updateOne(
      { shopify_id: String(shopify_id) },
      { $set: { shopify_id: String(shopify_id), ...fields } },
      { upsert: true }
    );
  },
};

// ─── ID Counter ──────────────────────────────────────────────────────────────
async function nextId(col) {
  const r = await mdb.collection('id_counters').findOneAndUpdate(
    { _id: col },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return r.seq;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────
function auditLog(actor, action, target, meta = {}) {
  mdb.collection('audit_log').insertOne({ actor, action, target, meta, created_at: new Date() }).catch(() => {});
}

// ─── Admin Auth ──────────────────────────────────────────────────────────────
async function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const s = await mdb.collection('admin_sessions').findOne({ token });
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  if (Date.now() > s.expiresAt) {
    await mdb.collection('admin_sessions').deleteOne({ token });
    return res.status(401).json({ error: 'Session expired' });
  }
  await mdb.collection('admin_sessions').updateOne({ token }, { $set: { expiresAt: Date.now() + 24 * 3600 * 1000 } });
  next();
}

app.post('/admin/login', async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Invalid password' });
  const token = crypto.randomBytes(32).toString('hex');
  await mdb.collection('admin_sessions').insertOne({ token, expiresAt: Date.now() + 24 * 3600 * 1000, created_at: new Date() });
  res.json({ token, brand: BRAND_NAME });
});

app.post('/admin/logout', adminAuth, async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  await mdb.collection('admin_sessions').deleteOne({ token });
  res.json({ ok: true });
});

// ─── Staff Auth ───────────────────────────────────────────────────────────────
async function staffAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const s = await mdb.collection('staff_sessions').findOne({ token });
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  if (Date.now() > s.expiresAt) {
    await mdb.collection('staff_sessions').deleteOne({ token });
    return res.status(401).json({ error: 'Session expired' });
  }
  await mdb.collection('staff_sessions').updateOne({ token }, { $set: { expiresAt: Date.now() + 24 * 3600 * 1000 } });
  req.staffUsername = s.username;
  next();
}

app.post('/staff/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const profile = await mdb.collection('staff_profiles').findOne({ username: username.toLowerCase().trim() });
    if (!profile) return res.status(401).json({ error: 'Invalid credentials' });
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (hash !== profile.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    const token = crypto.randomBytes(32).toString('hex');
    await mdb.collection('staff_sessions').updateOne({ username }, { $set: { token, username, expiresAt: Date.now() + 24 * 3600 * 1000 } }, { upsert: true });
    res.json({ token, username, name: profile.name, brand: BRAND_NAME });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/staff/logout', staffAuth, async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  await mdb.collection('staff_sessions').deleteOne({ token });
  res.json({ ok: true });
});

app.get('/staff/profile', staffAuth, async (req, res) => {
  const p = await mdb.collection('staff_profiles').findOne({ username: req.staffUsername }, { projection: { _id: 0, password_hash: 0 } });
  res.json(p || { username: req.staffUsername });
});

// ─── Staff Management (admin) ────────────────────────────────────────────────
app.get('/admin/staff', adminAuth, async (req, res) => {
  const staff = await mdb.collection('staff_profiles').find({}, { projection: { password_hash: 0 } }).toArray();
  res.json(staff);
});

app.post('/admin/staff', adminAuth, async (req, res) => {
  try {
    const { username, name, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    await mdb.collection('staff_profiles').insertOne({ username: username.toLowerCase().trim(), name: name || username, password_hash: hash, created_at: new Date() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/staff/:username', adminAuth, async (req, res) => {
  await mdb.collection('staff_profiles').deleteOne({ username: req.params.username });
  res.json({ ok: true });
});

// ─── Orders ──────────────────────────────────────────────────────────────────
app.get('/orders', adminAuth, async (req, res) => {
  try {
    const { from, to, stage, q, payment } = req.query;
    const allOrders = await fetchAllOrders('any', from ? from + 'T00:00:00Z' : null, to ? to + 'T23:59:59Z' : null);
    const stages = await mdb.collection('order_stage').find({}, { projection: { shopify_id: 1, stage: 1, awb: 1, courier: 1, tracking_url: 1, _id: 0 } }).toArray();
    const stageMap = Object.fromEntries(stages.map(s => [s.shopify_id, s]));
    let orders = allOrders.map(o => {
      const sid = String(o.id);
      const st = stageMap[sid] || {};
      return { ...o, _stage: st.stage || 'new', _awb: st.awb || '', _courier: st.courier || '', _tracking_url: st.tracking_url || '' };
    });
    if (stage)   orders = orders.filter(o => o._stage === stage);
    if (payment) orders = orders.filter(o => o.financial_status?.includes(payment.toLowerCase()));
    if (q) {
      const lq = q.toLowerCase();
      orders = orders.filter(o => o.name.toLowerCase().includes(lq) || (o.customer?.firstName + ' ' + o.customer?.lastName).toLowerCase().includes(lq) || o.email?.toLowerCase().includes(lq));
    }
    res.json({ orders, total: orders.length });
  } catch (e) { console.error('GET /orders:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/orders/stats', adminAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const allOrders = await fetchAllOrders('any', from ? from + 'T00:00:00Z' : null, to ? to + 'T23:59:59Z' : null);
    const stages = await mdb.collection('order_stage').find({}, { projection: { shopify_id: 1, stage: 1, _id: 0 } }).toArray();
    const stageMap = Object.fromEntries(stages.map(s => [s.shopify_id, s.stage]));
    const stats = { total: allOrders.length, delivered: 0, transit: 0, rto: 0, pending: 0, revenue: 0 };
    for (const o of allOrders) {
      const st = stageMap[String(o.id)] || 'new';
      if (st === 'delivered') stats.delivered++;
      else if (st === 'transit' || st === 'pickup') stats.transit++;
      else if (st === 'rto') stats.rto++;
      else if (['new','confirmed','ready'].includes(st)) stats.pending++;
      stats.revenue += o.total_price || 0;
    }
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/orders/:id', adminAuth, async (req, res) => {
  try {
    const { order } = await shopifyREST(`/orders/${req.params.id}.json`);
    const st = await OS.get(req.params.id);
    res.json({ ...order, _stage: st?.stage || 'new', _awb: st?.awb || '', _courier: st?.courier || '', _tracking_url: st?.tracking_url || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/orders/:id/stage', adminAuth, async (req, res) => {
  try {
    const { stage, awb, courier, tracking_url, note } = req.body || {};
    const fields = { updated_at: new Date().toISOString() };
    if (stage)        fields.stage        = stage;
    if (awb)          fields.awb          = awb;
    if (courier)      fields.courier      = courier;
    if (tracking_url) fields.tracking_url = tracking_url;
    if (note)         fields.note         = note;
    await OS.upsert(req.params.id, fields);
    auditLog('admin', 'update_stage', req.params.id, { stage, awb });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Staff order routes
app.get('/staff/orders', staffAuth, async (req, res) => {
  try {
    const allOrders = await fetchAllOrders('any', null, null);
    const stages = await mdb.collection('order_stage').find({}, { projection: { shopify_id: 1, stage: 1, awb: 1, courier: 1, _id: 0 } }).toArray();
    const stageMap = Object.fromEntries(stages.map(s => [s.shopify_id, s]));
    const orders = allOrders
      .map(o => { const st = stageMap[String(o.id)] || {}; return { ...o, _stage: st.stage || 'new', _awb: st.awb || '', _courier: st.courier || '' }; })
      .filter(o => ['confirmed','ready','pickup','transit'].includes(o._stage));
    res.json({ orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/staff/orders/:id/stage', staffAuth, async (req, res) => {
  try {
    const { stage, awb, courier, tracking_url } = req.body || {};
    const allowed = ['ready','pickup','transit'];
    if (stage && !allowed.includes(stage)) return res.status(400).json({ error: 'Staff can only set: ready, pickup, transit' });
    const fields = { updated_at: new Date().toISOString() };
    if (stage) fields.stage = stage;
    if (awb)   fields.awb   = awb;
    if (courier) fields.courier = courier;
    if (tracking_url) fields.tracking_url = tracking_url;
    await OS.upsert(req.params.id, fields);
    auditLog('staff:' + req.staffUsername, 'update_stage', req.params.id, { stage, awb });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Email ───────────────────────────────────────────────────────────────────
async function getSmtpConfig() {
  return mdb.collection('email_config').findOne({}, { projection: { _id: 0 } });
}

async function sendEmail({ to, subject, html, replyTo }) {
  const cfg = await getSmtpConfig();
  if (!cfg) throw new Error('Email not configured. Go to Settings → Email.');
  const transporter = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: cfg.secure || false, auth: { user: cfg.user, pass: cfg.pass } });
  await transporter.sendMail({ from: `"${BRAND_NAME}" <${cfg.from || cfg.user}>`, to, subject, html, replyTo: replyTo || cfg.from || cfg.user });
  await mdb.collection('email_log').insertOne({ to, subject, sent_at: new Date() });
}

function trackButton(trackingUrl, awb, courier, label = 'Track Your Order →') {
  const c = (courier || '').toLowerCase();
  const fallback = awb ? (
    c.includes('delhivery') ? `https://www.delhivery.com/track/package/${awb}` :
    c.includes('shiprocket') ? `https://shiprocket.co/tracking/${awb}` :
    `https://shiprocket.co/tracking/${awb}`
  ) : '#';
  const url = (trackingUrl && trackingUrl.startsWith('http')) ? trackingUrl : fallback;
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${url}" target="_blank" style="display:inline-block;padding:13px 32px;background:#111;color:#fff;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.3px;">${label}</a>
  </div>`;
}

function emailBase(content, preheader = '') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${BRAND_NAME}</title></head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>` : ''}
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
    <tr><td style="background:#111;border-radius:12px 12px 0 0;padding:24px 32px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px;">${BRAND_NAME}</div>
    </td></tr>
    <tr><td style="background:#fff;padding:32px;border-radius:0 0 12px 12px;">
      ${content}
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #f0f0f0;font-size:11px;color:#aaa;text-align:center;">
        © ${new Date().getFullYear()} ${BRAND_NAME} · Powered by Arqontiq
      </div>
    </td></tr>
  </table>
  </td></tr></table></body></html>`;
}

function templateShipped({ order, awb, courier, trackingUrl }) {
  return emailBase(`
    <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">Your order has shipped! 🚚</h2>
    <p style="color:#555;font-size:14px;margin:0 0 20px">Hi ${order.customer?.firstName || 'there'}, your order <strong>${order.name}</strong> is on its way.</p>
    ${awb ? `<div style="background:#f9f9f9;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#444;">
      <strong>Tracking:</strong> ${awb} ${courier ? `· ${courier}` : ''}
    </div>` : ''}
    ${trackButton(trackingUrl, awb, courier)}
  `, `Your order ${order.name} has shipped!`);
}

function templateInTransit({ order, awb, courier, trackingUrl }) {
  return emailBase(`
    <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">On the way! 📦</h2>
    <p style="color:#555;font-size:14px;margin:0 0 20px">Hi ${order.customer?.firstName || 'there'}, your order <strong>${order.name}</strong> is in transit and moving towards you.</p>
    ${trackButton(trackingUrl, awb, courier, 'Track My Order →')}
  `, `Order ${order.name} is in transit`);
}

function templateOFD({ order, awb, courier, trackingUrl }) {
  return emailBase(`
    <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">Out for delivery today! 🛵</h2>
    <p style="color:#555;font-size:14px;margin:0 0 20px">Hi ${order.customer?.firstName || 'there'}, your order <strong>${order.name}</strong> is out for delivery. Keep your phone handy!</p>
    ${trackButton(trackingUrl, awb, courier, 'Track My Order →')}
  `, `Your order is out for delivery today!`);
}

function templateDelivered({ order }) {
  return emailBase(`
    <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">Delivered! ✅</h2>
    <p style="color:#555;font-size:14px;margin:0 0 20px">Hi ${order.customer?.firstName || 'there'}, your order <strong>${order.name}</strong> has been delivered. We hope you love it!</p>
    <p style="color:#555;font-size:13px;">If you have any issues, reply to this email and we'll sort it out.</p>
  `, `Your order ${order.name} has been delivered`);
}

app.get('/admin/email-config', adminAuth, async (req, res) => {
  const cfg = await getSmtpConfig();
  res.json(cfg ? { ...cfg, pass: '••••••' } : null);
});

app.post('/admin/email-config', adminAuth, async (req, res) => {
  try {
    const { host, port, secure, user, pass, from } = req.body || {};
    const update = { host, port: parseInt(port) || 587, secure: !!secure, user, from, updated_at: new Date() };
    if (pass) update.pass = pass;
    await mdb.collection('email_config').updateOne({}, { $set: update }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/email/test', adminAuth, async (req, res) => {
  try {
    const { to, template, orderId } = req.body || {};
    let order = { name: '#TEST-001', customer: { firstName: 'Test' }, id: '0' };
    if (orderId) {
      try { const d = await shopifyREST(`/orders/${orderId}.json?fields=name,customer`); order = d.order; } catch {}
    }
    let html;
    if (template === 'shipped')    html = templateShipped({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' });
    else if (template === 'transit') html = templateInTransit({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' });
    else if (template === 'ofd')   html = templateOFD({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' });
    else                           html = templateDelivered({ order });
    await sendEmail({ to, subject: `[TEST] ${BRAND_NAME} Email Preview`, html });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/email-logs', adminAuth, async (req, res) => {
  const logs = await mdb.collection('email_log').find({}).sort({ sent_at: -1 }).limit(100).toArray();
  res.json(logs);
});

// ─── Shipping ─────────────────────────────────────────────────────────────────
app.get('/admin/shipping-creds', adminAuth, async (req, res) => {
  const creds = await mdb.collection('shipping_creds').find({}, { projection: { _id: 0, credentials: 0 } }).toArray();
  res.json(creds);
});

app.post('/admin/shipping-creds', adminAuth, async (req, res) => {
  try {
    const { partner, credentials } = req.body || {};
    if (!partner || !credentials) return res.status(400).json({ error: 'partner and credentials required' });
    await mdb.collection('shipping_creds').updateOne({ partner }, { $set: { partner, credentials: JSON.stringify(credentials), updated_at: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/shipping-creds/:partner', adminAuth, async (req, res) => {
  await mdb.collection('shipping_creds').deleteOne({ partner: req.params.partner });
  res.json({ ok: true });
});

async function getShippingCreds(partner) {
  const row = await mdb.collection('shipping_creds').findOne({ partner });
  if (!row) throw new Error(`${partner} not connected. Go to Settings → Shipping.`);
  return JSON.parse(row.credentials);
}

async function createShipment({ partner, orderId, delivery, pickup, items, weight = 0.5, length = 15, breadth = 12, height = 8, cod = false, codAmt = 0, shipMode = 'Surface', warehouseId = '', warehouseName = '' }) {
  const creds = await getShippingCreds(partner);

  if (partner === 'shiprocket') {
    const authRes = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: creds.email, password: creds.password }),
    }).then(r => r.json());
    if (!authRes.token) throw new Error('Shiprocket auth failed.');
    const payload = {
      order_id: orderId, order_date: new Date().toISOString(),
      pickup_location: warehouseName || creds.pickup_location || 'Primary',
      billing_customer_name: delivery.name?.split(' ')[0] || 'Customer',
      billing_last_name: delivery.name?.split(' ').slice(1).join(' ') || '',
      billing_address: delivery.address1 || '', billing_address_2: delivery.address2 || '',
      billing_city: delivery.city || '', billing_pincode: String(delivery.zip || ''),
      billing_state: delivery.state || '', billing_country: 'India',
      billing_email: delivery.email || '', billing_phone: (delivery.phone || '').replace(/\D/g, '').slice(-10),
      shipping_is_billing: true,
      order_items: items.map(it => ({ name: it.title, sku: it.sku || it.id || it.title.slice(0, 40), units: it.quantity, selling_price: it.price || 0 })),
      payment_method: cod ? 'COD' : 'Prepaid',
      sub_total: items.reduce((s, it) => s + it.price * it.quantity, 0),
      length, breadth, height, weight,
    };
    const srRes = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authRes.token}` },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (srRes.status_code === 1) return { awb: srRes.awb_code, courier: 'shiprocket' };
    throw new Error(srRes.message || JSON.stringify(srRes));

  } else if (partner === 'delhivery') {
    const orderDateStr = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const custPhone = (delivery.phone || '').replace(/\D/g, '').slice(-10) || '9999999999';
    const shipData = {
      pickup_location: { name: warehouseName || creds.pickup_location || 'Primary' },
      shipments: [{
        name: delivery.name || 'Customer',
        add: delivery.address1 || '',
        add2: delivery.address2 || '',
        pin: String(delivery.zip || ''),
        city: delivery.city || '',
        state: delivery.state || '',
        country: 'India',
        phone: custPhone,
        order: orderId,
        payment_mode: cod ? 'COD' : 'Pre-paid',
        return_pin: String(creds.return_pincode || ''),
        return_city: creds.return_city || '',
        return_phone: creds.return_phone || '',
        return_name: creds.company_name || 'Warehouse',
        return_add: creds.return_address || '',
        return_state: creds.return_state || '',
        return_country: 'India',
        products_desc: items.map(it => it.title).join(', ').slice(0, 250),
        hsn_code: '',
        cod_amount: cod ? String(codAmt) : '',
        order_date: orderDateStr,
        total_amount: items.reduce((s, it) => s + it.price * it.quantity, 0),
        seller_inv: orderId,
        quantity: String(items.reduce((s, it) => s + it.quantity, 0) || 1),
        shipment_length: String(length),
        shipment_width: String(breadth),
        shipment_height: String(height),
        weight: String(Math.round(parseFloat(weight) * 1000)),
        shipping_mode: shipMode === 'Express' ? 'Express' : 'Surface',
        seller_name: creds.company_name || 'Warehouse',
        seller_add: creds.return_address || '',
        seller_city: creds.return_city || '',
        seller_state: creds.return_state || '',
        seller_pin: String(creds.return_pincode || ''),
        seller_country: 'India',
      }],
    };
    const dlBody = new URLSearchParams();
    dlBody.append('format', 'json');
    dlBody.append('data', JSON.stringify(shipData));
    const dlRes = await fetch('https://track.delhivery.com/api/cmu/create.json', {
      method: 'POST',
      headers: { 'Authorization': `Token ${creds.api_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: dlBody.toString(),
    }).then(r => r.json());
    if (dlRes.packages?.[0]?.waybill) return { awb: dlRes.packages[0].waybill, courier: 'delhivery' };
    throw new Error(dlRes.packages?.[0]?.remarks || dlRes.rmk || JSON.stringify(dlRes));
  }
  throw new Error('Unsupported partner: ' + partner);
}

app.post('/admin/orders/:id/create-shipment', adminAuth, async (req, res) => {
  try {
    const { partner, weight, length, breadth, height, shipMode, warehouseId, warehouseName } = req.body || {};
    if (!partner) return res.status(400).json({ error: 'partner required' });
    const { order } = await shopifyREST(`/orders/${req.params.id}.json`);
    const delivery = order.shipping_address || order.billing_address || {};
    delivery.phone = delivery.phone || order.phone || '';
    const result = await createShipment({
      partner, orderId: order.name,
      delivery, items: order.line_items || [],
      weight: parseFloat(weight) || 0.5,
      length: parseFloat(length) || 15,
      breadth: parseFloat(breadth) || 12,
      height: parseFloat(height) || 8,
      cod: order.financial_status === 'pending',
      codAmt: parseFloat(order.total_price) || 0,
      shipMode: shipMode || 'Surface',
      warehouseId, warehouseName,
    });
    await OS.upsert(req.params.id, { stage: 'pickup', awb: result.awb, courier: result.courier, updated_at: new Date().toISOString() });
    auditLog('admin', 'create_shipment', req.params.id, result);
    res.json({ ok: true, awb: result.awb, courier: result.courier });
  } catch (e) { console.error('create-shipment:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/staff/orders/:id/create-shipment', staffAuth, async (req, res) => {
  try {
    const { partner, weight, length, breadth, height, shipMode, warehouseId, warehouseName } = req.body || {};
    if (!partner) return res.status(400).json({ error: 'partner required' });
    const { order } = await shopifyREST(`/orders/${req.params.id}.json`);
    const delivery = order.shipping_address || order.billing_address || {};
    delivery.phone = delivery.phone || order.phone || '';
    const result = await createShipment({
      partner, orderId: order.name,
      delivery, items: order.line_items || [],
      weight: parseFloat(weight) || 0.5, length: parseFloat(length) || 15,
      breadth: parseFloat(breadth) || 12, height: parseFloat(height) || 8,
      cod: order.financial_status === 'pending',
      codAmt: parseFloat(order.total_price) || 0,
      shipMode: shipMode || 'Surface', warehouseId, warehouseName,
    });
    await OS.upsert(req.params.id, { stage: 'pickup', awb: result.awb, courier: result.courier, updated_at: new Date().toISOString() });
    auditLog('staff:' + req.staffUsername, 'create_shipment', req.params.id, result);
    res.json({ ok: true, awb: result.awb, courier: result.courier });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Return / Exchange ────────────────────────────────────────────────────────
app.get('/admin/returns', adminAuth, async (req, res) => {
  const { status } = req.query;
  const q = status ? { status } : {};
  const rrs = await mdb.collection('return_requests').find(q).sort({ created_at: -1 }).limit(200).toArray();
  res.json(rrs);
});

app.post('/admin/returns', adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const id = `RR-${Date.now()}`;
    const doc = { request_id: id, ...body, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await mdb.collection('return_requests').insertOne(doc);
    res.json({ ok: true, request_id: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/returns/:id', adminAuth, async (req, res) => {
  try {
    const { status, admin_note, ...rest } = req.body || {};
    const update = { updated_at: new Date().toISOString(), ...rest };
    if (status) update.status = status;
    if (admin_note !== undefined) update.admin_note = admin_note;
    await mdb.collection('return_requests').updateOne({ request_id: req.params.id }, { $set: update });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/returns/:id/create-shipment', adminAuth, async (req, res) => {
  try {
    const { direction, partner, weight = 0.5, length = 15, breadth = 12, height = 8, shipMode = 'Surface', warehouseName = '' } = req.body || {};
    if (!direction || !partner) return res.status(400).json({ error: 'direction and partner required' });
    const rr = await mdb.collection('return_requests').findOne({ request_id: req.params.id });
    if (!rr) return res.status(404).json({ error: 'Not found' });
    const creds = await getShippingCreds(partner);
    const isReverse = direction === 'reverse';
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const orderId = `${rr.request_id}-${direction.toUpperCase()[0]}-${suffix}`;
    const customerAddr = { name: rr.customer_name, address1: rr.customer_address1, address2: rr.customer_address2 || '', city: rr.customer_city, state: rr.customer_state, zip: rr.customer_pincode, phone: rr.customer_phone };
    const warehouseAddr = { name: creds.company_name || 'Warehouse', address1: creds.return_address || '', city: rr.return_city || creds.return_city || '', state: creds.return_state || '', zip: creds.return_pincode || '', phone: creds.return_phone || '' };
    const pickup   = isReverse ? customerAddr : warehouseAddr;
    const delivery = isReverse ? warehouseAddr : customerAddr;
    const items = rr.items || [{ title: 'Return Item', quantity: 1, price: 0, sku: '' }];
    const result = await createShipment({ partner, orderId, delivery, pickup, items, weight, length, breadth, height, shipMode, warehouseName, creds });
    const field = isReverse ? 'reverse_shipment' : 'forward_shipment';
    await mdb.collection('return_requests').updateOne({ request_id: req.params.id }, { $set: { [field]: { awb: result.awb, courier: result.courier, partner, created_at: new Date().toISOString() }, updated_at: new Date().toISOString() } });
    res.json({ ok: true, awb: result.awb, courier: result.courier });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/returns/:id/shipment/:direction', adminAuth, async (req, res) => {
  const field = req.params.direction === 'reverse' ? 'reverse_shipment' : 'forward_shipment';
  await mdb.collection('return_requests').updateOne({ request_id: req.params.id }, { $unset: { [field]: '' }, $set: { updated_at: new Date().toISOString() } });
  res.json({ ok: true });
});

app.get('/staff/returns', staffAuth, async (req, res) => {
  const rrs = await mdb.collection('return_requests').find({ status: { $in: ['approved', 'in_progress'] } }).sort({ created_at: -1 }).limit(100).toArray();
  res.json(rrs);
});

// ─── Shopify OAuth ────────────────────────────────────────────────────────────
const oauthStates = new Set();
const SCOPES = 'read_orders,write_orders,read_fulfillments,write_fulfillments,read_customers,read_products,write_products';

app.get('/install', (req, res) => {
  const shop   = req.query.shop || SHOP_DOMAIN;
  const state  = crypto.randomBytes(16).toString('hex');
  oauthStates.add(state);
  const redirectUri = encodeURIComponent(`${SERVER_URL}/shopify/callback`);
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${redirectUri}&state=${state}`);
});

app.get('/shopify/callback', async (req, res) => {
  const { code, state, shop } = req.query;
  if (!oauthStates.has(state)) return res.status(403).send('Invalid state');
  oauthStates.delete(state);
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SEC, code }),
    }).then(r => r.json());
    if (!tokenRes.access_token) return res.status(400).send('Token exchange failed: ' + JSON.stringify(tokenRes));
    SHOPIFY_TOKEN = tokenRes.access_token;
    await mdb.collection('settings').updateOne({}, { $set: { shopify_access_token: SHOPIFY_TOKEN, shop, updated_at: new Date() } }, { upsert: true });
    console.log(`✅  Shopify connected: ${shop}`);
    res.redirect('/admin.html?connected=1');
  } catch (e) { res.status(500).send('OAuth error: ' + e.message); }
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────
function verifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const digest = crypto.createHmac('sha256', CLIENT_SEC).update(req.body).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

app.post('/webhooks/orders/create', async (req, res) => {
  res.sendStatus(200);
  if (!verifyWebhook(req)) return;
  try {
    const order = JSON.parse(req.body);
    await OS.upsert(String(order.id), { stage: 'confirmed', updated_at: new Date().toISOString() });
  } catch {}
});

app.post('/webhooks/orders/updated', async (req, res) => {
  res.sendStatus(200);
  if (!verifyWebhook(req)) return;
  try {
    const order = JSON.parse(req.body);
    if (order.cancelled_at) {
      await OS.upsert(String(order.id), { stage: 'cancelled', updated_at: new Date().toISOString() });
    }
  } catch {}
});

app.post('/webhooks/fulfillments/create', async (req, res) => {
  res.sendStatus(200);
  if (!verifyWebhook(req)) return;
  try {
    const ful = JSON.parse(req.body);
    const sid = String(ful.order_id);
    const tracking = ful.tracking_numbers?.[0] || ful.tracking_number || '';
    const trackUrl = ful.tracking_urls?.[0] || ful.tracking_url || '';
    const courier  = ful.tracking_company || '';
    await OS.upsert(sid, { stage: 'pickup', awb: tracking, courier, tracking_url: trackUrl, updated_at: new Date().toISOString() });
  } catch {}
});

// ─── Settings ─────────────────────────────────────────────────────────────────
app.get('/admin/settings', adminAuth, async (req, res) => {
  const settings = await mdb.collection('settings').findOne({}, { projection: { _id: 0, shopify_access_token: 0 } });
  res.json(settings || {});
});

app.post('/admin/settings', adminAuth, async (req, res) => {
  try {
    const { whatsapp_number, brand_name } = req.body || {};
    const update = { updated_at: new Date() };
    if (whatsapp_number) update.whatsapp_number = whatsapp_number;
    if (brand_name) update.brand_name = brand_name;
    await mdb.collection('settings').updateOne({}, { $set: update }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    // Save to settings; admin reads it on next login
    await mdb.collection('settings').updateOne({}, { $set: { admin_password_override: newPassword } }, { upsert: true });
    res.json({ ok: true, message: 'Password updated. Set ADMIN_PASSWORD env var on Render to persist across restarts.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, brand: BRAND_NAME, shop: SHOP_DOMAIN }));

// ─── Serve HTML ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'staff.html')));

// ─── Start ────────────────────────────────────────────────────────────────────
connectMongo().then(async () => {
  // Load token from DB if not in env
  if (!SHOPIFY_TOKEN) {
    const s = await mdb.collection('settings').findOne({}, { projection: { shopify_access_token: 1 } });
    if (s?.shopify_access_token) { SHOPIFY_TOKEN = s.shopify_access_token; console.log('✅  Shopify token loaded from DB'); }
    else console.warn('⚠️   No Shopify token. Visit /install to connect your store.');
  }
  // Load password override from DB
  const s = await mdb.collection('settings').findOne({}, { projection: { admin_password_override: 1 } });
  if (s?.admin_password_override) process.env.ADMIN_PASSWORD = s.admin_password_override;

  app.listen(PORT, () => {
    console.log(`🚀  ${BRAND_NAME} · Powered by Arqontiq`);
    console.log(`    Running on port ${PORT}`);
    console.log(`    Admin: ${SERVER_URL}/admin.html`);
    console.log(`    Staff: ${SERVER_URL}/staff`);
    console.log(`    Install: ${SERVER_URL}/install`);
  });
}).catch(err => { console.error('❌  Startup error:', err.message); process.exit(1); });
