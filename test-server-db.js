const db = require('better-sqlite3')('data/reader.db'); 
const rows = db.prepare('SELECT data FROM DiscoverCache').all(); 
let uniqueItems = new Map(); 
for(let row of rows) { 
  const p = JSON.parse(row.data); 
  const items = Array.isArray(p) ? p : p.items; 
  if (Array.isArray(items)) { 
    for(let i of items) uniqueItems.set(i.url, i); 
  } 
} 
const allItems = Array.from(uniqueItems.values()); 
console.log('Unique items in DB:', allItems.length);
const q = '傲'.toLowerCase(); 
const scored = allItems.map(item => { 
  const titleMatch = item.title && item.title.toLowerCase().includes(q) ? 1 : 0; 
  const authorMatch = item.author && item.author.toLowerCase().includes(q) ? 1 : 0; 
  const tagMatch = item.tags && item.tags.some(t => t.toLowerCase().includes(q)) ? 1 : 0; 
  let score = 0; 
  if (titleMatch || authorMatch || tagMatch) { score = titleMatch * 3 + authorMatch * 2 + tagMatch * 1; } 
  return { item: item.title, score }; 
}).filter(x => x.score > 0); 
console.log('Matches for 傲:', scored.length);
