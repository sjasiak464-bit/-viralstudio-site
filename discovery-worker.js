const { Pool } = require('pg');
const pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const cities = (process.env.SEARCH_CITIES || 'Montreal,Laval,Longueuil,Sainte-Martine,Chateauguay,Valleyfield,Quebec').split(',').map(x=>x.trim()).filter(Boolean);
const groups = [
 {name:'restaurant',tags:['restaurant','cafe','fast_food','food_court','bar']},
 {name:'coiffeur',tags:['hairdresser','beauty']},
 {name:'garage',tags:['car_repair','car','tyres']},
 {name:'plombier',tags:['plumber']},
 {name:'electricien',tags:['electrician']},
 {name:'construction',tags:['builder','construction','carpenter','painter','roofer']}
];
async function discover(city, group) {
 const geo=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(city+', Quebec, Canada'),{headers:{'User-Agent':'ViralStudioAI/1.0'}});
 if(!geo.ok) throw new Error('Nominatim '+geo.status);
 const places=await geo.json(); if(!places.length)return [];
 const p=places[0],bbox=[p.boundingbox[0],p.boundingbox[2],p.boundingbox[1],p.boundingbox[3]].join(',');
 const q='[out:json][timeout:25];(nwr[name][shop]('+bbox+');nwr[name][office]('+bbox+');nwr[name][craft]('+bbox+');nwr[name][amenity]('+bbox+'););out center tags 250;';
 const res=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'data='+encodeURIComponent(q)});
 if(!res.ok)throw new Error('Overpass '+res.status);
 const data=await res.json();
 return data.elements.map(e=>{const t=e.tags||{};return {name:t.name||'',type:t.shop||t.office||t.craft||t.amenity||'',website:t.website||t['contact:website']||'',email:t.email||t['contact:email']||'',phone:t.phone||t['contact:phone']||'',address:[t['addr:housenumber'],t['addr:street'],t['addr:city']||city].filter(Boolean).join(' ')};})
 .filter(x=>x.name&&group.tags.includes(x.type)&&!x.website);
}
(async()=>{
 await pool.query("CREATE TABLE IF NOT EXISTS leads (id BIGSERIAL PRIMARY KEY, company TEXT NOT NULL, email TEXT DEFAULT '', website TEXT DEFAULT '', kind TEXT DEFAULT '', amount NUMERIC(12,2) DEFAULT 0, notes TEXT DEFAULT '', status TEXT DEFAULT 'À contacter', updated_at TIMESTAMPTZ DEFAULT NOW())");
 let added=0;
 for(const city of cities) for(const group of groups){
  try{
   const rows=await discover(city,group);
   for(const p of rows){
    const exists=await pool.query('SELECT id FROM leads WHERE lower(company)=lower($1) LIMIT 1',[p.name]);
    if(exists.rowCount)continue;
    await pool.query('INSERT INTO leads(company,email,website,kind,amount,notes,status) VALUES($1,$2,$3,$4,0,$5,$6)',[p.name,p.email,p.website,p.type,'Trouvé via OpenStreetMap à '+city+'. Site web non répertorié dans cette fiche : vérification manuelle obligatoire avant toute offre. Téléphone: '+p.phone+'. Adresse: '+p.address,'À contacter']);
    added++;
   }
  }catch(e){console.error('Search failed',city,group.name,e.message)}
 }
 console.log('ViralStudio discovery completed. New leads:',added);
 await pool.end();
})().catch(async e=>{console.error(e);await pool.end();process.exit(1)});
