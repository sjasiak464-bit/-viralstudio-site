const { Pool } = require('pg');
const pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const runId = process.env.VIRALSTUDIO_RUN_ID || null;
const cities = (process.env.SEARCH_CITIES || 'Montreal,Laval,Longueuil,Sainte-Martine,Chateauguay,Valleyfield,Quebec').split(',').map(x=>x.trim()).filter(Boolean);
const groups = [
 {name:'restaurant',filter:'["amenity"~"^(restaurant|cafe|fast_food|food_court|bar)$"]'},
 {name:'coiffeur',filter:'["shop"~"^(hairdresser|beauty)$"]'},
 {name:'garage',filter:'["shop"~"^(car_repair|car|tyres|motorcycle)$"]'},
 {name:'plombier',filter:'["craft"="plumber"]'},
 {name:'electricien',filter:'["craft"="electrician"]'},
 {name:'construction',filter:'["craft"~"^(builder|carpenter|painter|roofer)$"],nwr["office"="construction"]'}
];
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function discover(city, group) {
 const geo=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(city+', Quebec, Canada'),{headers:{'User-Agent':'ViralStudioAI/1.1 business discovery'}});
 if(!geo.ok) throw new Error('Géolocalisation HTTP '+geo.status);
 const places=await geo.json(); if(!places.length)return [];
 const p=places[0],bbox=[p.boundingbox[0],p.boundingbox[2],p.boundingbox[1],p.boundingbox[3]].join(',');
 const clauses=group.filter.split(',nwr').map((part,i)=>'nwr'+part+'('+bbox+');').join('');
 const query='[out:json][timeout:35];('+clauses+');out center tags 500;';
 const res=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'ViralStudioAI/1.1'},body:'data='+encodeURIComponent(query)});
 if(!res.ok) throw new Error('OpenStreetMap HTTP '+res.status);
 const data=await res.json();
 return data.elements.map(e=>{
  const t=e.tags||{};
  return {name:t.name||'',type:t.shop||t.office||t.craft||t.amenity||'',website:t.website||t['contact:website']||'',email:t.email||t['contact:email']||'',phone:t.phone||t['contact:phone']||'',address:[t['addr:housenumber'],t['addr:street'],t['addr:city']||city].filter(Boolean).join(' ')};
 }).filter(x=>x.name&&!x.website);
}
(async()=>{
 let added=0,errors=0,completed=0;
 await pool.query("CREATE TABLE IF NOT EXISTS leads (id BIGSERIAL PRIMARY KEY, company TEXT NOT NULL, email TEXT DEFAULT '', website TEXT DEFAULT '', kind TEXT DEFAULT '', amount NUMERIC(12,2) DEFAULT 0, notes TEXT DEFAULT '', status TEXT DEFAULT 'À contacter', updated_at TIMESTAMPTZ DEFAULT NOW())");
 if(runId) await pool.query("CREATE TABLE IF NOT EXISTS discovery_runs (id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'running',started_at TIMESTAMPTZ DEFAULT NOW(),finished_at TIMESTAMPTZ,added INTEGER DEFAULT 0,errors INTEGER DEFAULT 0,message TEXT DEFAULT '')");
 for(const city of cities) {
  for(const group of groups) {
   try {
    const rows=await discover(city,group);
    for(const p of rows) {
     const exists=await pool.query('SELECT id FROM leads WHERE lower(company)=lower($1) LIMIT 1',[p.name]);
     if(exists.rowCount) continue;
     await pool.query('INSERT INTO leads(company,email,website,kind,amount,notes,status) VALUES($1,$2,$3,$4,0,$5,$6)',[
      p.name,p.email,p.website,p.type,
      'Source OpenStreetMap, secteur '+city+'. Aucun site web indiqué dans cette fiche — cela ne confirme pas l’absence de site. Vérification manuelle obligatoire avant toute offre. Téléphone: '+p.phone+'. Adresse: '+p.address,
      'À vérifier'
     ]);
     added++;
    }
   } catch(e) { errors++; console.error('Recherche échouée',city,group.name,e.message); }
   completed++;
   if(runId) await pool.query("UPDATE discovery_runs SET added=$2,errors=$3,message=$4 WHERE id=$1",[runId,added,errors,'Progression: '+completed+'/'+(cities.length*groups.length)+' recherches']);
   await wait(1100);
  }
 }
 if(runId) await pool.query("UPDATE discovery_runs SET status=$2,finished_at=NOW(),added=$3,errors=$4,message=$5 WHERE id=$1",[runId,errors===cities.length*groups.length?'failed':'completed',added,errors,'Recherche terminée. Chaque prospect doit être vérifié manuellement.']);
 console.log('ViralStudio discovery completed. New leads:',added,'Errors:',errors);
 await pool.end();
})().catch(async e=>{
 console.error(e);
 if(runId) await pool.query("UPDATE discovery_runs SET status='failed',finished_at=NOW(),message=$2 WHERE id=$1",[runId,String(e.message).slice(0,500)]).catch(()=>{});
 await pool.end();process.exit(1);
});