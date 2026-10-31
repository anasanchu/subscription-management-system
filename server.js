'use strict';

// SUBSCRIPT local-first application server. Requires Node 22.5+ (node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5000);
const DB_PATH = process.env.SUBSCRIPT_DB || path.join(ROOT, 'subscript.db');
const DB = new DatabaseSync(DB_PATH);
const sessions = new Map();
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };

DB.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','STAFF','CUSTOMER')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'Service', price REAL NOT NULL CHECK(price>=0), cost REAL DEFAULT 0, description TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS variants(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), attribute TEXT NOT NULL, value TEXT NOT NULL, extra REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, name TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id), price REAL NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')), min_qty INTEGER DEFAULT 1, starts TEXT, ends TEXT, allow_close INTEGER DEFAULT 1, allow_pause INTEGER DEFAULT 1, allow_renew INTEGER DEFAULT 1, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES users(id), plan_id INTEGER NOT NULL REFERENCES plans(id), status TEXT NOT NULL DEFAULT 'Active', quantity INTEGER NOT NULL DEFAULT 1, unit_price REAL NOT NULL, start_date TEXT NOT NULL, expiry TEXT, next_bill TEXT NOT NULL, paused_from TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS discounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('percent','fixed')), amount REAL NOT NULL, min_total REAL DEFAULT 0, min_qty INTEGER DEFAULT 1, starts TEXT, ends TEXT, max_uses INTEGER, uses INTEGER DEFAULT 0, product_id INTEGER REFERENCES products(id), active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS taxes(id INTEGER PRIMARY KEY, name TEXT NOT NULL, rate REAL NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES users(id), subscription_id INTEGER NOT NULL REFERENCES subscriptions(id), period TEXT NOT NULL, issued TEXT NOT NULL, due TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Unpaid', UNIQUE(subscription_id,period));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, invoice_id INTEGER NOT NULL REFERENCES invoices(id), customer_id INTEGER NOT NULL REFERENCES users(id), amount REAL NOT NULL, method TEXT NOT NULL, paid_at TEXT NOT NULL, note TEXT DEFAULT '', status TEXT DEFAULT 'Recorded');
CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES users(id), plan_id INTEGER NOT NULL REFERENCES plans(id), quantity INTEGER NOT NULL, total REAL NOT NULL, status TEXT DEFAULT 'Quotation', valid_until TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_sub_status_due ON subscriptions(status,next_bill);
CREATE INDEX IF NOT EXISTS idx_inv_customer_due ON invoices(customer_id,due,status);
CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);`);

const stmt = (sql) => DB.prepare(sql);
const all = (sql, ...args) => stmt(sql).all(...args);
const one = (sql, ...args) => stmt(sql).get(...args) || null;
const run = (sql, ...args) => stmt(sql).run(...args);
const today = () => new Date().toISOString().slice(0,10);
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const reference = (prefix) => `${prefix}-${today().replaceAll('-','').slice(2)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
function passwordHash(password, salt=crypto.randomBytes(16).toString('hex')) {
  return `${salt}$${crypto.pbkdf2Sync(password,salt,240000,32,'sha256').toString('hex')}`;
}
function passwordValid(password) {
  return password.length > 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[^A-Za-z0-9]/.test(password);
}
function passwordMatches(password, stored) {
  const [salt, expected] = stored.split('$');
  const actual = crypto.pbkdf2Sync(password,salt,240000,32,'sha256');
  const target = Buffer.from(expected,'hex');
  return actual.length === target.length && crypto.timingSafeEqual(actual,target);
}
function addPeriod(date, frequency) {
  const d = new Date(`${date}T00:00:00.000Z`);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate()+1);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate()+7);
  else if (frequency === 'monthly' || frequency === 'yearly') {
    const day=d.getUTCDate(), month=d.getUTCMonth(), year=d.getUTCFullYear();
    d.setUTCDate(1);
    if(frequency==='monthly')d.setUTCMonth(month+1);else d.setUTCFullYear(year+1);
    const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(day,last));
  }
  return d.toISOString().slice(0,10);
}
function log(actor,action,detail) { run('INSERT INTO activity(actor,action,detail) VALUES(?,?,?)',actor||'System',action,detail); }

function seed() {
  if(one('SELECT id FROM users LIMIT 1'))return;
  const past=new Date(Date.now()-45*86400000).toISOString().slice(0,10);
  const future=new Date(Date.now()+120*86400000).toISOString().slice(0,10);
  const users=[['Ava Morgan','admin@subscript.demo','AdminDemo!2026','ADMIN'],['Noah Patel','staff@subscript.demo','StaffDemo!2026','STAFF'],['Mia Chen','mia@example.demo','CustomerDemo!2026','CUSTOMER'],['Leo Martin','leo@example.demo','CustomerDemo!2026','CUSTOMER'],['Sofia Roy','sofia@example.demo','CustomerDemo!2026','CUSTOMER']];
  for(const [name,email,password,role] of users)run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',name,email,passwordHash(password),role);
  const customers=all("SELECT id FROM users WHERE role='CUSTOMER'").map(x=>x.id);
  for(const p of [['CloudDesk Pro','Software',1290,420,'Workspace automation suite'],['LedgerFlow','Software',890,260,'Finance operations toolkit'],['Odoo Connector','Integration',560,180,'Odoo brand connector add-on']])run('INSERT INTO products(name,kind,price,cost,description) VALUES(?,?,?,?,?)',...p);
  const products=all('SELECT id FROM products').map(x=>x.id);
  run('INSERT INTO variants(product_id,attribute,value,extra) VALUES(?,?,?,?)',products[0],'Brand','Odoo',560);
  for(const p of [['CloudDesk Monthly',products[0],1290,'monthly'],['CloudDesk Annual',products[0],12900,'yearly'],['LedgerFlow Monthly',products[1],890,'monthly']])run('INSERT INTO plans(name,product_id,price,frequency) VALUES(?,?,?,?)',...p);
  const plans=all('SELECT id FROM plans').map(x=>x.id);
  run('INSERT INTO taxes(name,rate) VALUES(?,?)','GST',18);
  run('INSERT INTO discounts(name,kind,amount,min_total,min_qty,starts,ends,max_uses,product_id) VALUES(?,?,?,?,?,?,?,?,?)','Welcome 10','percent',10,1000,1,past,future,100,products[0]);
  run('INSERT INTO discounts(name,kind,amount,starts,ends,active) VALUES(?,?,?,?,?,0)','Expired launch offer','fixed',500,past,past);
  for(const [idx,customer,plan,status] of [[0,customers[0],plans[0],'Active'],[1,customers[1],plans[1],'Active'],[2,customers[2],plans[2],'Closed']]){
    const start=past, next=addPeriod(start,'monthly'), expiry=addPeriod(start,'yearly');
    const price=idx===0?1290:idx===1?12900:890;
    run('INSERT INTO subscriptions(ref,customer_id,plan_id,status,quantity,unit_price,start_date,expiry,next_bill) VALUES(?,?,?,?,?,?,?,?,?)',reference('SUB'),customer,plan,status,1,price,start,expiry,next);
  }
}
seed();

function send(res,status,data,headers={}) {
  const isBuffer=Buffer.isBuffer(data),body=typeof data==='string'||isBuffer?data:JSON.stringify(data);
  res.writeHead(status,{'Content-Type':typeof data==='string'?'text/html; charset=utf-8':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff',...headers});res.end(body);
}
function cookieMap(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));}
function currentUser(req){const id=cookieMap(req).subscript_session;return id?sessions.get(id)||null:null;}
function guard(user,roles=[]){if(!user)return {status:401,message:'Sign in required'};if(roles.length&&!roles.includes(user.role))return {status:403,message:'Permission denied'};return null;}
function parseBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',chunk=>{data+=chunk;if(data.length>1_000_000){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function customerOwn(user,id){return user.role!=='CUSTOMER'||Number(id)===user.id;}
function listItems(entity,q='',limit=25,offset=0,user=null){
  const like=`%${q}%`;
  if(user?.role==='CUSTOMER'){
    if(entity==='subscriptions')return all('SELECT s.*,p.name plan FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE customer_id=? ORDER BY id DESC LIMIT ? OFFSET ?',user.id,limit,offset);
    if(entity==='invoices')return all('SELECT * FROM invoices WHERE customer_id=? ORDER BY issued DESC LIMIT ? OFFSET ?',user.id,limit,offset);
    if(entity==='payments')return all('SELECT * FROM payments WHERE customer_id=? ORDER BY paid_at DESC LIMIT ? OFFSET ?',user.id,limit,offset);
    if(entity==='discounts')return all("SELECT name,kind,amount,ends FROM discounts WHERE active=1 AND (ends IS NULL OR ends>=date('now'))");
    return null;
  }
  const queries={
    products:['SELECT p.*,(SELECT COUNT(*) FROM variants v WHERE v.product_id=p.id) variants FROM products p WHERE p.name LIKE ? ORDER BY p.id DESC LIMIT ? OFFSET ?',[like,limit,offset]],
    plans:['SELECT p.*,x.name product FROM plans p JOIN products x ON x.id=p.product_id WHERE p.name LIKE ? ORDER BY p.id DESC LIMIT ? OFFSET ?',[like,limit,offset]],
    customers:["SELECT id,name,email,created_at FROM users WHERE role='CUSTOMER' AND (name LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?",[like,like,limit,offset]],
    subscriptions:['SELECT s.*,u.name customer,p.name plan FROM subscriptions s JOIN users u ON u.id=s.customer_id JOIN plans p ON p.id=s.plan_id WHERE (?=\'\' OR u.name LIKE ? OR s.ref LIKE ?) ORDER BY s.id DESC LIMIT ? OFFSET ?',[q,like,like,limit,offset]],
    invoices:['SELECT i.*,u.name customer FROM invoices i JOIN users u ON u.id=i.customer_id WHERE (?=\'\' OR u.name LIKE ? OR i.number LIKE ?) ORDER BY i.issued DESC LIMIT ? OFFSET ?',[q,like,like,limit,offset]],
    payments:['SELECT p.*,u.name customer,i.number invoice FROM payments p JOIN users u ON u.id=p.customer_id JOIN invoices i ON i.id=p.invoice_id ORDER BY p.paid_at DESC LIMIT ? OFFSET ?',[limit,offset]],
    quotes:['SELECT q.*,u.name customer,p.name plan FROM quotes q JOIN users u ON u.id=q.customer_id JOIN plans p ON p.id=q.plan_id ORDER BY q.id DESC LIMIT ? OFFSET ?',[limit,offset]],
    discounts:['SELECT * FROM discounts ORDER BY id DESC LIMIT ? OFFSET ?',[limit,offset]], taxes:['SELECT * FROM taxes ORDER BY id',[]]
  };
  const query=queries[entity];return query?all(query[0],...query[1]):null;
}
function dashboard(user){
  if(user.role==='CUSTOMER')return {customer:true,subscriptions:all('SELECT s.*,p.name plan FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE customer_id=? ORDER BY id DESC',user.id),invoices:all('SELECT * FROM invoices WHERE customer_id=? ORDER BY issued DESC LIMIT 8',user.id),payments:all('SELECT * FROM payments WHERE customer_id=? ORDER BY paid_at DESC LIMIT 8',user.id)};
  const d=one(`SELECT
    (SELECT COUNT(*) FROM users WHERE role='CUSTOMER') customers,
    (SELECT COUNT(*) FROM subscriptions WHERE status='Active') active,
    (SELECT COUNT(*) FROM subscriptions WHERE status='Active' AND created_at>=date('now','-30 day')) new_subscriptions,
    (SELECT COUNT(*) FROM subscriptions WHERE status='Active' AND next_bill<=date('now','+30 day')) renewals,
    (SELECT COALESCE(SUM(CASE p.frequency WHEN 'monthly' THEN s.unit_price*s.quantity WHEN 'yearly' THEN s.unit_price*s.quantity/12.0 WHEN 'weekly' THEN s.unit_price*s.quantity*4.345 ELSE s.unit_price*s.quantity*30 END),0) FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='Active') mrr,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='Recorded') collected,
    (SELECT COALESCE(SUM(i.total-COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id=i.id),0)),0) FROM invoices i WHERE i.status IN ('Unpaid','Partially paid','Overdue')) outstanding,
    (SELECT COUNT(*) FROM invoices i WHERE i.status='Overdue' OR (i.status IN ('Unpaid','Partially paid') AND i.due<date('now'))) overdue`);
  return {...d,arr:round(d.mrr*12),invoices:all('SELECT i.*,u.name customer FROM invoices i JOIN users u ON u.id=i.customer_id ORDER BY issued DESC LIMIT 8'),renewals:all("SELECT s.ref,s.next_bill,u.name customer,p.name plan FROM subscriptions s JOIN users u ON u.id=s.customer_id JOIN plans p ON p.id=s.plan_id WHERE s.status='Active' ORDER BY next_bill LIMIT 6"),trend:all('SELECT substr(issued,1,7) month,round(sum(total),2) invoiced FROM invoices GROUP BY month ORDER BY month DESC LIMIT 6'),activity:all('SELECT * FROM activity ORDER BY id DESC LIMIT 8')};
}
function invoiceHTML(i){
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(i.number)}</title><style>body{font:15px Arial;color:#18233b;max-width:760px;margin:50px auto;padding:20px}.head{display:flex;justify-content:space-between;border-bottom:2px solid #6654d9;padding-bottom:20px}h1{color:#6654d9}table{width:100%;margin:40px 0;border-collapse:collapse}td{padding:12px;border-bottom:1px solid #ddd}.right{text-align:right}.total{font-size:22px;font-weight:bold}@media print{button{display:none}}</style><button onclick="print()">Print / Save PDF</button><div class="head"><div><h1>SUBSCRIPT</h1>Subscription Operations Platform</div><div><h2>INVOICE</h2>${esc(i.number)}<br>Issued ${esc(i.issued)}<br>Due ${esc(i.due)}</div></div><h3>Bill to</h3>${esc(i.customer)} · ${esc(i.email)}<table><tr><td>Subscription billing period</td><td>${esc(i.period)}</td><td class="right">${esc(i.subtotal)}</td></tr><tr><td>Tax</td><td></td><td class="right">${esc(i.tax)}</td></tr><tr><td>Discount</td><td></td><td class="right">−${esc(i.discount)}</td></tr><tr class="total"><td>Total payable</td><td></td><td class="right">INR ${esc(i.total)}</td></tr></table><p>Status: ${esc(i.status)}</p><p>Thank you for your business.</p>`;
}

async function handle(req,res){
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`), pathName=url.pathname, method=req.method;
  if(method==='GET'&&pathName==='/'){return send(res,200,fs.readFileSync(path.join(ROOT,'public','index.html'),'utf8'));}
  if(method==='GET'&&pathName.startsWith('/public/')){
    const f=path.resolve(ROOT,pathName.slice(1));if(!f.startsWith(path.join(ROOT,'public')+path.sep))return send(res,403,{error:'Forbidden'});
    try{return send(res,200,fs.readFileSync(f),{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});}catch{return send(res,404,{error:'Not found'});}
  }
  const user=currentUser(req);
  if(method==='POST'&&pathName==='/api/login'){
    const p=await parseBody(req),u=one('SELECT * FROM users WHERE lower(email)=lower(?)',String(p.email||''));
    if(!u||!passwordMatches(String(p.password||''),u.password))return send(res,401,{error:'Email or password is incorrect'});
    const id=crypto.randomBytes(32).toString('hex');sessions.set(id,{id:u.id,name:u.name,role:u.role});
    return send(res,200,{id:u.id,name:u.name,role:u.role},{'Set-Cookie':`subscript_session=${id}; HttpOnly; SameSite=Lax; Path=/`});
  }
  if(method==='POST'&&pathName==='/api/logout'){
    const sid=cookieMap(req).subscript_session;if(sid)sessions.delete(sid);
    return send(res,200,{ok:true},{'Set-Cookie':'subscript_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  if(method==='GET'&&pathName==='/api/me')return user?send(res,200,{user:{uid:user.id,name:user.name,role:user.role}}):send(res,401,{user:null});
  if(method==='POST'&&pathName==='/api/register'){
    const p=await parseBody(req),password=String(p.password||'');if(!passwordValid(password))return send(res,400,{error:'Use 9+ characters with uppercase, lowercase and a special character.'});
    try{run("INSERT INTO users(name,email,password,role) VALUES(?,?,?,'CUSTOMER')",String(p.name||'').trim(),String(p.email||'').trim().toLowerCase(),passwordHash(password));return send(res,200,{ok:true});}
    catch(e){return send(res,409,{error:'That email is already registered.'});}
  }
  if(method==='GET'&&pathName==='/api/dashboard'){
    const fail=guard(user);if(fail)return send(res,fail.status,{error:fail.message});return send(res,200,dashboard(user));
  }
  let match;
  if(method==='GET'&&(match=pathName.match(/^\/api\/([^/]+)$/))){
    const fail=guard(user);if(fail)return send(res,fail.status,{error:fail.message});
    const entity=match[1],page=Math.max(1,Number(url.searchParams.get('page')||1)),q=(url.searchParams.get('q')||'').trim();
    const items=listItems(entity,q,25,(page-1)*25,user);if(!items)return send(res,403,{error:'Unknown section or access denied'});return send(res,200,{items});
  }
  if(method==='POST'&&(match=pathName.match(/^\/api\/([^/]+)$/))){
    const fail=guard(user,['ADMIN','STAFF']);if(fail)return send(res,fail.status,{error:fail.message});
    const entity=match[1],p=await parseBody(req);let id;
    try{
      if(entity==='products'){
        const r=run('INSERT INTO products(name,kind,price,cost,description) VALUES(?,?,?,?,?)',p.name,p.kind||'Service',Number(p.price),Number(p.cost||0),p.description||'');id=Number(r.lastInsertRowid);
        for(const v of p.variants||[])run('INSERT INTO variants(product_id,attribute,value,extra) VALUES(?,?,?,?)',id,v.attribute||'Brand',v.value,Number(v.extra||0));
      } else if(entity==='plans'){
        const r=run('INSERT INTO plans(name,product_id,price,frequency,min_qty,starts,ends,allow_close,allow_pause,allow_renew) VALUES(?,?,?,?,?,?,?,?,?,?)',p.name,Number(p.product_id),Number(p.price),p.frequency,Number(p.min_qty||1),p.starts||null,p.ends||null,p.allow_close??1,p.allow_pause??1,p.allow_renew??1);id=Number(r.lastInsertRowid);
      } else if(entity==='customers'||entity==='staff'){
        if(entity==='staff'&&user.role!=='ADMIN')return send(res,403,{error:'Admins only'});
        if(!passwordValid(String(p.password||'')))return send(res,400,{error:'Password must be 9+ characters with upper, lower and special characters'});
        const role=entity==='staff'?'STAFF':'CUSTOMER';const r=run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',p.name,String(p.email).toLowerCase(),passwordHash(p.password),role);id=Number(r.lastInsertRowid);
      } else if(entity==='discounts'){
        if(user.role!=='ADMIN')return send(res,403,{error:'Admins only'});
        const r=run('INSERT INTO discounts(name,kind,amount,min_total,min_qty,starts,ends,max_uses,product_id) VALUES(?,?,?,?,?,?,?,?,?)',p.name,p.kind,Number(p.amount),Number(p.min_total||0),Number(p.min_qty||1),p.starts||null,p.ends||null,p.max_uses?Number(p.max_uses):null,p.product_id?Number(p.product_id):null);id=Number(r.lastInsertRowid);
      } else if(entity==='taxes'){
        if(user.role!=='ADMIN')return send(res,403,{error:'Admins only'});const r=run('INSERT INTO taxes(name,rate) VALUES(?,?)',p.name,Number(p.rate));id=Number(r.lastInsertRowid);
      } else if(entity==='quotes'||entity==='subscriptions'){
        const plan=one('SELECT * FROM plans WHERE id=? AND active=1',Number(p.plan_id)),qty=Number(p.quantity||1),customerId=Number(p.customer_id);
        if(!plan||qty<plan.min_qty)return send(res,400,{error:'Select a live plan and meet its minimum quantity'});
        if(!customerOwn(user,customerId))return send(res,403,{error:'You may only create records for your own account'});
        if(entity==='quotes'){
          const r=run('INSERT INTO quotes(ref,customer_id,plan_id,quantity,total,valid_until) VALUES(?,?,?,?,?,?)',reference('QUO'),customerId,plan.id,qty,plan.price*qty,addDays(today(),Number(p.valid_days||14)));id=Number(r.lastInsertRowid);
        } else {
          const start=p.start_date||today(),next=addPeriod(start,plan.frequency),expiry=p.expiry||plan.ends||addPeriod(start,'yearly');
          const r=run("INSERT INTO subscriptions(ref,customer_id,plan_id,status,quantity,unit_price,start_date,expiry,next_bill) VALUES(?,?,?,'Active',?,?,?,?,?)",reference('SUB'),customerId,plan.id,qty,plan.price,start,expiry,next);id=Number(r.lastInsertRowid);
        }
      } else return send(res,404,{error:'Unsupported operation'});
      log(user.name,'Created',entity.replace(/s$/,''));return send(res,200,{ok:true,id});
    }catch(e){return send(res,400,{error:`Could not save record: ${e.message}`});}
  }
  if(method==='POST'&&(match=pathName.match(/^\/api\/quotes\/(\d+)\/confirm$/))){
    const fail=guard(user,['ADMIN','STAFF']);if(fail)return send(res,fail.status,{error:fail.message});
    const q=one("SELECT * FROM quotes WHERE id=? AND status='Quotation'",Number(match[1]));if(!q)return send(res,400,{error:'Quotation is no longer available'});
    const plan=one('SELECT * FROM plans WHERE id=?',q.plan_id),start=today();DB.exec('BEGIN IMMEDIATE');
    try{run("UPDATE quotes SET status='Confirmed' WHERE id=?",q.id);run("INSERT INTO subscriptions(ref,customer_id,plan_id,status,quantity,unit_price,start_date,expiry,next_bill) VALUES(?,?,?,'Active',?,?,?,?,?)",reference('SUB'),q.customer_id,q.plan_id,q.quantity,plan.price,start,addPeriod(start,'yearly'),addPeriod(start,plan.frequency));DB.exec('COMMIT');log(user.name,'Confirmed quotation',q.ref);return send(res,200,{ok:true});}
    catch(e){DB.exec('ROLLBACK');throw e;}
  }
  if(method==='POST'&&(match=pathName.match(/^\/api\/subscriptions\/(\d+)\/(pause|resume|close|renew)$/))){
    const s=one('SELECT s.*,p.frequency,p.allow_close,p.allow_pause,p.allow_renew FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?',Number(match[1]));if(!s||!customerOwn(user,s.customer_id))return send(res,404,{error:'Record not found'});
    const action=match[2];
    if(action==='pause'&&s.allow_pause&&s.status==='Active')run("UPDATE subscriptions SET status='Paused',paused_from=? WHERE id=?",today(),s.id);
    else if(action==='resume'&&s.status==='Paused'){const days=Math.max(0,Math.floor((Date.parse(today())-Date.parse(s.paused_from||today()))/86400000));run("UPDATE subscriptions SET status='Active',next_bill=date(next_bill,?),paused_from=NULL WHERE id=?",`+${days} day`,s.id);}
    else if(action==='close'&&s.allow_close&&['Active','Paused'].includes(s.status))run("UPDATE subscriptions SET status='Closed' WHERE id=?",s.id);
    else if(action==='renew'&&s.allow_renew&&['Active','Closed'].includes(s.status)){const next=addPeriod(s.next_bill>today()?s.next_bill:today(),s.frequency);run("UPDATE subscriptions SET status='Active',next_bill=?,expiry=? WHERE id=?",next,addPeriod(next,'yearly'),s.id);}
    else return send(res,400,{error:'This action is not allowed for the current plan or status'});
    log(user.name,action[0].toUpperCase()+action.slice(1)+' subscription',s.ref);return send(res,200,{ok:true});
  }
  if(method==='POST'&&pathName==='/api/billing/process'){
    const fail=guard(user,['ADMIN','STAFF']);if(fail)return send(res,fail.status,{error:fail.message});
    const subs=all("SELECT s.*,p.frequency FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='Active' AND s.next_bill<=? AND (s.expiry IS NULL OR s.next_bill<=s.expiry) ORDER BY s.next_bill",today());let created=0,duplicates=0;
    DB.exec('BEGIN IMMEDIATE');try{
      for(const s of subs){const period=s.next_bill,subtotal=round(s.unit_price*s.quantity),discountRule=one("SELECT * FROM discounts WHERE active=1 AND (starts IS NULL OR starts<=?) AND (ends IS NULL OR ends>=?) AND (max_uses IS NULL OR uses<max_uses) AND min_total<=? AND min_qty<=? AND (product_id IS NULL OR product_id=(SELECT product_id FROM plans WHERE id=?)) ORDER BY id LIMIT 1",today(),today(),subtotal,s.quantity,s.plan_id);
        const discount=discountRule?round(Math.min(subtotal,discountRule.kind==='percent'?subtotal*discountRule.amount/100:discountRule.amount)):0;
        if(discountRule)run('UPDATE discounts SET uses=uses+1 WHERE id=?',discountRule.id);
        const taxrate=one('SELECT COALESCE(SUM(rate),0) rate FROM taxes WHERE active=1').rate,tax=round((subtotal-discount)*taxrate/100),total=round(subtotal-discount+tax);
        try{run("INSERT INTO invoices(number,customer_id,subscription_id,period,issued,due,subtotal,tax,discount,total,status) VALUES(?,?,?,?,?,?,?,?,?,?, 'Unpaid')",reference('INV'),s.customer_id,s.id,period,today(),addDays(today(),14),subtotal,tax,discount,total);created++;}catch(e){if(String(e.message).includes('UNIQUE'))duplicates++;else throw e;}
        const next=addPeriod(period,s.frequency),status=s.expiry&&next>s.expiry?'Closed':'Active';run('UPDATE subscriptions SET next_bill=?,status=? WHERE id=?',next,status,s.id);
      }
      DB.exec('COMMIT');log(user.name,'Billing run',`Created ${created} invoices; ${duplicates} periods already processed`);return send(res,200,{created,duplicates,checked:subs.length});
    }catch(e){DB.exec('ROLLBACK');throw e;}
  }
  if(method==='POST'&&(match=pathName.match(/^\/api\/invoices\/(\d+)\/pay$/))){
    const i=one('SELECT * FROM invoices WHERE id=?',Number(match[1]));if(!i||!customerOwn(user,i.customer_id))return send(res,404,{error:'Invoice not found'});
    const p=await parseBody(req);if(user.role==='CUSTOMER'&&p.simulation!==true)return send(res,400,{error:'Payment simulations must be explicitly labelled'});
    const amount=Number(p.amount??i.total),paid=one('SELECT COALESCE(SUM(amount),0) value FROM payments WHERE invoice_id=?',i.id).value;
    if(amount<=0||amount>i.total-paid+0.005)return send(res,400,{error:'Payment must be greater than zero and no more than the balance'});
    DB.exec('BEGIN IMMEDIATE');try{run('INSERT INTO payments(ref,invoice_id,customer_id,amount,method,paid_at,note) VALUES(?,?,?,?,?,?,?)',reference('PAY'),i.id,i.customer_id,amount,p.method||'Manual',p.paid_at||today(),p.simulation?`SIMULATED · ${p.note||''}`:(p.note||''));const balance=round(i.total-paid-amount);run('UPDATE invoices SET status=? WHERE id=?',balance<=0.005?'Paid':'Partially paid',i.id);DB.exec('COMMIT');log(user.name,'Payment recorded',`Invoice ${i.number}: ${amount.toFixed(2)}`);return send(res,200,{ok:true,balance:Math.max(0,balance)});}catch(e){DB.exec('ROLLBACK');throw e;}
  }
  if(method==='GET'&&(match=pathName.match(/^\/api\/invoices\/(\d+)\/print$/))){
    const i=one('SELECT i.*,u.name customer,u.email FROM invoices i JOIN users u ON u.id=i.customer_id WHERE i.id=?',Number(match[1]));if(!i||!customerOwn(user,i.customer_id))return send(res,404,'Not found');return send(res,200,invoiceHTML(i));
  }
  if(method==='POST'&&(match=pathName.match(/^\/api\/records\/(products|plans|invoices)\/(\d+)\/(archive|cancel)$/))){
    const fail=guard(user,['ADMIN','STAFF']);if(fail)return send(res,fail.status,{error:fail.message});const [,entity,rid,action]=match;
    if(action==='cancel'&&entity!=='invoices')return send(res,400,{error:'Unsupported action'});if(action==='archive'&&entity==='invoices')return send(res,400,{error:'Unsupported action'});
    run(entity==='invoices'?'UPDATE invoices SET status=? WHERE id=?':'UPDATE '+entity+' SET active=0 WHERE id=?',...(entity==='invoices'?['Cancelled',Number(rid)]:[Number(rid)]));log(user.name,action,`${entity} #${rid}`);return send(res,200,{ok:true});
  }
  return send(res,404,{error:'Not found'});
}
function addDays(date,days){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}

const server=http.createServer((req,res)=>{handle(req,res).catch(err=>{console.error(err);if(!res.headersSent)send(res,500,{error:'Unexpected server error'});else res.end();});});
server.listen(PORT,'127.0.0.1',()=>console.log(`SUBSCRIPT running at http://127.0.0.1:${PORT}`));
process.on('SIGINT',()=>{server.close(()=>{DB.close();process.exit(0);});});
