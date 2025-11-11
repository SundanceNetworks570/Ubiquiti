/* updates.js — auto-refresh UniFi versions + Ubiquiti news
 * Adds a "Latest Ubiquiti News" section under the updates table.
 * Strategy for news (tries in order, stops at first success):
 *   1) Ubiquiti Community "Blog_UniFi" RSS (if available / public)
 *   2) blog-stories.ui-apps.com (the blog listing backend)
 *   3) blog.ui.com front page HTML (fallback; may be blocked by CORS)
 *
 * Notes:
 * - Serve via a local web server (not file://). Examples:
 *     python3 -m http.server 8000
 *     npx http-server . -p 8000
 */
(function () {
  const FEEDS = {
    "UniFi Network Application (Controller)":
      "https://community.ui.com/rss/releases/UniFi-Network-Application/e6712595-81bb-4829-8e42-9e2630fabcfe",
    "UniFi Protect":
      "https://community.ui.com/rss/releases/UniFi-Protect/aada5f38-35d4-4525-9235-b14bd320e4d0",
    "UniFi OS – Dream Machine (UDM/UDM‑Pro/SE/Pro Max)":
      "https://community.ui.com/rss/releases/UDM%20firmware/b0f0a740-021e-4027-a778-ceba983be74b"
  };

  const NEWS_SOURCES = [
    { type: "rss", url: "https://community.ui.com/ubnt/rss/board?board.id=Blog_UniFi" },
    { type: "html", url: "https://blog-stories.ui-apps.com/" },
    { type: "html", url: "https://blog.ui.com/" },
  ];

  const POLL_EVERY_MS = 24 * 60 * 60 * 1000; // 24 hours

  async function fetchText(url) {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return await resp.text();
  }

  function parseRSSItem(xmlText) {
    const dom = new DOMParser().parseFromString(xmlText, "application/xml");
    const item = dom.querySelector("item");
    if (!item) throw new Error("No <item> in RSS feed");
    const title = item.querySelector("title")?.textContent?.trim() || "";
    const link  = item.querySelector("link")?.textContent?.trim() || "";
    const desc  = item.querySelector("description")?.textContent?.trim() || "";
    const date  = item.querySelector("pubDate")?.textContent?.trim() || "";
    const versionMatch = title.match(/(\d+(?:\.\d+){1,3}(?:[-\w\.]+)?)/);
    const version = versionMatch ? versionMatch[1] : title;
    const tmp = document.createElement("div");
    tmp.innerHTML = desc;
    const clean = tmp.textContent.replace(/\s+/g, " ").trim();
    return { title, version, link, description: clean, date };
  }

  function findRowByProduct(productName) {
    const rows = document.querySelectorAll("table tbody tr");
    for (const tr of rows) {
      const firstCell = tr.querySelector("td");
      if (!firstCell) continue;
      const text = firstCell.textContent.replace(/\s+/g, " ").trim();
      if (text.toLowerCase().includes(productName.toLowerCase())) {
        return tr;
      }
    }
    return null;
  }

  function updateRow(tr, data) {
    if (!tr) return;
    const tds = tr.querySelectorAll("td");
    if (tds[1]) tds[1].textContent = data.version || "—";
    if (tds[2]) tds[2].textContent = data.description || data.title || "—";
    if (tds[3]) {
      const a = tds[3].querySelector("a") || document.createElement("a");
      a.href = data.link || "#";
      a.textContent = data.link ? "Release notes / download" : "—";
      if (!a.parentElement) {
        tds[3].textContent = "";
        tds[3].appendChild(a);
      }
    }
  }

  async function refreshOnce() {
    const statusEl = ensureStatusEl();
    statusEl.textContent = "Refreshing release data…";
    const updates = [];
    for (const [product, url] of Object.entries(FEEDS)) {
      try {
        const xml = await fetchText(url);
        const data = parseRSSItem(xml);
        const row = findRowByProduct(product);
        updateRow(row, data);
        updates.push(`${product}: ${data.version}`);
      } catch (err) {
        console.warn("Failed to refresh for", product, err);
      }
    }
    await refreshNews();
    const ts = new Date().toLocaleString();
    statusEl.textContent = `Last refreshed ${ts}` + (updates.length ? ` — ${updates.join(" | ")}` : "");
  }

  function ensureStatusEl() {
    let el = document.getElementById("refresh-status");
    if (!el) {
      el = document.createElement("p");
      el.id = "refresh-status";
      el.style.marginTop = "0.5rem";
      el.style.color = "#444";
      const header = document.querySelector("h1");
      (header?.parentElement || document.body).insertBefore(el, header?.nextSibling || null);
    }
    return el;
  }

  // NEWS SECTION
  function ensureNewsSection() {
    let section = document.getElementById("ubnt-news");
    if (!section) {
      section = document.createElement("section");
      section.id = "ubnt-news";
      section.innerHTML = `
        <h2 style="margin-top:2rem;">Latest Ubiquiti News</h2>
        <ul id="ubnt-news-list" style="padding-left:1rem; line-height:1.5;"></ul>
        <p id="ubnt-news-source" style="color:#666;font-size:0.9rem;"></p>
      `;
      const table = document.querySelector("table");
      table?.parentElement?.insertBefore(section, table.nextSibling);
    }
    return section;
  }

  function parseNewsFromHtml(html, baseUrl) {
    // Very lightweight parser: find article blocks by looking for common patterns
    const doc = new DOMParser().parseFromString(html, "text/html");
    const candidates = [];
    // blog-stories list
    doc.querySelectorAll("a, article, h3, h2").forEach((el) => {
      const t = el.textContent?.trim();
      const href = el.getAttribute && el.getAttribute("href");
      if (!t || t.length < 8) return;
      // Heuristics: pick items that look like titled posts and link to blog.ui.com/article/*
      const looksLikePost = /Introducing|Releasing|Welcome|UniFi|Protect|Doorbell|Storage|Network/i.test(t);
      const absoluteLink = href && href.startsWith("http") ? href
                          : href ? (new URL(href, baseUrl)).toString()
                          : null;
      if (looksLikePost && absoluteLink && /blog\.ui\.com|blog-stories\.ui-apps\.com/.test(absoluteLink)) {
        candidates.push({ title: t.replace(/\s+/g, " ").trim(), link: absoluteLink });
      }
    });
    // de-dup and keep top 5
    const uniq = [];
    const seen = new Set();
    for (const c of candidates) {
      if (seen.has(c.link)) continue;
      seen.add(c.link);
      uniq.push(c);
      if (uniq.length >= 5) break;
    }
    return uniq;
  }

  async function refreshNews() {
    ensureNewsSection();
    const list = document.getElementById("ubnt-news-list");
    const sourceEl = document.getElementById("ubnt-news-source");
    list.innerHTML = "";
    let ok = false;
    for (const src of NEWS_SOURCES) {
      try {
        const text = await fetchText(src.url);
        let items = [];
        if (src.type === "rss") {
          const dom = new DOMParser().parseFromString(text, "application/xml");
          items = Array.from(dom.querySelectorAll("item")).slice(0,5).map((it) => ({
            title: it.querySelector("title")?.textContent?.trim() || "Untitled",
            link: it.querySelector("link")?.textContent?.trim() || "#",
            date: it.querySelector("pubDate")?.textContent?.trim() || ""
          }));
        } else {
          items = parseNewsFromHtml(text, src.url);
        }
        if (items && items.length) {
          for (const it of items) {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = it.link;
            a.textContent = it.title;
            a.target = "_blank";
            li.appendChild(a);
            if (it.date) {
              const small = document.createElement("small");
              small.style.color = "#666";
              small.style.marginLeft = "0.5rem";
              small.textContent = `(${new Date(it.date).toLocaleDateString()})`;
              li.appendChild(small);
            }
            list.appendChild(li);
          }
          sourceEl.textContent = `Source: ${new URL(src.url).host}`;
          ok = true;
          break;
        }
      } catch (err) {
        console.warn("News source failed:", src.url, err);
      }
    }
    if (!ok) {
      const li = document.createElement("li");
      li.textContent = "Unable to load news right now.";
      list.appendChild(li);
      sourceEl.textContent = "";
    }
  }

  // Hook up a manual refresh button if present
  function wireButton() {
    const btn = document.getElementById("refresh-now");
    if (btn) btn.addEventListener("click", refreshOnce);
  }

  // Kick off
  window.addEventListener("DOMContentLoaded", () => {
    wireButton();
    refreshOnce();
    // Auto-refresh daily while the page remains open
    setInterval(refreshOnce, POLL_EVERY_MS);
  });
})();