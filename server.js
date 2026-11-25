const http = require('http');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}) : null;
let schemaReady;
async function ensureSchema(){if(!pool)throw new Error('Base de données non configurée (DATABASE_URL).');if(!schemaReady)schemaReady=pool.query("CREATE TABLE IF NOT EXISTS leads (id BIGSERIAL PRIMARY KEY, company TEXT NOT NULL, email TEXT DEFAULT '', website TEXT DEFAULT '', kind TEXT DEFAULT '', amount NUMERIC(12,2) DEFAULT 0, notes TEXT DEFAULT '', status TEXT DEFAULT 'À contacter', updated_at TIMESTAMPTZ DEFAULT NOW())").catch(e=>{schemaReady=null;throw e});await schemaReady;}
function requireCrm(req,res){if(!process.env.CRM_API_KEY){send(res,503,{error:'Clé CRM non configurée.'});return false;}if(req.headers['x-viralstudio-key']!==process.env.CRM_API_KEY){send(res,401,{error:'Clé CRM invalide.'});return false;}return true;}
const PORT = process.env.PORT || 3000;
const GITHUB_API = 'https://api.github.com';
const send = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'https://sjasiak464-bit.github.io',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-ViralStudio-Key'
  });
  res.end(JSON.stringify(data));
};
const clean = value => String(value || '').trim().slice(0, 100);
const categoryMap = [
  { keys: ['restaurant','resto','café','cafe','bar','traiteur'], tags: ['restaurant','cafe','fast_food','food_court','bar'] },
  { keys: ['coiffeur','coiffure','salon','barbier'], tags: ['hairdresser','beauty'] },
  { keys: ['garage','mécanique','mecanique','automobile','auto'], tags: ['car_repair','car','tyres','motorcycle'] },
  { keys: ['plombier','plomberie'], tags: ['plumber'] },
  { keys: ['électricien','electricien','électricité','electricite'], tags: ['electrician'] },
  { keys: ['construction','entrepreneur','rénovation','renovation'], tags: ['builder','construction','carpenter','painter','roofer','plasterer'] },
  { keys: ['dentiste','dentaire'], tags: ['dentist','orthodontist'] },
  { keys: ['fleuriste','fleurs'], tags: ['florist'] },
  { keys: ['épicerie','epicerie','dépanneur','depanneur'], tags: ['supermarket','convenience','greengrocer'] }
];
function matchesCategory(item, term) {
  if (!term) return true;
  const normalized = term.toLowerCase();
  const group = categoryMap.find(g => g.keys.some(k => normalized.includes(k)));
  const type = String(item.category || '').toLowerCase();
  return group ? group.tags.includes(type) : (type + ' ' + item.name).includes(normalized);
}
async function search(category, city) {
  const geo = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(city + ', Quebec, Canada'), {
    headers: { 'User-Agent': 'ViralStudioAI/1.2 (business discovery)' }
  });
  if (!geo.ok) throw new Error('Géolocalisation temporairement indisponible');
  const places = await geo.json();
  if (!places.length) throw new Error('Ville introuvable. Essaie avec le nom complet de la municipalité.');
  const p = places[0];
  const bbox = [p.boundingbox[0], p.boundingbox[2], p.boundingbox[1], p.boundingbox[3]].join(',');
  const q = '[out:json][timeout:30];(nwr[name][shop](' + bbox + ');nwr[name][office](' + bbox + ');nwr[name][craft](' + bbox + ');nwr[name][amenity](' + bbox + '););out center tags 300;';
  const over = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q)
  });
  if (!over.ok) throw new Error('Le service cartographique est occupé. Réessaie dans une minute.');
  const data = await over.json();
  const results = data.elements.map(e => {
    const t = e.tags || {};
    const address = [t['addr:housenumber'], t['addr:street'], t['addr:city'] || city].filter(Boolean).join(' ');
    return { name: t.name || '', category: t.shop || t.office || t.craft || t.amenity || '', address, website: t.website || t['contact:website'] || '', email: t.email || t['contact:email'] || '', phone: t.phone || t['contact:phone'] || '' };
  }).filter(item => item.name && matchesCategory(item, category));
  return [...new Map(results.map(item => [item.name.toLowerCase() + '|' + item.address.toLowerCase(), item])).values()].slice(0, 60);
}
function readBody(req, max = 1200000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > max) { reject(new Error('Contenu trop volumineux')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}
async function github(path, token, method = 'GET', body) {
  const response = await fetch(GITHUB_API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type':'application/json'} : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const err = new Error(data.message || 'Erreur GitHub (' + response.status + ')'); err.status = response.status; throw err; }
  return data;
}
const publishTimes = new Map();
async function publishSite(req, res) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.PUBLISH_API_KEY) return send(res, 503, {error:'Publication non configurée. Ajoute GITHUB_TOKEN, GITHUB_OWNER et PUBLISH_API_KEY dans Render.'});
  if (req.headers['x-viralstudio-key'] !== process.env.PUBLISH_API_KEY) return send(res, 401, {error:'Clé de publication invalide.'});
  const ip = req.socket.remoteAddress || 'unknown', now = Date.now(), last = publishTimes.get(ip) || 0;
  if (now - last < 30000) return send(res, 429, {error:'Attends 30 secondes avant une autre publication.'});
  publishTimes.set(ip, now);
  try {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 80);
    const slug = String(body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0, 80);
    const content = String(body.html || '');
    if (!name || !slug || !content.startsWith('<!doctype html>') || content.length > 900000) return send(res, 400, {error:'Nom, identifiant et HTML valide requis (maximum 900 Ko).'});
    const owner = process.env.GITHUB_OWNER;
    let repo;
    try { repo = await github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(slug), process.env.GITHUB_TOKEN); }
    catch (e) {
      if (e.status !== 404) throw e;
      repo = await github('/user/repos', process.env.GITHUB_TOKEN, 'POST', {name:slug, description:'Site web créé par ViralStudio pour ' + name, homepage:'https://' + owner + '.github.io/' + slug + '/', private:false, auto_init:true});
    }
    const existing = await github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(slug) + '/contents/index.html', process.env.GITHUB_TOKEN).catch(e => e.status === 404 ? null : Promise.reject(e));
    await github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(slug) + '/contents/index.html', process.env.GITHUB_TOKEN, 'PUT', {
      message: 'Publish website with ViralStudio',
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(existing ? {sha:existing.sha} : {})
    });
    let pages;
    try { pages = await github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(slug) + '/pages', process.env.GITHUB_TOKEN, 'POST', {source:{branch:'main',path:'/'}}); }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      pages = await github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(slug) + '/pages', process.env.GITHUB_TOKEN);
    }
    return send(res, 200, {ok:true, repository:repo.html_url, url:pages.html_url || 'https://' + owner + '.github.io/' + slug + '/', status:pages.status || 'building', note:'La mise en ligne peut prendre quelques minutes.'});
  } catch (e) {
    return send(res, e.status && e.status < 500 ? e.status : 500, {error:e.message || 'Publication impossible.'});
  }
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'https://sjasiak464-bit.github.io','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-ViralStudio-Key','Vary':'Origin'}); return res.end(); }
  if (url.pathname === '/health' && req.method === 'GET') { let leadCount = null; if (pool) { try { await ensureSchema(); const count = await pool.query('SELECT COUNT(*)::int AS total FROM leads'); leadCount = count.rows[0].total; } catch (e) { return send(res, 503, {ok:false, service:'ViralStudio API', database:true, databaseError:'Lecture de la base impossible.'}); } } return send(res, 200, {ok:true, service:'ViralStudio API', features:['business-search','github-pages-publishing','postgres-crm'], database:!!pool, leadCount}); }
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const category = clean(url.searchParams.get('category')), city = clean(url.searchParams.get('city'));
    if (!category || !city) return send(res, 400, {error:'Catégorie et ville obligatoires.'});
    try { const results = await search(category, city); return send(res, 200, {results,count:results.length,source:'OpenStreetMap',note:'Les fiches peuvent être incomplètes. Vérifie chaque entreprise et son site avant de la contacter.'}); }
    catch (e) { return send(res, 502, {error:e.message || 'Recherche impossible.'}); }
  }

  if (url.pathname === '/api/discover' && req.method === 'POST') { if (!requireCrm(req,res)) return; try { const child=spawn(process.execPath,['discovery-worker.js'],{detached:true,stdio:'ignore',env:process.env}); child.unref(); return send(res,202,{ok:true,message:'Recherche lancée en arrière-plan.'}); } catch(e) { return send(res,500,{error:'Impossible de lancer la recherche.'}); } }
  if (url.pathname.startsWith('/api/leads')) {
    if (!requireCrm(req,res)) return;
    try {
      await ensureSchema();
      if (url.pathname === '/api/leads' && req.method === 'GET') {
        const r = await pool.query('SELECT id,company,email,website,kind,amount,notes,status FROM leads ORDER BY updated_at DESC');
        return send(res,200,{leads:r.rows});
      }
      if (url.pathname === '/api/leads' && req.method === 'POST') {
        const b = await readBody(req,200000);
        if (!Array.isArray(b.leads) || b.leads.length > 2000) return send(res,400,{error:'Liste invalide.'});
        await pool.query('BEGIN');
        try {
          for (const p of b.leads) {
            if (!String(p.company||'').trim()) continue;
            const exists = await pool.query('SELECT id FROM leads WHERE lower(company)=lower($1) AND lower(email)=lower($2) LIMIT 1',[String(p.company),String(p.email||'')]);
            if (exists.rowCount) await pool.query('UPDATE leads SET website=$1,kind=$2,amount=$3,notes=$4,status=$5,updated_at=NOW() WHERE id=$6',[String(p.website||'').slice(0,500),String(p.kind||'').slice(0,120),Math.max(0,Number(p.amount)||0),String(p.notes||'').slice(0,5000),String(p.status||'À contacter').slice(0,80),exists.rows[0].id]); else await pool.query('INSERT INTO leads(company,email,website,kind,amount,notes,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[String(p.company).slice(0,200),String(p.email||'').slice(0,320),String(p.website||'').slice(0,500),String(p.kind||'').slice(0,120),Math.max(0,Number(p.amount)||0),String(p.notes||'').slice(0,5000),String(p.status||'À contacter').slice(0,80)]);
          }
          await pool.query('COMMIT');
        } catch(e) { await pool.query('ROLLBACK'); throw e; }
        return send(res,200,{ok:true});
      }
    } catch(e) { return send(res,500,{error:e.message||'Erreur CRM.'}); }
  }

  if (url.pathname === '/api/publish' && req.method === 'POST') return publishSite(req,res);
  return send(res, 404, {error:'Not found'});
}).listen(PORT, '0.0.0.0', () => console.log('ViralStudio API ready on port ' + PORT));
