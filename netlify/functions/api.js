process.env.TZ = 'America/New_York';
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const SQUARE_WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'BK Exclusivez <bookings@notifications.bkexclusivez.com>';
const BK_NOTIFICATION_EMAIL = process.env.BK_NOTIFICATION_EMAIL || 'bktransportescapesllc@gmail.com';
const SQUARE_API_URL = 'https://connect.squareup.com/v2/online-checkout/payment-links';
const SQUARE_API_VERSION = '2026-09-16';
const HOLD_MINUTES = 15;

function response(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) };
}
function fail(status, message) { return response(status, { error: message }); }
function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(raw || '{}');
}
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim()); }
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime()); }
function minutesFromTime(s) {
  const m = /^([0-9]{1,2}):([0-9]{2})\s*(AM|PM)$/i.exec(String(s || '').trim());
  if (!m || Number(m[2]) > 59) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
function localDateTime(date, minutes) { const d = new Date(`${date}T00:00:00`); d.setMinutes(minutes); return d; }
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }
function validateBooking(b) {
  if (!validEmail(b.email)) return 'Please enter a valid email address so we can send reservation updates.';
  if (!validDate(b.date)) return 'Please choose a valid date.';
  if (!b.start_time || !b.end_time) return 'Please choose a start and end time.';
  if (String(b.service || '').startsWith('Airport Pickup / Drop-Off')) return 'Airport Pickup / Drop-Off uses the quote request flow.';
  const start = minutesFromTime(b.start_time), end = Number(b.end_minutes);
  if (start === null || !Number.isFinite(end)) return 'Invalid booking time.';
  if (end <= start) return 'End time must be after start time.';
  const duration = end - start;
  if (duration < 180) return 'Bookings require a minimum of 3 hours.';
  if (duration > 720) return 'Bookings can be up to 12 hours.';
  if (duration % 30 !== 0) return 'Bookings must use 30-minute increments.';
  return null;
}
function toRecord(r) {
  return {
    id:r.id, status:r.status, createdAt:r.created_at, expiresAt:r.expires_at,
    startAt:r.start_at, endAt:r.end_at,
    customer:{name:r.customer_name || '', phone:r.customer_phone || '', email:r.customer_email || ''},
    occasion:r.occasion || '', service:r.service || '', total:Number(r.total || 0),
    deposit:Number(r.deposit || 0), passengers:Number(r.passengers || 1),
    pickup:r.pickup || '', stops:r.stops || [], dropoff:r.dropoff || '',
    addons:r.addons || {}, squareOrderId:r.square_order_id,
    squarePaymentLinkId:r.square_payment_link_id, squarePaymentUrl:r.square_payment_url || null, squarePaymentId:r.square_payment_id,
    paidAt:r.paid_at, adminNote:r.admin_note || ''
  };
}
function fromRecord(r) {
  return {
    id:r.id, status:r.status, created_at:r.createdAt, expires_at:r.expiresAt,
    start_at:r.startAt, end_at:r.endAt, customer_name:r.customer?.name || '',
    customer_phone:r.customer?.phone || '', customer_email:r.customer?.email || '', occasion:r.occasion || '', service:r.service || '',
    total:r.total || 0, deposit:r.deposit || 0, passengers:r.passengers || 1,
    pickup:r.pickup || '', stops:r.stops || [], dropoff:r.dropoff || '',
    addons:r.addons || {}, square_order_id:r.squareOrderId || null,
    square_payment_link_id:r.squarePaymentLinkId || null, square_payment_url:r.squarePaymentUrl || null,
    square_payment_id:r.squarePaymentId || null, paid_at:r.paidAt || null,
    admin_note:r.adminNote || ''
  };
}
async function db(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase server credentials are not configured.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    console.error('Supabase error:', res.status, data || text);
    throw new Error(data?.message || data?.hint || 'Database request failed.');
  }
  return data;
}
async function allRecords() {
  const rows = await db('reservations?select=*&order=start_at.asc&limit=2000');
  return (rows || []).map(toRecord);
}
async function getById(id) {
  const rows = await db(`reservations?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows?.[0] ? toRecord(rows[0]) : null;
}
async function insertRecord(record) {
  const rows = await db('reservations', { method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify(fromRecord(record)) });
  return rows?.[0] ? toRecord(rows[0]) : record;
}
async function updateRecord(id, patch) {
  const map = {
    status:'status', expiresAt:'expires_at', squareOrderId:'square_order_id',
    squarePaymentLinkId:'square_payment_link_id', squarePaymentUrl:'square_payment_url', squarePaymentId:'square_payment_id',
    paidAt:'paid_at', adminNote:'admin_note'
  };
  const body = {};
  for (const [k,v] of Object.entries(patch)) if (map[k]) body[map[k]] = v;
  const rows = await db(`reservations?id=eq.${encodeURIComponent(id)}`, {
    method:'PATCH', headers:{Prefer:'return=representation'}, body:JSON.stringify(body)
  });
  return rows?.[0] ? toRecord(rows[0]) : null;
}
async function deleteRecord(id) {
  await db(`reservations?id=eq.${encodeURIComponent(id)}`, { method:'DELETE' });
}
async function getBySquareOrder(orderId) {
  const rows = await db(`reservations?select=*&square_order_id=eq.${encodeURIComponent(orderId)}&limit=1`);
  return rows?.[0] ? toRecord(rows[0]) : null;
}
async function cleanupExpired() {
  const now = new Date().toISOString();
  await db(`reservations?status=eq.hold&expires_at=lte.${encodeURIComponent(now)}`, {method:'DELETE'});
  return allRecords();
}
function busy(r) { return r.status === 'confirmed' || r.status === 'blocked' || r.status === 'awaiting_payment' || (r.status === 'hold' && r.expiresAt && new Date(r.expiresAt).getTime() > Date.now()); }
function makeRecord(b, status = 'pending') {
  const startMinutes = minutesFromTime(b.start_time), endMinutes = Number(b.end_minutes);
  const startAt = localDateTime(b.date, startMinutes), endAt = localDateTime(b.date, endMinutes);
  return {
    id: crypto.randomUUID(), status, createdAt:new Date().toISOString(),
    expiresAt:status === 'hold' ? new Date(Date.now()+HOLD_MINUTES*60000).toISOString() : null,
    startAt:startAt.toISOString(), endAt:endAt.toISOString(),
    customer:{name:b.name || '',phone:b.phone || '',email:b.email || ''}, occasion:b.occasion || '',
    service:b.service || '', total:Number(b.total || 0), deposit:100,
    passengers:Number(b.passengers || 1), pickup:b.pickup || '',
    stops:Array.isArray(b.stops) ? b.stops : [], dropoff:b.dropoff || '', addons:b.addons || {}
  };
}
async function createSquarePaymentLink(reservation) {
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) throw new Error('Square credentials are not configured.');
  const response = await fetch(SQUARE_API_URL, {
    method:'POST',
    headers:{'Square-Version':SQUARE_API_VERSION,Authorization:`Bearer ${SQUARE_ACCESS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      idempotency_key:crypto.randomUUID(),
      quick_pay:{name:'BK Exclusivez Reservation Deposit',price_money:{amount:10000,currency:'USD'},location_id:SQUARE_LOCATION_ID},
      description:`BK Exclusivez reservation deposit - ${reservation.id}`,
      payment_note:`Reservation ID: ${reservation.id}`
    })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error('Square API error:', data);
    throw new Error(data?.errors?.[0]?.detail || 'Unable to create Square payment link.');
  }
  return data.payment_link;
}

function emailEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function reservationEmailDetails(r) {
  const date = new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(r.startAt));
  const timeFmt = new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'});
  const stops = (r.stops || []).filter(Boolean);
  return {
    date,
    time: `${timeFmt.format(new Date(r.startAt))} – ${timeFmt.format(new Date(r.endAt))}`,
    stops: stops.length ? stops.map((s,i)=>`${i+1}. ${s}`).join('\\n') : 'None',
    stopsHtml: stops.length ? `<ol>${stops.map(s=>`<li>${emailEscape(s)}</li>`).join('')}</ol>` : '<p>None</p>'
  };
}
function reservationEmailHtml(title, intro, r, extraHtml = '') {
  const d = reservationEmailDetails(r);
  const rows = [
    ['Customer',r.customer?.name],['Email',r.customer?.email],['Phone',r.customer?.phone],
    ['Date',d.date],['Time',d.time],['Service',r.service],['Occasion',r.occasion],
    ['Passengers',r.passengers],['Pickup',r.pickup],['Drop-off',r.dropoff],
    ['Estimated total',`$${Number(r.total || 0).toFixed(2)}`],['Deposit',`$${Number(r.deposit || 0).toFixed(2)}`]
  ];
  return `<div style="font-family:Arial,sans-serif;color:#171717;max-width:640px;margin:auto"><div style="background:#111;color:#e8bd58;padding:22px 26px"><h1 style="margin:0;font-size:22px">BK Exclusivez</h1></div><div style="padding:24px;border:1px solid #e5e5e5"><h2 style="margin-top:0">${emailEscape(title)}</h2><p>${emailEscape(intro)}</p><table style="width:100%;border-collapse:collapse">${rows.map(([k,v])=>`<tr><td style="padding:9px;border-bottom:1px solid #eee;color:#666;width:36%">${emailEscape(k)}</td><td style="padding:9px;border-bottom:1px solid #eee;font-weight:bold">${emailEscape(v || 'Not provided')}</td></tr>`).join('')}</table><h3>Additional stops</h3>${d.stopsHtml}${extraHtml}<p style="margin-top:26px;color:#777;font-size:12px">BK Exclusivez · Tri-State Area</p></div></div>`;
}
async function sendEmail({to, subject, html, text}) {
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured; email notification skipped:', subject);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:RESEND_FROM_EMAIL,to:Array.isArray(to)?to:[to],subject,html,text:text || subject})
    });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) {
      console.error('Resend email failed:',res.status,data);
      return false;
    }
    console.log('Resend email sent:',data.id,subject);
    return true;
  } catch (error) {
    console.error('Resend request error:',error);
    return false;
  }
}
async function notifyAdmin(title, intro, record, extraHtml = '') {
  return sendEmail({
    to:BK_NOTIFICATION_EMAIL,
    subject:`BK Exclusivez — ${title}`,
    html:reservationEmailHtml(title,intro,record,extraHtml),
    text:`${title}\\n${intro}\\n${JSON.stringify(record,null,2)}`
  });
}

function cookieValue(event, name) {
  const cookies = String(event.headers?.cookie || event.headers?.Cookie || '').split(';');
  const item = cookies.map(x=>x.trim()).find(x=>x.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length+1)) : '';
}
function sign(value) { return crypto.createHmac('sha256', ADMIN_SESSION_SECRET || 'missing-session-secret').update(value).digest('base64url'); }
function sessionUser(event) {
  const token = cookieValue(event,'bk_admin_session');
  if (!token || !ADMIN_SESSION_SECRET) return null;
  const [payload,signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a=Buffer.from(signature), b=Buffer.from(expected);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  try { const data=JSON.parse(Buffer.from(payload,'base64url').toString()); return data.exp>Date.now() ? data.username : null; } catch { return null; }
}
function setCookie(token) {
  return `bk_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=28800`;
}
function requireAdmin(event) { return sessionUser(event); }
async function squareWebhook(event) {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const signature = event.headers?.['x-square-hmacsha256-signature'] || event.headers?.['X-Square-Hmacsha256-Signature'];
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY || !SQUARE_WEBHOOK_URL) return {statusCode:500,body:'Webhook configuration error.'};
  const expected = crypto.createHmac('sha256',SQUARE_WEBHOOK_SIGNATURE_KEY).update(SQUARE_WEBHOOK_URL+rawBody).digest('base64');
  const a=Buffer.from(signature || ''), b=Buffer.from(expected);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) return {statusCode:403,body:'Invalid signature.'};
  try {
    const eventData=JSON.parse(rawBody);
    console.log('Square webhook received:',eventData.type);
    if (eventData.type==='payment.updated') {
      const payment=eventData?.data?.object?.payment;
      if (payment?.status==='COMPLETED' && payment?.order_id) {
        const reservation=await getBySquareOrder(payment.order_id);
        if (reservation) {
          await updateRecord(reservation.id,{status:'confirmed',expiresAt:null,squarePaymentId:payment.id,paidAt:new Date().toISOString()});
          const paidExtra = `<p style="font-size:18px;font-weight:bold;color:#167a43">Deposit payment received — your reservation is confirmed.</p>`;
          if (reservation.customer?.email) await sendEmail({to:reservation.customer.email,subject:'BK Exclusivez deposit received — reservation confirmed',html:reservationEmailHtml('Your reservation is confirmed','We received your $100 deposit. Thank you for booking with BK Exclusivez.',reservation,paidExtra),text:'Your BK Exclusivez deposit was received and your reservation is confirmed.'});
          await notifyAdmin('Deposit paid — reservation confirmed','Square reports that the customer completed the $100 reservation deposit.',reservation,`<p>Square payment ID: ${emailEscape(payment.id)}</p>`);
          console.log(`Reservation ${reservation.id} marked as PAID.`);
        } else {
          console.error(`No reservation found for Square order ${payment.order_id}.`);
        }
      }
    }
    return {statusCode:200,body:'OK'};
  } catch(error) {
    console.error('Square webhook error:',error);
    return {statusCode:500,body:'Webhook processing failed.'};
  }
}
exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  const url = new URL(event.rawUrl || `https://netlify.local${event.path}`, 'https://netlify.local');
  let pathname = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api');
  if (!pathname.startsWith('/api/')) pathname = `/api${pathname === '/' ? '' : pathname}`;
  try {
    if (method === 'OPTIONS') return {statusCode:204,headers:{'Access-Control-Allow-Origin':event.headers?.origin || '*','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'},body:''};
    if (method==='GET' && pathname==='/api/health') return response(200,{ok:true});
    if (method==='POST' && pathname==='/api/square-webhook') return await squareWebhook(event);

    if (method==='GET' && pathname==='/api/availability') {
      const rows=await cleanupExpired(), date=url.searchParams.get('date');
      if (!validDate(date)) return fail(400,'Invalid date.');
      const dayStart=new Date(`${date}T00:00:00`), dayEnd=new Date(`${date}T23:59:59.999`);
      const reservations=rows.filter(busy).filter(r=>new Date(r.startAt)<dayEnd && new Date(r.endAt)>dayStart)
        .map(r=>({startAt:r.startAt,endAt:r.endAt,status:r.status}));
      return response(200,{date,reservations});
    }
    if (method==='GET' && pathname==='/api/month-availability') {
      const rows=await cleanupExpired(), month=url.searchParams.get('month');
      if (!/^\d{4}-\d{2}$/.test(month || '')) return fail(400,'Invalid month.');
      const [y,m]=month.split('-').map(Number), monthStart=new Date(y,m-1,1), monthEnd=new Date(y,m,1);
      const reservations=rows.filter(busy).filter(r=>new Date(r.startAt)<monthEnd && new Date(r.endAt)>monthStart)
        .map(r=>({startAt:r.startAt,endAt:r.endAt,status:r.status}));
      return response(200,{month,reservations});
    }
    if (method==='POST' && pathname==='/api/hold') {
      const b=parseBody(event), validation=validateBooking(b);
      if (validation) return fail(400,validation);
      const rows=await cleanupExpired();
      const start=localDateTime(b.date,minutesFromTime(b.start_time)), end=localDateTime(b.date,Number(b.end_minutes));
      if (rows.filter(busy).some(r=>overlaps(start.getTime(),end.getTime(),new Date(r.startAt).getTime(),new Date(r.endAt).getTime())))
        return response(409,{error:'That time is no longer available. Please choose another time.'});
      // Customer requests are pending until the owner approves them. No deposit is charged here.
      const record=makeRecord(b,'pending');
      record.expiresAt=null;
      await insertRecord(record);
      await notifyAdmin('New reservation request', 'A new Black Truck reservation is waiting for your review in the admin menu.', record);
      return response(201,{ok:true,reservationId:record.id,status:'pending'});
    }
    if (method==='POST' && pathname==='/api/airport-quote') {
      const b=parseBody(event);
      if (!validEmail(b.email)) return fail(400,'Please enter a valid email address so we can send quote updates.');
      if (!validDate(b.date)||!b.start_time||!b.end_time) return fail(400,'Please provide a valid date and time.');
      const start=minutesFromTime(b.start_time),end=Number(b.end_minutes);
      if (start===null||!Number.isFinite(end)||end<=start) return fail(400,'Invalid quote time.');
      const record=makeRecord({...b,total:0},'quote');record.deposit=0;record.service='Airport Pickup / Drop-Off — Price Upon Inquiry';
      await insertRecord(record);
      await notifyAdmin('New airport quote inquiry', 'A customer submitted an airport transportation quote request. Please contact them with pricing.', record);
      return response(201,{ok:true,requestId:record.id});
    }

    if (method==='POST' && pathname==='/api/admin/login') {
      const b=parseBody(event);
      if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) return fail(500,'Admin credentials are not configured on the server.');
      if (String(b.username||'')!==ADMIN_USERNAME || String(b.password||'')!==ADMIN_PASSWORD) return fail(401,'Incorrect admin username or password.');
      const payload=Buffer.from(JSON.stringify({username:ADMIN_USERNAME,exp:Date.now()+8*60*60*1000})).toString('base64url');
      const token=`${payload}.${sign(payload)}`;
      return response(200,{ok:true,username:ADMIN_USERNAME},{'Set-Cookie':setCookie(token)});
    }
    if (method==='POST' && pathname==='/api/admin/logout') return response(200,{ok:true},{'Set-Cookie':'bk_admin_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0'});
    if (method==='GET' && pathname==='/api/admin/me') {
      const username=sessionUser(event);
      return username ? response(200,{ok:true,username}) : fail(401,'Not logged in.');
    }
    if (pathname.startsWith('/api/admin/')) {
      if (!requireAdmin(event)) return fail(401,'Admin login required.');
      if (method==='GET' && pathname==='/api/admin/bookings') {
        const rows=await cleanupExpired();
        return response(200,{bookings:rows.sort((a,b)=>new Date(a.startAt)-new Date(b.startAt))});
      }
      if (method==='POST' && pathname==='/api/admin/block') {
        const b=parseBody(event);
        if (!validDate(b.date)||!b.start_time||!Number.isFinite(Number(b.end_minutes))) return fail(400,'Invalid block time.');
        const start=minutesFromTime(b.start_time),end=Number(b.end_minutes);
        if (start===null||end<=start||end-start<30) return fail(400,'Invalid block duration.');
        const startAt=localDateTime(b.date,start),endAt=localDateTime(b.date,end);
        const rows=(await cleanupExpired()).filter(busy);
        if (rows.some(r=>overlaps(startAt.getTime(),endAt.getTime(),new Date(r.startAt).getTime(),new Date(r.endAt).getTime()))) return fail(409,'That time is already booked or blocked.');
        const record={id:crypto.randomUUID(),status:'blocked',createdAt:new Date().toISOString(),expiresAt:null,startAt:startAt.toISOString(),endAt:endAt.toISOString(),customer:{name:'',phone:''},occasion:'Admin blocked time',service:'Unavailable / Admin Block',total:0,deposit:0,passengers:0,pickup:b.note||'',stops:[],dropoff:'',addons:{},adminNote:b.note||''};
        await insertRecord(record);
        return response(201,{ok:true,booking:record});
      }
      const approveMatch=pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/approve$/);
      if (approveMatch && method==='POST') {
        const id=decodeURIComponent(approveMatch[1]);
        const record=await getById(id);
        if (!record) return fail(404,'Booking not found.');
        if (record.status!=='pending') return fail(400,'Only pending Black Truck booking requests can be approved here.');
        const rows=(await cleanupExpired()).filter(r=>r.id!==id && busy(r));
        if (rows.some(r=>overlaps(new Date(record.startAt).getTime(),new Date(record.endAt).getTime(),new Date(r.startAt).getTime(),new Date(r.endAt).getTime())))
          return fail(409,'This time now conflicts with another confirmed booking or blocked time.');
        const link=await createSquarePaymentLink(record);
        const updated=await updateRecord(id,{status:'awaiting_payment',expiresAt:null,squarePaymentLinkId:link.id,squareOrderId:link.order_id,squarePaymentUrl:link.url});
        if (record.customer?.email) {
          const paymentHtml = `<p style="margin:20px 0"><a href="${emailEscape(link.url)}" style="display:inline-block;background:#d7a934;color:#111;padding:14px 22px;text-decoration:none;font-weight:bold;border-radius:4px">Pay $100 Reservation Deposit</a></p><p>Your reservation is approved. Your booking is secured once the $100 deposit payment is completed.</p>`;
          await sendEmail({to:record.customer.email,subject:'Your BK Exclusivez reservation has been approved',html:reservationEmailHtml('Your reservation is approved','Please use the secure Square link below to pay your $100 deposit.',record,paymentHtml),text:`Your BK Exclusivez reservation is approved. Pay your $100 deposit here: ${link.url}`});
        }
        return response(200,{ok:true,booking:updated,paymentUrl:link.url});
      }
      const match=pathname.match(/^\/api\/admin\/bookings\/([^/]+)$/);
      if (match && (method==='PATCH'||method==='DELETE')) {
        const id=decodeURIComponent(match[1]), record=await getById(id);
        if (!record) return fail(404,'Booking not found.');
        if (method==='DELETE') { await deleteRecord(id); return response(200,{ok:true}); }
        const b=parseBody(event),allowed=['quote','pending','awaiting_payment','confirmed','cancelled','hold','blocked'];
        if (!allowed.includes(b.status)) return fail(400,'Invalid status.');
        const updated=await updateRecord(id,{status:b.status,expiresAt:b.status==='hold'?record.expiresAt:null,adminNote:b.adminNote!==undefined?String(b.adminNote):record.adminNote});
        if (record.status==='pending' && b.status==='cancelled' && record.customer?.email) {
          await sendEmail({to:record.customer.email,subject:'Update on your BK Exclusivez reservation request',html:reservationEmailHtml('Reservation request update','Unfortunately, we are unable to approve this reservation request. Please contact BK Exclusivez if you would like help finding another time.',record),text:'Unfortunately, we are unable to approve this reservation request. Please contact BK Exclusivez if you would like help finding another time.'});
        }
        return response(200,{ok:true,booking:updated});
      }
    }
    return fail(404,'Not found.');
  } catch (error) {
    console.error('API error:',error);
    return response(500,{error:'Server error. Please try again.'});
  }
};
