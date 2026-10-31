const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscript-node-test-'));
const database = path.join(dir, 'test.sqlite');
let child, base;

test('authenticated page boot retains the app root and renders the dashboard', async () => {
  const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
  const scriptStart=html.indexOf('<script>')+8,scriptEnd=html.indexOf('</script>',scriptStart);
  const appRoot={innerHTML:''},view={innerHTML:''};
  const dashboard={customer:false,customers:2,active:1,new_subscriptions:1,renewals:0,mrr:1290,arr:15480,collected:0,outstanding:0,overdue:0,invoices:[],renewals:[],trend:[],activity:[]};
  const context=vm.createContext({
    document:{querySelector(selector){return selector==='#app'?appRoot:view;}},
    fetch:async url=>({ok:true,status:200,json:async()=>String(url).endsWith('/api/me')?{user:{uid:1,name:'Admin',role:'ADMIN'}}:dashboard}),
    Intl,Date,Number,Math,String,Object,Array,encodeURIComponent,setTimeout,clearTimeout,console
  });
  vm.runInContext(html.slice(scriptStart,scriptEnd).replace(/\nboot\(\);\s*$/,''),context);
  await context.boot();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(appRoot.innerHTML.includes('class="shell"'));
  assert.ok(view.innerHTML.includes('Welcome back, Admin.'));
  assert.ok(view.innerHTML.includes('Expected monthly income from active subscriptions.'));
});

test('sign-in screen adds the branded journey panel and keeps its form', async () => {
  const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
  const scriptStart=html.indexOf('<script>')+8,scriptEnd=html.indexOf('</script>',scriptStart);
  const appRoot={innerHTML:''},form={};
  let storyMarkup='';
  const layout={querySelector(){return null;},insertAdjacentHTML(_position,markup){storyMarkup=markup;}};
  const context=vm.createContext({
    document:{querySelector(selector){return selector==='#app'?appRoot:selector==='.login'?layout:selector==='#login'?form:null;}},
    fetch:async()=>({ok:false,status:401,json:async()=>({})}),
    Intl,Date,Number,Math,String,Object,Array,encodeURIComponent,setTimeout,clearTimeout,console
  });
  vm.runInContext(html.slice(scriptStart,scriptEnd).replace(/\nboot\(\);\s*$/,''),context);
  await context.boot();
  assert.ok(storyMarkup.includes('Every renewal'));
  assert.ok(storyMarkup.includes('Quote accepted'));
  assert.equal(typeof form.onsubmit,'function');
});

async function start() {
  const port = 18000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), SUBSCRIPT_DB: database }
  });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try { if ((await fetch(base)).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Server did not start in time');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
}
async function request(route, { method='GET', body, cookie }={}) {
  const response = await fetch(base + route, {
    method, headers: { ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(cookie ? {Cookie:cookie} : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('Node application supports core workflows, access boundaries, and SQLite persistence', async t => {
  await start();
  t.after(async () => { await stop(); fs.rmSync(dir,{recursive:true,force:true}); });

  const home=await request('/');
  assert.equal(home.response.status, 200);
  assert.ok(home.data.startsWith('<!doctype html>'));
  assert.ok(home.data.includes('<style>'));
  assert.ok(!home.data.includes('fonts.googleapis.com'));
  const css=await request('/public/design.css');
  assert.equal(css.response.status,200);
  assert.ok(css.data.includes('.login-story'));
  assert.ok(css.data.includes('.journey-step'));
  assert.ok(css.data.includes('@media(max-width:700px)'));
  assert.ok(css.data.includes('prefers-reduced-motion'));
  const scriptStart=home.data.indexOf('<script>')+8,scriptEnd=home.data.indexOf('</script>',scriptStart);
  assert.doesNotThrow(()=>new vm.Script(home.data.slice(scriptStart,scriptEnd)));
  assert.equal((await request('/api/login',{method:'POST',body:{email:'admin@subscript.demo',password:'wrong'}})).response.status,401);
  const adminLogin=await request('/api/login',{method:'POST',body:{email:'admin@subscript.demo',password:'AdminDemo!2026'}});
  assert.equal(adminLogin.response.status,200);
  const admin=adminLogin.cookie;

  const dashboard=await request('/api/dashboard',{cookie:admin});
  assert.equal(dashboard.response.status,200);
  assert.equal(dashboard.data.customers,3);
  const billing=await request('/api/billing/process',{method:'POST',body:{},cookie:admin});
  assert.equal(billing.response.status,200);
  assert.ok(billing.data.created>=1);
  assert.equal((await request('/api/billing/process',{method:'POST',body:{},cookie:admin})).data.created,0);

  assert.equal((await request('/api/register',{method:'POST',body:{name:'Weak Password',email:'weak@example.demo',password:'weak'}})).response.status,400);
  const registration={name:'New Customer',email:'new@example.demo',password:'StrongPass!2026'};
  assert.equal((await request('/api/register',{method:'POST',body:registration})).response.status,200);
  assert.equal((await request('/api/register',{method:'POST',body:registration})).response.status,409);

  const customers=(await request('/api/customers',{cookie:admin})).data.items;
  const miaId=customers.find(x=>x.email==='mia@example.demo').id;
  const plans=(await request('/api/plans',{cookie:admin})).data.items;
  const quotation=await request('/api/quotes',{method:'POST',cookie:admin,body:{customer_id:customers[0].id,plan_id:plans[0].id,quantity:1}});
  assert.equal(quotation.response.status,200);
  assert.equal((await request(`/api/quotes/${quotation.data.id}/confirm`,{method:'POST',cookie:admin})).response.status,200);
  const subs=(await request('/api/subscriptions',{cookie:admin})).data.items;
  const sub=subs.find(x=>x.customer_id===customers[0].id&&x.plan_id===plans[0].id);
  assert.ok(sub);
  assert.equal((await request(`/api/subscriptions/${sub.id}/pause`,{method:'POST',cookie:admin})).response.status,200);
  assert.equal((await request(`/api/subscriptions/${sub.id}/resume`,{method:'POST',cookie:admin})).response.status,200);
  assert.equal((await request(`/api/subscriptions/${sub.id}/close`,{method:'POST',cookie:admin})).response.status,200);

  const invoices=(await request('/api/invoices',{cookie:admin})).data.items;
  const invoice=invoices[0];
  assert.equal((await request(`/api/invoices/${invoice.id}/pay`,{method:'POST',cookie:admin,body:{amount:invoice.total,method:'Bank transfer'}})).response.status,200);
  const customerLogin=await request('/api/login',{method:'POST',body:{email:'mia@example.demo',password:'CustomerDemo!2026'}});
  const customer=customerLogin.cookie;
  const ownInvoices=(await request('/api/invoices',{cookie:customer})).data.items;
  assert.ok(ownInvoices.every(x=>x.customer_id===miaId));
  const otherInvoice=invoices.find(x=>x.customer_id!==miaId);
  assert.ok(otherInvoice);
  assert.equal((await request(`/api/invoices/${otherInvoice.id}/pay`,{method:'POST',cookie:customer,body:{amount:1,simulation:true}})).response.status,404);

  await stop();
  await start();
  const relogin=await request('/api/login',{method:'POST',body:{email:'admin@subscript.demo',password:'AdminDemo!2026'}});
  assert.equal(relogin.response.status,200);
  assert.equal((await request('/api/invoices',{cookie:relogin.cookie})).data.items.length,invoices.length);
});
