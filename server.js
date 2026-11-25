const http = require('http');
const PORT = process.env.PORT || 3000;
const send = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
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
  return group ? group.tags.includes(type) || (normalized.includes('bar') && type === 'bar') : (type + ' ' + item.name).includes(normalized);
}
async function search(category, city) {
  const geo = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(city + ', Quebec, Canada'), {
    headers: { 'User-Agent': 'ViralStudioAI/1.1 (business discovery)' }
  });
  if (!geo.ok) throw new Error('Géolocalisation temporairement indisponible');
  const places = await geo.json();
  if (!places.length) throw new Error('Ville introuvable. Essaie avec le nom complet de la municipalité.');
  const p = places[0];
  const bbox = [p.boundingbox[0], p.boundingbox[2], p.boundingbox[1], p.boundingbox[3]].join(',');
  const q = '[out:json][timeout:30];(nwr[name][shop](' + bbox + ');nwr[name][office](' + bbox + ');nwr[name][craft](' + bbox + ');nwr[name][amenity](' + bbox + '););out center tags 300;';
  const over = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q)
  });
  if (!over.ok) throw new Error('Le service cartographique est occupé. Réessaie dans une minute.');
  const data = await over.json();
  const results = data.elements.map(e => {
    const t = e.tags || {};
    const address = [t['addr:housenumber'], t['addr:street'], t['addr:city'] || city].filter(Boolean).join(' ');
    return {
      name: t.name || '',
      category: t.shop || t.office || t.craft || t.amenity || '',
      address,
      website: t.website || t['contact:website'] || '',
      email: t.email || t['contact:email'] || '',
      phone: t.phone || t['contact:phone'] || ''
    };
  }).filter(item => item.name && matchesCategory(item, category));
  const unique = [...new Map(results.map(item => [item.name.toLowerCase() + '|' + item.address.toLowerCase(), item])).values()];
  return unique.slice(0, 60);
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'ViralStudio API' });
  if (url.pathname === '/api/search') {
    const category = clean(url.searchParams.get('category'));
    const city = clean(url.searchParams.get('city'));
    if (!category || !city) return send(res, 400, { error: 'Catégorie et ville obligatoires.' });
    try {
      const results = await search(category, city);
      return send(res, 200, { results, count: results.length, source: 'OpenStreetMap', note: 'Les fiches peuvent être incomplètes. Vérifie chaque entreprise et son site avant de la contacter.' });
    } catch (error) {
      return send(res, 502, { error: error.message || 'Recherche impossible.' });
    }
  }
  return send(res, 404, { error: 'Not found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log('ViralStudio API ready on port ' + PORT);
});
