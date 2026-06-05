const cheerio = require('cheerio');

async function testSearch(query) {
  const url = `https://tw.linovelib.com/search.html`;
  console.log("Fetching POST:", url);
  const res = await fetch(url, { 
    method: 'POST',
    headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
    body: `searchkey=${encodeURIComponent(query)}&searchtype=all`
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  
  console.log("Response starts with:", html.substring(0, 300));
  let items = 0;
  $(".book-li, .book-ol .book-li, .rank-book-list .book-layout").each((_, el) => {
    const title = $(el).find("h4.book-title, .book-title").text().trim();
    if (title) {
       console.log("Title:", title);
       console.log("Author:", $(el).find(".book-author, .book-meta span").first().text().trim());
       items++;
    }
  });
  console.log("Total found:", items);
}

testSearch("無職轉生");
testSearch("長月達平");
