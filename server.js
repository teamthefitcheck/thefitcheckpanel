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
let SHOP_DOMAIN = `${SHOP_NAME}.myshopify.com`;
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
  const vars = { first: 250, query: buildOrderQuery(status, createdAtMin, createdAtMax) };
  const data = await shopifyGQL(`
    query($first:Int!,$query:String){
      orders(first:$first,query:$query,sortKey:CREATED_AT,reverse:true){
        edges{node{
          id name createdAt totalPriceSet{shopMoney{amount}}
          displayFinancialStatus displayFulfillmentStatus
          email phone tags
          customer{firstName lastName email phone}
          lineItems(first:10){edges{node{id title quantity vendor sku product{id} originalUnitPriceSet{shopMoney{amount}} variant{title}}}}
          fulfillments{status trackingInfo{number url company} createdAt}
          note
        }}
      }
    }`, vars);
  const conn = data?.data?.orders;
  if (!conn) return [];
  return conn.edges.map(e => normaliseOrder(e.node));
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
      variant_title: e.node.variant?.title || '',
      quantity: e.node.quantity,
      vendor: e.node.vendor,
      sku: e.node.sku,
      price: parseFloat(e.node.originalUnitPriceSet?.shopMoney?.amount || 0),
      product_id: e.node.product?.id?.replace('gid://shopify/Product/', '') || null,
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

// ─── Image Enrichment ────────────────────────────────────────────────────────
const imageCache = new Map();
async function enrichOrderImages(order) {
  const productIds = [...new Set((order.line_items || []).map(li => li.product_id).filter(Boolean))];
  await Promise.all(productIds.map(async pid => {
    if (imageCache.has(pid)) return;
    try {
      const d = await shopifyREST(`/products/${pid}.json?fields=id,image,images`);
      imageCache.set(pid, d.product?.image?.src || d.product?.images?.[0]?.src || null);
    } catch { imageCache.set(pid, null); }
  }));
  return {
    ...order,
    line_items: (order.line_items || []).map(li => ({
      ...li,
      image_url: imageCache.get(li.product_id) || null,
    })),
  };
}

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
      // Fall back to Shopify fulfillment data if panel has no AWB saved
      const shopifyFulfillment = (o.fulfillments || []).find(f => f.tracking_number);
      const awb = st.awb || shopifyFulfillment?.tracking_number || '';
      const courier = st.courier || shopifyFulfillment?.company || '';
      const tracking_url = st.tracking_url || shopifyFulfillment?.tracking_url || '';
      return { ...o, _stage: st.stage || 'new', _awb: awb, _courier: courier, _tracking_url: tracking_url };
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
    const enriched = await enrichOrderImages(order);
    const shopifyFulfillment = (order.fulfillments || []).find(f => f.tracking_number);
    const awb = st?.awb || shopifyFulfillment?.tracking_number || '';
    const courier = st?.courier || shopifyFulfillment?.tracking_company || '';
    const tracking_url = st?.tracking_url || shopifyFulfillment?.tracking_url || '';
    res.json({ ...enriched, _stage: st?.stage || 'new', _awb: awb, _courier: courier, _tracking_url: tracking_url });
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
    // Send stage email
    if (stage) {
      try {
        const { order } = await shopifyREST(`/orders/${req.params.id}.json`);
        const email = order.email || order.contact_email;
        const awbVal = awb || (await OS.get(req.params.id))?.awb || '';
        const courierVal = courier || (await OS.get(req.params.id))?.courier || '';
        const trackingUrl = tracking_url || (awbVal ? trackingUrlForCourier(courierVal, awbVal) : '');
        console.log(`[stage-email] order=${order.name} stage=${stage} email=${email||'none'}`);
        if (email) {
          let html, subject;
          if (stage === 'confirmed') { html = templateOrderConfirmed(order); subject = `Your order ${order.name} is confirmed! 🎉`; }
          else if (stage === 'pickup')   { html = templateShipped({ order, awb: awbVal, courier: courierVal, trackingUrl }); subject = `Your order ${order.name} has shipped! 🚚`; }
          else if (stage === 'transit')  { html = templateInTransit({ order, awb: awbVal, courier: courierVal, trackingUrl }); subject = `Your order ${order.name} is on the way 📦`; }
          else if (stage === 'ofd')      { html = templateOFD({ order, awb: awbVal, courier: courierVal, trackingUrl }); subject = `Your order ${order.name} is out for delivery today! 🛵`; }
          else if (stage === 'delivered'){ html = templateDelivered({ order }); subject = `Your order ${order.name} has been delivered ✅`; }
          if (html) {
            sendEmail({ to: email, subject, html })
              .then(() => console.log(`[stage-email] sent ${stage} email to ${email}`))
              .catch(e => console.error(`[stage-email] failed for ${stage}:`, e.message));
          } else {
            console.log(`[stage-email] no template for stage=${stage}, skipping`);
          }
        }
      } catch(e) { console.error('[stage-email] error:', e.message); }
    }
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
      .map(o => {
        const st = stageMap[String(o.id)] || {};
        const sf = (o.fulfillments || []).find(f => f.tracking_number);
        return { ...o, _stage: st.stage || 'new', _awb: st.awb || sf?.tracking_number || '', _courier: st.courier || sf?.company || '' };
      })
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

const BANNER_URL = 'https://i.ibb.co/RpYqxnMK/tfc-banner-2.png';

function emailBase(content, preheader = '') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${BRAND_NAME}</title></head>
  <body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>` : ''}
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
    <tr><td style="padding:0;line-height:0;">
      <img src="${BANNER_URL}" alt="${BRAND_NAME}" width="600" style="width:100%;max-width:600px;display:block;border-radius:16px 16px 0 0;" />
    </td></tr>
    <tr><td style="background:#ffffff;padding:32px 36px;">
      ${content}
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #f0f0f0;font-size:11px;color:#aaa;text-align:center;">
        © ${new Date().getFullYear()} ${BRAND_NAME} · All rights reserved
      </div>
    </td></tr>
    <tr><td style="background:#111;padding:16px 32px;text-align:center;border-radius:0 0 16px 16px;">
      <div style="font-size:11px;color:#666;">Powered by <span style="color:#fff;font-weight:600;">Arqontiq</span></div>
    </td></tr>
  </table>
  </td></tr></table></body></html>`;
}

function templateOrderConfirmed(order) {
  const items = (order.line_items || []).map(li => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f5f5f5;font-size:13px;color:#333;">
        <strong>${li.title}</strong>${li.variant_title && li.variant_title !== 'Default Title' ? `<br/><span style="color:#888;font-size:12px;">${li.variant_title}</span>` : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #f5f5f5;font-size:13px;color:#888;text-align:center;">×${li.quantity}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f5f5f5;font-size:13px;color:#333;text-align:right;font-weight:600;">₹${parseFloat(li.price * (li.quantity || 1)).toLocaleString('en-IN')}</td>
    </tr>`).join('');

  const addr = order.shipping_address || order.billing_address || {};
  const addrLine = [addr.address1, addr.address2, addr.city, addr.province, addr.zip].filter(Boolean).join(', ');

  return emailBase(`
    <h2 style="font-size:22px;font-weight:800;color:#111;margin:0 0 4px">Order Placed Successfully! 🎉</h2>
    <p style="color:#555;font-size:14px;margin:0 0 24px">Hey ${order.customer?.first_name || order.shipping_address?.first_name || 'there'}, thank you for your order! We've received it and you'll get updates as it moves forward.</p>

    <div style="background:#f9f9f9;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Order Number</span>
        <span style="font-size:14px;font-weight:800;color:#111;font-family:monospace;">${order.name}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Date</span>
        <span style="font-size:13px;color:#555;">${new Date(order.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Payment</span>
        <span style="font-size:13px;color:#555;font-weight:600;">${order.financial_status === 'paid' ? '✅ Prepaid' : '💵 Cash on Delivery'}</span>
      </div>
    </div>

    <div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;">Items Ordered</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      ${items}
      <tr>
        <td colspan="2" style="padding:12px 0 0;font-size:14px;font-weight:800;color:#111;">Total Amount</td>
        <td style="padding:12px 0 0;font-size:15px;font-weight:800;color:#111;text-align:right;">₹${parseFloat(order.total_price || 0).toLocaleString('en-IN')}</td>
      </tr>
    </table>

    ${addrLine ? `
    <div style="background:#f9f9f9;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px;">Delivering To</div>
      <div style="font-size:13px;color:#333;line-height:1.6;">${addr.name || ((addr.first_name||'') + ' ' + (addr.last_name||''))}<br/>${addrLine}</div>
    </div>` : ''}

    <p style="color:#888;font-size:13px;margin:0;">We'll keep you updated every step of the way. For any queries, just reply to this email.</p>
  `, `Order placed! ${order.name} is on its way 🎉`);
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
    let html, subject;
    if (template === 'confirmed')  { html = templateOrderConfirmed({ ...order, line_items: order.line_items || [{ title: 'Sample Product', variant_title: 'Size M', price: '799.00', quantity: 1 }], total_price: order.total_price || '799.00' }); subject = `[TEST] Order Confirmed 🎉`; }
    else if (template === 'shipped')  { html = templateShipped({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' }); subject = `[TEST] Your order has shipped 🚚`; }
    else if (template === 'transit')  { html = templateInTransit({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' }); subject = `[TEST] Your order is in transit 📦`; }
    else if (template === 'ofd')      { html = templateOFD({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' }); subject = `[TEST] Out for delivery today 🛵`; }
    else if (template === 'delivered'){ html = templateDelivered({ order }); subject = `[TEST] Your order has been delivered ✅`; }
    else                              { html = templateDelivered({ order }); subject = `[TEST] ${BRAND_NAME} Email Preview`; }
    await sendEmail({ to, subject, html });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/email/preview', (req, res) => {
  const t = req.query.template || 'confirmed';
  const order = { name: '#TEST-001', customer: { firstName: 'Test' }, id: '0', line_items: [{ title: 'Sample Product', variant_title: 'Size M', price: '799.00', quantity: 1 }], total_price: '799.00' };
  let html;
  if (t === 'confirmed') html = templateOrderConfirmed(order);
  else if (t === 'shipped') html = templateShipped({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' });
  else if (t === 'transit') html = templateInTransit({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' });
  else if (t === 'ofd') html = templateOFD({ order, awb: 'TESTAWB123', courier: 'Delhivery', trackingUrl: '' });
  else html = templateDelivered({ order });
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
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
const SCOPES = 'read_orders,write_orders,read_fulfillments,write_fulfillments,read_customers,read_products,write_products';

app.get('/install', async (req, res) => {
  const shop  = req.query.shop || SHOP_DOMAIN;
  const state = crypto.randomBytes(16).toString('hex');
  await mdb.collection('oauth_states').insertOne({ state, created_at: new Date() });
  const redirectUri = `${SERVER_URL}/shopify/callback`;
  console.log(`[install] shop=${shop} client_id=${CLIENT_ID} redirect_uri=${redirectUri}`);
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`);
});

app.get('/shopify/callback', async (req, res) => {
  const { code, state, shop } = req.query;
  const found = await mdb.collection('oauth_states').findOneAndDelete({ state });
  if (!found) return res.status(403).send('Invalid or expired state. Please visit /install again.');
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
  if (!hmac) { console.warn('[webhook] missing hmac header'); return false; }
  if (!CLIENT_SEC) { console.warn('[webhook] SHOPIFY_CLIENT_SECRET not set — skipping verification'); return true; }
  const digest = crypto.createHmac('sha256', CLIENT_SEC).update(req.body).digest('base64');
  const ok = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  if (!ok) console.warn('[webhook] hmac mismatch — rejected');
  return ok;
}

app.post('/webhooks/orders/create', async (req, res) => {
  res.sendStatus(200);
  if (!verifyWebhook(req)) return;
  try {
    const order = JSON.parse(req.body);
    await OS.upsert(String(order.id), { stage: 'new', updated_at: new Date().toISOString() });
    const email = order.email || order.contact_email;
    console.log(`[orders/create] ${order.name} email=${email||'none'}`);
    if (email) {
      sendEmail({ to: email, subject: `Order Placed Successfully – ${order.name} 🎉`, html: templateOrderConfirmed(order) })
        .then(()=>console.log(`[orders/create] confirmation email sent to ${email}`))
        .catch(e=>console.error(`[orders/create] email failed:`, e.message));
    } else {
      console.warn(`[orders/create] ${order.name} has no email — skipping`);
    }
  } catch(e) { console.error('[orders/create] error:', e.message); }
});

app.post('/webhooks/orders/updated', async (req, res) => {
  res.sendStatus(200);
  if (!verifyWebhook(req)) return;
  try {
    const order = JSON.parse(req.body);
    const sid = String(order.id);
    if (order.cancelled_at) {
      await OS.upsert(sid, { stage: 'cancelled', updated_at: new Date().toISOString() });
      return;
    }
    // Auto-map tags → stage
    const cfg = await mdb.collection('settings').findOne({}, { projection: { tag_mappings: 1 } });
    const tagMap = cfg?.tag_mappings || {};
    const tags = order.tags ? order.tags.split(',').map(t => t.trim()) : [];
    let mappedStage = null;
    for (const tag of tags) {
      if (tagMap[tag]) { mappedStage = tagMap[tag]; break; }
    }
    if (mappedStage) {
      const current = await OS.get(sid);
      if (current?.stage !== mappedStage) {
        await OS.upsert(sid, { stage: mappedStage, updated_at: new Date().toISOString() });
      }
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
    const courier = ful.tracking_company || '';
    await OS.upsert(sid, { stage: 'pickup', awb: tracking, courier, tracking_url: trackUrl, updated_at: new Date().toISOString() });
    console.log(`[fulfillments/create] order=${sid} awb=${tracking} courier=${courier}`);
    if (tracking) {
      try {
        const { order } = await shopifyREST(`/orders/${sid}.json`);
        const email = order.email || order.contact_email;
        if (email) {
          await sendEmail({ to: email, subject: `Your order ${order.name} has shipped! 🚚`, html: templateShipped({ order, awb: tracking, courier, trackingUrl: trackUrl }) });
          console.log(`[fulfillments/create] shipped email sent to ${email}`);
        }
      } catch(e) { console.error('[fulfillments/create] email error:', e.message); }
    }
  } catch(e) { console.error('[fulfillments/create] error:', e.message); }
});

// ─── Tracking Sync ───────────────────────────────────────────────────────────

const ESHIPZ_TAG_TO_STAGE = {
  InfoReceived:    'confirmed',
  PickupRegistered:'confirmed',
  OutForPickup:    'confirmed',
  PickedUp:        'pickup',
  InTransit:       'transit',
  OutForDelivery:  'ofd',
  Delivered:       'delivered',
  ReturnToOrigin:  'rto',
  Return:          'rto',
  Cancelled:       'cancelled',
};

async function scrapeEshipzStatus(trackingUrl) {
  try {
    const res = await fetch(trackingUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    // Extract response_data JSON embedded in the page
    const m = html.match(/var\s+response_data\s*=\s*(\[.*?\]);/s);
    if (!m) return null;
    const events = JSON.parse(m[1]);
    if (!events.length) return null;
    // Latest event is first
    const latest = events[0];
    const stage = ESHIPZ_TAG_TO_STAGE[latest.subtag] || ESHIPZ_TAG_TO_STAGE[latest.tag] || null;
    return { stage, tag: latest.tag, subtag: latest.subtag, message: latest.message, city: latest.city, checkpoint_time: latest.checkpoint_time };
  } catch(e) {
    return null;
  }
}

async function runTrackingSync() {
  if (!SHOPIFY_TOKEN || !SHOP_DOMAIN || SHOP_DOMAIN.startsWith('.')) return;
  console.log('[tracking-sync] starting...');
  try {
    // Get all orders in active shipping stages that have a tracking URL
    const activeStages = await mdb.collection('order_stage').find({
      stage: { $in: ['pickup', 'transit', 'ofd'] },
      tracking_url: { $exists: true, $ne: '' }
    }).toArray();

    console.log(`[tracking-sync] ${activeStages.length} orders to check`);
    let updated = 0;

    for (const rec of activeStages) {
      if (!rec.tracking_url?.includes('eshipz') && !rec.tracking_url?.includes('eshipz')) continue;
      const result = await scrapeEshipzStatus(rec.tracking_url);
      if (!result || !result.stage) continue;
      if (result.stage === rec.stage) continue; // no change

      console.log(`[tracking-sync] ${rec.shopify_id}: ${rec.stage} → ${result.stage} (${result.subtag})`);
      await OS.upsert(rec.shopify_id, { stage: result.stage, updated_at: new Date().toISOString() });

      // Send customer email for the new stage
      try {
        const { order } = await shopifyREST(`/orders/${rec.shopify_id}.json`);
        const email = order.email || order.contact_email;
        const awb = rec.awb || '';
        const courier = rec.courier || '';
        const trackingUrl = rec.tracking_url || '';
        if (email) {
          let html, subject;
          if (result.stage === 'transit')  { html = templateInTransit({ order, awb, courier, trackingUrl }); subject = `Your order ${order.name} is on the way 📦`; }
          else if (result.stage === 'ofd') { html = templateOFD({ order, awb, courier, trackingUrl }); subject = `Your order ${order.name} is out for delivery today! 🛵`; }
          else if (result.stage === 'delivered') { html = templateDelivered({ order }); subject = `Your order ${order.name} has been delivered ✅`; }
          else if (result.stage === 'rto') { html = templateDelivered({ order }); subject = `Update on your order ${order.name}`; }
          if (html) {
            await sendEmail({ to: email, subject, html });
            console.log(`[tracking-sync] email sent to ${email} for stage=${result.stage}`);
          }
        }
      } catch(e) { console.error(`[tracking-sync] email error for ${rec.shopify_id}:`, e.message); }
      updated++;
    }
    console.log(`[tracking-sync] done. ${updated} orders updated.`);
  } catch(e) { console.error('[tracking-sync] error:', e.message); }
}

// Manual trigger endpoint
app.post('/admin/sync-tracking', adminAuth, async (req, res) => {
  res.json({ ok: true, message: 'Tracking sync started' });
  runTrackingSync();
});

app.get('/admin/sync-tracking/status', adminAuth, async (req, res) => {
  const active = await mdb.collection('order_stage').countDocuments({ stage: { $in: ['pickup','transit','ofd'] }, tracking_url: { $exists: true, $ne: '' } });
  res.json({ active_shipments: active });
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

// ─── Tag Mappings ─────────────────────────────────────────────────────────────
// Maps Shopify order tags → internal stages. Admin configures these.
app.get('/admin/shopify-tags', adminAuth, async (req, res) => {
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    const orders = await fetchAllOrders('any', from, null);
    const tags = [...new Set(orders.flatMap(o => o.tags || []))].filter(Boolean).sort();
    res.json(tags);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/tag-mappings', adminAuth, async (req, res) => {
  const doc = await mdb.collection('settings').findOne({}, { projection: { tag_mappings: 1, _id: 0 } });
  res.json(doc?.tag_mappings || {});
});

app.post('/admin/tag-mappings', adminAuth, async (req, res) => {
  try {
    const { tag_mappings } = req.body || {};
    await mdb.collection('settings').updateOne({}, { $set: { tag_mappings, updated_at: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply a Shopify tag to an order
app.post('/admin/reregister-webhooks', adminAuth, async (req, res) => {
  try {
    const webhookKey = `webhooks_registered_${SERVER_URL}`;
    await mdb.collection('settings').updateOne({}, { $unset: { [webhookKey]: '' } }, { upsert: true });
    const { webhooks: existing } = await shopifyREST('/webhooks.json?limit=250');
    const needed = [
      { topic: 'orders/create',       address: `${SERVER_URL}/webhooks/orders/create` },
      { topic: 'orders/updated',      address: `${SERVER_URL}/webhooks/orders/updated` },
      { topic: 'fulfillments/create', address: `${SERVER_URL}/webhooks/fulfillments/create` },
    ];
    const results = [];
    for (const wh of needed) {
      const exists = (existing || []).some(e => e.topic === wh.topic && e.address === wh.address);
      if (!exists) {
        await shopifyREST('/webhooks.json', { method: 'POST', body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: 'json' } }) });
        results.push(`registered: ${wh.topic}`);
      } else {
        results.push(`already exists: ${wh.topic}`);
      }
    }
    await mdb.collection('settings').updateOne({}, { $set: { [webhookKey]: true } }, { upsert: true });
    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/orders/:id/tag', adminAuth, async (req, res) => {
  try {
    const { tag, remove } = req.body || {};
    const { order } = await shopifyREST(`/orders/${req.params.id}.json?fields=id,tags`);
    const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    let newTags;
    if (remove) newTags = tags.filter(t => t !== tag);
    else if (!tags.includes(tag)) newTags = [...tags, tag];
    else newTags = tags;
    await shopifyREST(`/orders/${req.params.id}.json`, { method: 'PUT', body: JSON.stringify({ order: { id: req.params.id, tags: newTags.join(', ') } }) });
    res.json({ ok: true, tags: newTags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── R&R Settings ─────────────────────────────────────────────────────────────
app.get('/admin/rr-settings', adminAuth, async (req, res) => {
  const doc = await mdb.collection('settings').findOne({}, { projection: { exchange_enabled: 1, return_enabled: 1, return_window_days: 1, _id: 0 } });
  res.json({ exchange_enabled: doc?.exchange_enabled !== false, return_enabled: doc?.return_enabled !== false, return_window_days: doc?.return_window_days || 7 });
});

app.post('/admin/rr-settings', adminAuth, async (req, res) => {
  try {
    const { exchange_enabled, return_enabled, return_window_days } = req.body || {};
    await mdb.collection('settings').updateOne({}, { $set: { exchange_enabled, return_enabled, return_window_days: parseInt(return_window_days) || 7, updated_at: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, brand: BRAND_NAME, shop: SHOP_DOMAIN }));

// ─── Public Track Routes ──────────────────────────────────────────────────────
function normalizePhone(p = '') {
  const d = p.replace(/\D/g, '');
  return d.startsWith('91') && d.length > 10 ? d.slice(2) : d;
}

function trackingUrlForCourier(courier, awb) {
  const c = (courier || '').toLowerCase();
  if (!awb) return null;
  if (c.includes('delhivery'))  return `https://www.delhivery.com/track/package/${awb}`;
  if (c.includes('shiprocket')) return `https://shiprocket.co/tracking/${awb}`;
  if (c.includes('bluedart'))   return `https://www.bluedart.com/tracking?trackNo=${awb}`;
  if (c.includes('dtdc'))       return `https://www.dtdc.in/tracking.asp?txtrknumber=${awb}`;
  if (c.includes('xpressbee'))  return `https://www.xpressbees.com/shipment/tracking?awbNumber=${awb}`;
  if (c.includes('ecom'))       return `https://ecomexpress.in/tracking/?awb_field=${awb}`;
  if (c.includes('shadowfax'))  return `https://track.shadowfax.in/?awb=${awb}`;
  if (c.includes('ekart'))      return `https://ekartlogistics.com/track?trackingId=${awb}`;
  return null;
}

// GET /track/order?q=1234&contact=email_or_phone
app.get('/track/order', async (req, res) => {
  try {
    const { q, contact } = req.query;
    if (!q) return res.status(400).json({ error: 'Order number is required' });

    const name = `#${q.replace(/^#/, '').trim()}`;
    const data = await shopifyREST(`/orders.json?name=${encodeURIComponent(name)}&status=any&limit=5`);
    const orders = data.orders || [];

    const skipContact = !contact || contact.trim().toLowerCase() === 'na';
    let order;
    if (skipContact) {
      order = orders[0];
    } else {
      const contactClean = contact.toLowerCase().trim();
      const contactPhone = normalizePhone(contact);
      order = orders.find(o => {
        const oEmail = (o.email || o.contact_email || '').toLowerCase().trim();
        const oPhone = normalizePhone(o.shipping_address?.phone || o.billing_address?.phone || o.phone || '');
        return oEmail === contactClean || (contactPhone.length >= 10 && oPhone === contactPhone);
      });
    }

    if (!order) return res.status(404).json({ error: 'Order not found. Please check your order number and contact details.' });

    const sid = String(order.id);
    const st  = await OS.get(sid) || {};

    // AWB from our DB first, then Shopify fulfillments
    let awb = st.awb || null;
    let courier = st.courier || null;
    let trackingUrl = st.tracking_url || null;
    if (!awb) {
      for (const f of (order.fulfillments || [])) {
        if (f.tracking_number) { awb = f.tracking_number; courier = f.tracking_company || null; trackingUrl = f.tracking_url || null; break; }
      }
    }
    if (!trackingUrl && awb) trackingUrl = trackingUrlForCourier(courier, awb);

    const customerName = order.shipping_address
      ? `${order.shipping_address.first_name || ''} ${order.shipping_address.last_name || ''}`.trim()
      : order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : '';

    const existingRRs = await mdb.collection('return_requests').find(
      { shopify_order_id: sid },
      { projection: { _id: 0, request_id: 1, type: 1, status: 1, reason: 1, created_at: 1 } }
    ).sort({ created_at: -1 }).toArray();

    // Return/exchange settings from DB
    const rrCfg = await mdb.collection('settings').findOne({}, { projection: { exchange_enabled: 1, return_enabled: 1, return_window_days: 1, _id: 0 } }) || {};

    res.json({
      shopify_order_id: order.id,
      order_name: order.name,
      customer_name: customerName,
      customer_email: order.email || '',
      customer_phone: order.shipping_address?.phone || order.billing_address?.phone || order.phone || '',
      customer_address: order.shipping_address || order.billing_address || null,
      stage: st.stage || 'confirmed',
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      created_at: order.created_at,
      awb, courier, tracking_url: trackingUrl,
      items: (order.line_items || []).map(li => ({
        line_item_id: li.id, title: li.title, variant_title: li.variant_title || '',
        sku: li.sku, qty: li.quantity, price: li.price,
      })),
      return_requests: existingRRs,
      exchange_enabled: rrCfg.exchange_enabled !== false,
      return_enabled: rrCfg.return_enabled !== false,
      return_window_days: rrCfg.return_window_days || 7,
    });
  } catch (e) { console.error('GET /track/order:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /track/my-orders?contact=email_or_phone
app.get('/track/my-orders', async (req, res) => {
  try {
    const { contact } = req.query;
    if (!contact || contact.trim().length < 5) return res.status(400).json({ error: 'Please enter a valid email or phone number.' });

    const contactClean = contact.trim().toLowerCase();
    const contactPhone = normalizePhone(contact);
    const isPhone = /^\d{7,}$/.test(contactPhone);

    let allOrders = [];
    let page = await shopifyREST('/orders.json?status=any&limit=250');
    allOrders = allOrders.concat(page.orders || []);
    for (let i = 0; i < 3 && (page.orders || []).length === 250; i++) {
      const lastId = page.orders[page.orders.length - 1]?.id;
      if (!lastId) break;
      page = await shopifyREST(`/orders.json?status=any&limit=250&since_id=${lastId}`);
      allOrders = allOrders.concat(page.orders || []);
    }

    const matched = allOrders.filter(o => {
      const oEmail = (o.email || o.contact_email || '').toLowerCase().trim();
      const oPhone = normalizePhone(o.shipping_address?.phone || o.billing_address?.phone || o.phone || '');
      if (isPhone) return oPhone === contactPhone && contactPhone.length >= 7;
      return oEmail === contactClean && contactClean.includes('@');
    });

    if (!matched.length) return res.status(404).json({ error: 'No orders found for this contact.' });

    const ids = matched.map(o => String(o.id));
    const stages = await mdb.collection('order_stage').find({ shopify_id: { $in: ids } }, { projection: { shopify_id: 1, stage: 1, _id: 0 } }).toArray();
    const stageMap = Object.fromEntries(stages.map(s => [s.shopify_id, s.stage]));

    res.json({
      orders: matched.slice(0, 20).map(o => ({
        shopify_order_id: o.id,
        order_name: o.name,
        created_at: o.created_at,
        stage: stageMap[String(o.id)] || 'confirmed',
        financial_status: o.financial_status,
        item_count: (o.line_items || []).reduce((s, li) => s + li.quantity, 0),
        items_preview: (o.line_items || []).slice(0, 2).map(li => li.title).join(', '),
        total: o.total_price,
      })),
    });
  } catch (e) { console.error('GET /track/my-orders:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /track/request — public submit return/exchange
app.post('/track/request', async (req, res) => {
  try {
    const { shopify_order_id, order_name, customer_email, customer_name, customer_phone,
            customer_address1, customer_address2, customer_city, customer_state, customer_pincode,
            type, items, reason, image_urls } = req.body || {};

    if (!shopify_order_id || !type || !items?.length || !reason)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!['return', 'exchange'].includes(type))
      return res.status(400).json({ error: "type must be 'return' or 'exchange'" });

    const now = new Date();
    const rand = String(Math.floor(Math.random() * 9000) + 1000);
    const request_id = `RR-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${rand}`;

    const doc = {
      request_id,
      shopify_order_id: String(shopify_order_id),
      order_name: order_name || '',
      customer_email: (customer_email || '').toLowerCase().trim(),
      customer_name: customer_name || '',
      customer_phone: customer_phone || '',
      customer_address1: customer_address1 || '',
      customer_address2: customer_address2 || '',
      customer_city: customer_city || '',
      customer_state: customer_state || '',
      customer_pincode: customer_pincode || '',
      type, items, reason,
      status: 'pending',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      admin_note: '',
      image_urls: Array.isArray(image_urls) ? image_urls : [],
    };

    await mdb.collection('return_requests').insertOne(doc);

    // Notify admin via email (optional, ignore errors)
    try {
      const cfg = await getSmtpConfig();
      if (cfg) {
        await sendEmail({
          to: cfg.from || cfg.user,
          subject: `New ${type} request — ${order_name} (${request_id})`,
          html: emailBase(`<h2 style="font-size:18px;font-weight:700;color:#111;margin:0 0 12px">New ${type} request</h2>
            <p style="font-size:14px;color:#555;">Order: <strong>${order_name}</strong> · ${customer_name} · ${customer_email}</p>
            <p style="font-size:14px;color:#555;margin-top:8px;">Reason: ${reason}</p>
            <p style="font-size:14px;color:#555;margin-top:8px;">Request ID: <strong>${request_id}</strong></p>`),
        });
      }
    } catch {}

    res.json({ success: true, request_id });
  } catch (e) { console.error('POST /track/request:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── Serve HTML ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'staff.html')));
app.get('/track', (req, res) => res.sendFile(path.join(__dirname, 'track.html')));

// ─── Start ────────────────────────────────────────────────────────────────────
connectMongo().then(async () => {
  // Load token from DB if not in env
  const dbSettings = await mdb.collection('settings').findOne({}, { projection: { shopify_access_token: 1, shop: 1 } });
  if (!SHOPIFY_TOKEN) {
    if (dbSettings?.shopify_access_token) { SHOPIFY_TOKEN = dbSettings.shopify_access_token; console.log('✅  Shopify token loaded from DB'); }
    else console.warn('⚠️   No Shopify token. Visit /install to connect your store.');
  }
  if (!SHOP_NAME && dbSettings?.shop) {
    SHOP_DOMAIN = dbSettings.shop;
    console.log(`✅  Shop domain loaded from DB: ${SHOP_DOMAIN}`);
  }
  // Load password override from DB
  const s = await mdb.collection('settings').findOne({}, { projection: { admin_password_override: 1 } });
  if (s?.admin_password_override) process.env.ADMIN_PASSWORD = s.admin_password_override;

  // Auto-register Shopify webhooks (only if not already done for this SERVER_URL)
  if (SHOPIFY_TOKEN && SHOP_DOMAIN && !SHOP_DOMAIN.startsWith('.')) {
    const webhookKey = `webhooks_registered_${SERVER_URL}`;
    const alreadyDone = await mdb.collection('settings').findOne({ [webhookKey]: true });
    if (!alreadyDone) {
      try {
        const { webhooks: existing } = await shopifyREST('/webhooks.json?limit=250');
        const needed = [
          { topic: 'orders/create',        address: `${SERVER_URL}/webhooks/orders/create` },
          { topic: 'orders/updated',       address: `${SERVER_URL}/webhooks/orders/updated` },
          { topic: 'fulfillments/create',  address: `${SERVER_URL}/webhooks/fulfillments/create` },
        ];
        for (const wh of needed) {
          const exists = (existing || []).some(e => e.topic === wh.topic && e.address === wh.address);
          if (!exists) {
            await shopifyREST('/webhooks.json', { method: 'POST', body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: 'json' } }) });
            console.log(`✅  Webhook registered: ${wh.topic}`);
          }
        }
        await mdb.collection('settings').updateOne({}, { $set: { [webhookKey]: true } }, { upsert: true });
        console.log('✅  Webhooks registered and saved to DB');
      } catch (e) { console.warn('⚠️   Webhook registration failed:', e.message); }
    } else {
      console.log('✓   Webhooks already registered');
    }
  }

  app.listen(PORT, () => {
    console.log(`🚀  ${BRAND_NAME} · Powered by Arqontiq`);
    console.log(`    Running on port ${PORT}`);
    console.log(`    Admin: ${SERVER_URL}/admin.html`);
    console.log(`    Staff: ${SERVER_URL}/staff`);
    console.log(`    Install: ${SERVER_URL}/install`);
  });

  // Auto-sync tracking every 2 hours
  if (SHOPIFY_TOKEN && SHOP_DOMAIN && !SHOP_DOMAIN.startsWith('.')) {
    setTimeout(() => {
      runTrackingSync();
      setInterval(runTrackingSync, 2 * 60 * 60 * 1000);
    }, 30000); // wait 30s after startup before first sync
    console.log('✅  Tracking auto-sync enabled (every 2 hours)');
  }
}).catch(err => { console.error('❌  Startup error:', err.message); process.exit(1); });
