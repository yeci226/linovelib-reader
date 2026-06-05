const cheerio = require('cheerio');

async function testFetch() {
  console.log("=== Testing Wenku ===");
  try {
    const url = "https://tw.linovelib.com/wenku/lastupdate_0_0_0_0_0_0_0_1_0.html";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
    const html = await res.text();
    const $ = cheerio.load(html);
    
    let items = 0;
    $(".book-ol .book-li").each((_, el) => {
      const title = $(el).find("h4.book-title, .book-title").text().trim();
      if (title && items < 1) {
         console.log(title);
         console.log($(el).find(".book-meta").html());
      }
      if (title) items++;
    });
    
    let totalPages = 1;
    const lastPageLink = $(".pagelink a.last").attr("href");
    if (lastPageLink) {
      const match = /_(\d+)_0\.html/.exec(lastPageLink);
      if (match) totalPages = parseInt(match[1], 10);
    } else {
      $(".pagelink a").each((_, el) => {
        const text = $(el).text().trim();
        const p = parseInt(text, 10);
        if (!isNaN(p) && p > totalPages) {
          totalPages = p;
        }
      });
    }
    console.log(`Found ${items} books on page 1.`);
    console.log(`Total Pages detected: ${totalPages}`);
    
  } catch (e) {
    console.error("Wenku error:", e.message);
  }

  console.log("\n=== Testing Top ===");
  try {
    const url = "https://tw.linovelib.com/top/monthvisit/1.html";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
    const html = await res.text();
    const $ = cheerio.load(html);
    
    console.log("Top page body excerpt:");
    const bodyText = $("body").html() || "";
    const startIndex = bodyText.indexOf('class="book-');
    if (startIndex !== -1) {
      console.log(bodyText.substring(Math.max(0, startIndex - 50), startIndex + 500));
    } else {
      console.log("No book- classes found!");
    }
    
    let items = 0;
    $(".book-li").each((_, el) => {
      const a = $(el).find("a.book-layout");
      if (!a.length) return;
      const title = $(el).find("h4.book-title, .book-title").text().trim();
      if (title && items < 1) {
         console.log("Top item title:", title);
         console.log($(el).find(".book-cell, .book-meta").html());
      }
      if (title) items++;
    });
    
    let totalPages = 1;
    const lastPageLink = $(".pagelink a.last").attr("href");
    if (lastPageLink) {
      const match = /\/(\d+)\.html/.exec(lastPageLink);
      if (match) totalPages = parseInt(match[1], 10);
    } else {
      $(".pagelink a").each((_, el) => {
        const text = $(el).text().trim();
        const p = parseInt(text, 10);
        if (!isNaN(p) && p > totalPages) {
          totalPages = p;
        }
      });
    }
    console.log(`Found ${items} books on top page 1.`);
    console.log(`Total Pages detected: ${totalPages}`);
    
  } catch (e) {
    console.error("Top error:", e.message);
  }
}

testFetch();
