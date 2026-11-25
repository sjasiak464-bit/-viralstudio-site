const http = require('http');
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
  if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, {ok:true, service:'ViralStudio API', features:['business-search','github-pages-publishing']});
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const category = clean(url.searchParams.get('category')), city = clean(url.searchParams.get('city'));
    if (!category || !city) return send(res, 400, {error:'Catégorie et ville obligatoires.'});
    try { const results = await search(category, city); return send(res, 200, {results,count:results.length,source:'OpenStreetMap',note:'Les fiches peuvent être incomplètes. Vérifie chaque entreprise et son site avant de la contacter.'}); }
    catch (e) { return send(res, 502, {error:e.message || 'Recherche impossible.'}); }
  }
  if (url.pathname === '/api/publish' && req.method === 'POST') return publishSite(req,res);
  return send(res, 404, {error:'Not found'});
}).listen(PORT, '0.0.0.0', () => console.log('ViralStudio API ready on port ' + PORT));
