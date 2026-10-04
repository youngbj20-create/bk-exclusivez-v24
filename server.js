process.env.TZ = 'America/New_York';

const http = require('http');

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_API_URL = 'https://connect.squareupsandbox.com/v2/online-checkout/payment-links';
const SQUARE_API_VERSION = '2026-09-16';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'reservations.json');
const HOLD_MINUTES = 15;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BKExclusivez!2026';
const sessions = new Map();
const loginAttempts = new Map();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readReservations() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function writeReservations(rows) { fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2)); }
function cleanupExpired() {
  const now = Date.now();
  const rows = readReservations();
  const kept = rows.filter(r => r.status !== 'hold' || new Date(r.expiresAt).getTime() > now);
  if (kept.length !== rows.length) writeReservations(kept);
  return kept;
}
function json(res, status, body, extraHeaders={}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'same-origin', ...extraHeaders });
  res.end(data);
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime()); }
function minutesFromTime(s) {
  const m = /^([0-9]{1,2}):([0-9]{2})\s*(AM|PM)$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
function localDateTime(date, minutes) { const d = new Date(`${date}T00:00:00`); d.setMinutes(minutes); return d; }
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }
function reservationBusy(row) { return row.status === 'confirmed' || row.status === 'blocked' || (row.status === 'hold' && new Date(row.expiresAt).getTime() > Date.now()); }
function validateBooking(b) {
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
function intervalsForDate(rows, date) {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = new Date(`${date}T23:59:59.999`).getTime();
  return rows.filter(reservationBusy).filter(r => {
    const s = new Date(r.startAt).getTime(), e = new Date(r.endAt).getTime();
    return s < dayEnd && e > dayStart;
  }).map(r => ({ startAt: r.startAt, endAt: r.endAt, status: r.status }));
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => { const i=part.indexOf('='); if(i>0) out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim()); });
  return out;
}
function adminSession(req) {
  const token = parseCookies(req).bk_admin_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (session) sessions.delete(token); return null; }
  return session;
}
function requireAdmin(req, res) {
  const session = adminSession(req);
  if (!session) { json(res, 401, { error: 'Admin login required.' }); return null; }
  return session;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `bk_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}`);
}
function clearSessionCookie(res) { res.setHeader('Set-Cookie', 'bk_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function safeRecord(r) { const copy={...r}; return copy; }
function recordFromBooking(b, status='hold') {
  const startMinutes = minutesFromTime(b.start_time), endMinutes = Number(b.end_minutes);
  const startAt = localDateTime(b.date, startMinutes), endAt = localDateTime(b.date, endMinutes);
  return {
    id: crypto.randomUUID(), status, createdAt: new Date().toISOString(), expiresAt: status==='hold' ? new Date(Date.now()+HOLD_MINUTES*60000).toISOString() : null,
    startAt:startAt.toISOString(), endAt:endAt.toISOString(), customer:{name:b.name||'',phone:b.phone||''},
    occasion:b.occasion||'', service:b.service||'', total:Number(b.total||0), deposit:100, passengers:Number(b.passengers||1),
    pickup:b.pickup||'', stops:Array.isArray(b.stops)?b.stops:[], dropoff:b.dropoff||'', addons:b.addons||{}
  };
}
async function createSquarePaymentLink(reservation) {
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
    throw new Error('Square credentials are not configured.');
  }

  const response = await fetch(SQUARE_API_URL, {
    method: 'POST',
    headers: {
      'Square-Version': SQUARE_API_VERSION,
      'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: 'BK Exclusivez Reservation Deposit',
        price_money: {
          amount: 10000,
          currency: 'USD'
        },
        location_id: SQUARE_LOCATION_ID
      },
      description: `BK Exclusivez reservation deposit - ${reservation.id}`,
      payment_note: `Reservation ID: ${reservation.id}`
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Square API error:', data);
    throw new Error(
      data?.errors?.[0]?.detail || 'Unable to create Square payment link.'
    );
  }

  return data.payment_link;
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
  file = path.normalize(file);
  if (file.startsWith('..') || path.isAbsolute(file)) return json(res, 403, { error: 'Forbidden' });
  const full = path.join(ROOT, file);
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(full).toLowerCase();
    const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.mov':'video/quicktime', '.mp4':'video/mp4', '.svg':'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': `${types[ext] || 'application/octet-stream'}; charset=utf-8` });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'same-origin','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/api/availability') {
      const rows=cleanupExpired(), date=url.searchParams.get('date');
      if (!validDate(date)) return json(res,400,{error:'Invalid date.'});
      return json(res,200,{date,reservations:intervalsForDate(rows,date)});
    }
    if (req.method === 'GET' && pathname === '/api/month-availability') {
      const rows=cleanupExpired(), month=url.searchParams.get('month');
      if(!/^\d{4}-\d{2}$/.test(month)) return json(res,400,{error:'Invalid month.'});
      const [y,m]=month.split('-').map(Number), monthStart=new Date(y,m-1,1).getTime(), monthEnd=new Date(y,m,1).getTime();
      const reservations=rows.filter(reservationBusy).filter(r=>{const s=new Date(r.startAt).getTime(),e=new Date(r.endAt).getTime();return s<monthEnd&&e>monthStart}).map(r=>({startAt:r.startAt,endAt:r.endAt,status:r.status}));
      return json(res,200,{month,reservations});
    }
    if (req.method === 'POST' && pathname === '/api/create-payment-link') {
  const b = await parseBody(req);

  if (!b.reservationId) {
    return json(res, 400, {
      error: 'Reservation ID is required.'
    });
  }

  cleanupExpired();

  const rows = readReservations();
  const reservation = rows.find(r => r.id === String(b.reservationId));

  if (!reservation) {
    return json(res, 404, {
      error: 'Reservation not found or hold expired.'
    });
  }

  if (reservation.status !== 'hold') {
    return json(res, 400, {
      error: 'This reservation is no longer available for payment.'
    });
  }

  if (
    reservation.expiresAt &&
    new Date(reservation.expiresAt).getTime() <= Date.now()
  ) {
    return json(res, 410, {
      error: 'Your reservation hold has expired. Please start again.'
    });
  }

  try {
    const paymentLink = await createSquarePaymentLink(reservation);

    reservation.squarePaymentLinkId = paymentLink.id;
    reservation.squareOrderId = paymentLink.order_id;

    writeReservations(rows);

    return json(res, 200, {
      ok: true,
      reservationId: reservation.id,
      paymentUrl: paymentLink.url,
      paymentLinkId: paymentLink.id
    });

  } catch (error) {
    console.error('Square payment link error:', error);

    return json(res, 502, {
      error: 'Unable to connect to Square. Please try again.'
    });
  }
}
    if (req.method === 'POST' && pathname === '/api/airport-quote') {
      const b=await parseBody(req);
      if(!validDate(b.date)||!b.start_time||!b.end_time)return json(res,400,{error:'Please provide a valid date and time.'});
      const start=minutesFromTime(b.start_time),end=Number(b.end_minutes); if(start===null||!Number.isFinite(end)||end<=start)return json(res,400,{error:'Invalid quote time.'});
      const record=recordFromBooking({...b,total:0},'quote'); record.deposit=0; record.service='Airport Pickup / Drop-Off — Price Upon Inquiry';
      const all=readReservations();all.push(record);writeReservations(all);
      return json(res,201,{ok:true,requestId:record.id});
    }
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const ip=req.socket.remoteAddress||'unknown', now=Date.now(), attempts=loginAttempts.get(ip)||{count:0,until:0};
      if(attempts.until>now)return json(res,429,{error:'Too many login attempts. Please wait a few minutes.'});
      const b=await parseBody(req);
      if(String(b.username||'')!==ADMIN_USERNAME || String(b.password||'')!==ADMIN_PASSWORD){attempts.count++; if(attempts.count>=5){attempts.until=now+5*60*1000;attempts.count=0;} loginAttempts.set(ip,attempts); return json(res,401,{error:'Incorrect admin username or password.'});}
      loginAttempts.delete(ip); const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,{createdAt:now,expiresAt:now+8*60*60*1000,username:ADMIN_USERNAME}); setSessionCookie(res,token); return json(res,200,{ok:true,username:ADMIN_USERNAME});
    }
    if (req.method === 'POST' && pathname === '/api/admin/logout') { const token=parseCookies(req).bk_admin_session; if(token)sessions.delete(token); clearSessionCookie(res); return json(res,200,{ok:true}); }
    if (req.method === 'GET' && pathname === '/api/admin/me') { const s=adminSession(req); return json(res,s?200:401,s?{ok:true,username:s.username}:{error:'Not logged in.'}); }
    if (pathname.startsWith('/api/admin/')) {
      const s=requireAdmin(req,res); if(!s)return;
      if(req.method==='GET'&&pathname==='/api/admin/bookings'){
        const rows=cleanupExpired().sort((a,b)=>new Date(a.startAt)-new Date(b.startAt)); return json(res,200,{bookings:rows.map(safeRecord)});
      }
      if(req.method==='POST'&&pathname==='/api/admin/block'){
        const b=await parseBody(req); if(!validDate(b.date)||!b.start_time||!Number.isFinite(Number(b.end_minutes)))return json(res,400,{error:'Invalid block time.'});
        const start=minutesFromTime(b.start_time),end=Number(b.end_minutes); if(start===null||end<=start||end-start<30)return json(res,400,{error:'Invalid block duration.'});
        const startAt=localDateTime(b.date,start),endAt=localDateTime(b.date,end); const rows=cleanupExpired().filter(reservationBusy); if(rows.some(r=>overlaps(startAt.getTime(),endAt.getTime(),new Date(r.startAt).getTime(),new Date(r.endAt).getTime())))return json(res,409,{error:'That time is already booked or blocked.'});
        const record={id:crypto.randomUUID(),status:'blocked',createdAt:new Date().toISOString(),expiresAt:null,startAt:startAt.toISOString(),endAt:endAt.toISOString(),customer:{name:'',phone:''},occasion:'Admin blocked time',service:'Unavailable / Admin Block',total:0,deposit:0,passengers:0,pickup:b.note||'',stops:[],dropoff:'',addons:{},adminNote:b.note||''}; const all=readReservations();all.push(record);writeReservations(all);return json(res,201,{ok:true,booking:record});
      }
      const idMatch=pathname.match(/^\/api\/admin\/bookings\/([^/]+)$/);
      if(idMatch&&(req.method==='PATCH'||req.method==='DELETE')){
        const id=idMatch[1], rows=cleanupExpired(), idx=rows.findIndex(r=>r.id===id); if(idx<0)return json(res,404,{error:'Booking not found.'});
        if(req.method==='DELETE'){rows.splice(idx,1);writeReservations(rows);return json(res,200,{ok:true});}
        const b=await parseBody(req), allowed=['quote','confirmed','cancelled','hold','blocked']; if(!allowed.includes(b.status))return json(res,400,{error:'Invalid status.'}); rows[idx].status=b.status; if(b.status!=='hold')rows[idx].expiresAt=null; if(b.adminNote!==undefined)rows[idx].adminNote=String(b.adminNote); writeReservations(rows);return json(res,200,{ok:true,booking:rows[idx]});
      }
      return json(res,404,{error:'Admin endpoint not found.'});
    }
    return serveStatic(req,res,pathname);
  } catch(err){ console.error(err); return json(res,500,{error:'Server error.'}); }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`BK Exclusivez website running on port ${PORT}`));
