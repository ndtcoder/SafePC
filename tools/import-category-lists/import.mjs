#!/usr/bin/env node
// SafePC — nhập danh sách domain theo 6 nhóm từ các filter list công khai
// có giấy phép sạch: StevenBlack/hosts (MIT), UT1 Blocklist (CC BY-SA 4.0),
// The Block List Project (Unlicense). TUYỆT ĐỐI không dùng HaGeZi / OISD /
// Energized (GPL-3.0 / NC) theo quyết định của chủ sản phẩm 27/11/2026.
//
// Cách chạy:  node import.mjs [--force]
//   --force: tải lại mọi file nguồn (mặc định dùng lại .cache/ nếu đã có).
//
// Đầu ra:
//   - apps/pc-agent/src/SafePC.Agent.Shared/CategoryData/<id>.txt (6 file)
//   - tools/import-category-lists/manifest.json (thống kê đầy đủ)
// Xem README.md cùng thư mục và docs/10-DATA-SOURCES.md.

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(HERE, '.cache');
const OUT_DIR = path.join(REPO_ROOT, 'apps', 'pc-agent', 'src', 'SafePC.Agent.Shared', 'CategoryData');
const FORCE = process.argv.includes('--force');
const TODAY = new Date().toISOString().slice(0, 10);

mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Cấu hình nhóm: ngân sách + nguồn + ghi công. Thứ tự mảng CATEGORIES là thứ
// tự ƯU TIÊN khi một domain lọt vào nhiều nhóm: adult > gambling > violence
// > games > movies > social — domain chỉ thuộc đúng một nhóm.
// ---------------------------------------------------------------------------
const CATEGORIES = [
  {
    id: 'adult', budget: 8000,
    sourcesText: 'StevenBlack/hosts (alternates/porn-only), The Block List Project (Porn), UT1 Blocklist (adult — chi doi chieu)',
    licensesText: 'MIT (StevenBlack) / Unlicense (Block List Project) / CC BY-SA 4.0 (UT1 Blocklist — Université Toulouse Capitole)',
  },
  {
    id: 'gambling', budget: 4000,
    sourcesText: 'StevenBlack/hosts (alternates/gambling-only), UT1 Blocklist (gambling), The Block List Project (Gambling)',
    licensesText: 'MIT (StevenBlack) / CC BY-SA 4.0 (UT1 Blocklist — Université Toulouse Capitole) / Unlicense (Block List Project)',
  },
  {
    id: 'violence', budget: 500,
    sourcesText: 'UT1 Blocklist (agressif + dangerous_material)',
    licensesText: 'CC BY-SA 4.0 (UT1 Blocklist — Université Toulouse Capitole)',
  },
  {
    id: 'games', budget: 2500,
    sourcesText: 'UT1 Blocklist (games)',
    licensesText: 'CC BY-SA 4.0 (UT1 Blocklist — Université Toulouse Capitole)',
  },
  {
    id: 'movies', budget: 2000,
    sourcesText: 'UT1 Blocklist (audio-video + warez)',
    licensesText: 'CC BY-SA 4.0 (UT1 Blocklist — Université Toulouse Capitole)',
  },
  {
    id: 'social', budget: 2500,
    sourcesText: 'StevenBlack/hosts (alternates/social-only), UT1 Blocklist (social_networks + chat), The Block List Project (Facebook + TikTok + Twitter + WhatsApp)',
    licensesText: 'MIT (StevenBlack) / CC BY-SA 4.0 (UT1 Blocklist — Université Toulouse Capitole) / Unlicense (Block List Project)',
  },
];

const SB_BASE = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates';
const UT1_BASE = 'https://dsi.ut-capitole.fr/blacklists/download';
const BLP_BASE = 'https://blocklistproject.github.io/Lists';
const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip';

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------
function download(url, destName) {
  const dest = path.join(CACHE, destName);
  if (!FORCE && existsSync(dest) && statSync(dest).size > 0) return dest;
  console.log(`  tai ${url}`);
  execFileSync('curl', ['-fSL', '--retry', '2', '--max-time', '600', '-o', dest, url], { stdio: 'inherit' });
  return dest;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Chuẩn hoá 1 domain thô: lowercase, bỏ www., bỏ dấu chấm cuối; null nếu không hợp lệ. */
function normalizeDomain(raw) {
  if (!raw) return null;
  let d = String(raw).trim().toLowerCase();
  if (d.startsWith('www.')) d = d.slice(4);
  d = d.replace(/\.+$/, '');
  if (d.length === 0 || d.length > 253) return null;
  if (!DOMAIN_RE.test(d)) return null;
  const labels = d.split('.');
  if (labels.some((l) => l.length === 0 || l.length > 63)) return null;
  // TLD toàn số = IP / địa chỉ nội bộ, không phải domain.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return d;
}

/** Đọc file hosts (StevenBlack / Block List Project): "0.0.0.0 domain", "127.0.0.1 domain" hoặc domain trần. Trả về Map domain -> thứ tự xuất hiện đầu tiên. */
async function readHostsFile(file) {
  const map = new Map();
  let order = 0;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const lineRaw of rl) {
    const line = lineRaw.split('#')[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    let candidate = null;
    if (parts.length >= 2 && /^(\d{1,3}\.){3}\d{1,3}$/.test(parts[0])) candidate = parts[1];
    else if (parts.length === 1) candidate = parts[0];
    if (!candidate) continue;
    const d = normalizeDomain(candidate);
    if (d && !map.has(d)) map.set(d, order++);
  }
  return map;
}

/** Đọc file domains của UT1 (1 domain/dòng). Trả về Map domain -> thứ tự. */
async function readUt1Domains(file) {
  const map = new Map();
  let order = 0;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const lineRaw of rl) {
    const d = normalizeDomain(lineRaw);
    if (d && !map.has(d)) map.set(d, order++);
  }
  return map;
}

/** Giải nén 1 category của UT1, trả về đường dẫn file domains. */
function extractUt1(category) {
  const tarPath = download(`${UT1_BASE}/${category}.tar.gz`, `ut1-${category}.tar.gz`);
  const dir = path.join(CACHE, `ut1-${category}`);
  const domainsFile = path.join(dir, category, 'domains');
  if (FORCE || !existsSync(domainsFile)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['--no-same-owner', '-xzf', tarPath, '-C', dir]);
  }
  if (!existsSync(domainsFile)) throw new Error(`UT1 ${category}: khong tim thay file domains sau khi giai nen`);
  return domainsFile;
}

/** Cha của domain (bỏ nhãn trái nhất); null nếu chỉ còn 1 nhãn. */
function parentOf(d) {
  const i = d.indexOf('.');
  return i < 0 ? null : d.slice(i + 1);
}

/** Mọi domain cha của d (gần nhất trước). */
function* parentsOf(d) {
  let p = parentOf(d);
  while (p && p.includes('.')) {
    yield p;
    p = parentOf(p);
  }
}

// ---------------------------------------------------------------------------
// Nạp danh sách bảo vệ (exclude) + hạt giống
// ---------------------------------------------------------------------------
const excludeSet = new Set(
  readFileSync(path.join(HERE, 'exclude.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.split('#')[0].trim().toLowerCase())
    .filter(Boolean),
);
const isExcluded = (d) => {
  if (excludeSet.has(d)) return true;
  for (const p of parentsOf(d)) if (excludeSet.has(p)) return true;
  return false;
};

const seeds = JSON.parse(readFileSync(path.join(HERE, 'seeds.json'), 'utf8'));
const seedByCategory = new Map();
for (const cat of CATEGORIES) {
  const list = (seeds[cat.id] ?? []).map(normalizeDomain).filter(Boolean);
  seedByCategory.set(cat.id, new Set(list));
}
const allSeeds = new Set([...seedByCategory.values()].flatMap((s) => [...s]));

// ---------------------------------------------------------------------------
// Tải + đọc mọi nguồn. Mỗi nguồn = một "biên tập độc lập" để tính giao nhau:
// stevenblack / ut1 / blp. candidate: domain -> { sources:Set, order:Map
// nguồn->thứ tự, tranco: rank|null }
// ---------------------------------------------------------------------------
const manifest = { generatedAt: new Date().toISOString(), sources: {}, categories: {}, notes: [] };

async function loadHostsSource(key, url, fileName) {
  const file = download(url, fileName);
  const map = await readHostsFile(file);
  manifest.sources[key] = { url, uniqueDomains: map.size };
  return map;
}

async function loadUt1Source(key, categories) {
  const merged = new Map();
  const urls = [];
  for (const category of categories) {
    const file = extractUt1(category);
    urls.push(`${UT1_BASE}/${category}.tar.gz`);
    const map = await readUt1Domains(file);
    for (const [d, o] of map) if (!merged.has(d)) merged.set(d, merged.size);
    manifest.sources[`${key}:${category}`] = { url: `${UT1_BASE}/${category}.tar.gz`, uniqueDomains: map.size };
  }
  return merged;
}

console.log('== Tai va doc cac nguon ==');
const sbPorn = await loadHostsSource('stevenblack:porn', `${SB_BASE}/porn-only/hosts`, 'sb-porn.hosts');
const sbGambling = await loadHostsSource('stevenblack:gambling', `${SB_BASE}/gambling-only/hosts`, 'sb-gambling.hosts');
const sbSocial = await loadHostsSource('stevenblack:social', `${SB_BASE}/social-only/hosts`, 'sb-social.hosts');
const blpPorn = await loadHostsSource('blp:porn', `${BLP_BASE}/porn.txt`, 'blp-porn.txt');
const blpGambling = await loadHostsSource('blp:gambling', `${BLP_BASE}/gambling.txt`, 'blp-gambling.txt');
const blpFacebook = await loadHostsSource('blp:facebook', `${BLP_BASE}/facebook.txt`, 'blp-facebook.txt');
const blpTiktok = await loadHostsSource('blp:tiktok', `${BLP_BASE}/tiktok.txt`, 'blp-tiktok.txt');
const blpTwitter = await loadHostsSource('blp:twitter', `${BLP_BASE}/twitter.txt`, 'blp-twitter.txt');
const blpWhatsapp = await loadHostsSource('blp:whatsapp', `${BLP_BASE}/whatsapp.txt`, 'blp-whatsapp.txt');
const blpSocial = new Map();
for (const m of [blpFacebook, blpTiktok, blpTwitter, blpWhatsapp]) {
  for (const d of m.keys()) if (!blpSocial.has(d)) blpSocial.set(d, blpSocial.size);
}

const ut1Gambling = await loadUt1Source('ut1', ['gambling']);
const ut1Games = await loadUt1Source('ut1', ['games']);
const ut1Movies = await loadUt1Source('ut1', ['audio-video', 'warez']);
const ut1Violence = await loadUt1Source('ut1', ['agressif', 'dangerous_material']);
const ut1Social = await loadUt1Source('ut1', ['social_networks', 'chat']);

// UT1 adult (4,6 trieu domain): CHỈ đối chiếu dạng stream — không nạp cả
// tập vào bộ nhớ. Domain nào của pool adult (StevenBlack ∪ BLP) có mặt
// trong UT1 adult thì được cộng nguồn 'ut1'.
const adultPoolPreview = new Set([...sbPorn.keys(), ...blpPorn.keys()]);
{
  const file = extractUt1('adult');
  let scanned = 0;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const hits = new Set();
  for await (const lineRaw of rl) {
    scanned++;
    const d = normalizeDomain(lineRaw);
    if (d && adultPoolPreview.has(d)) hits.add(d);
  }
  manifest.sources['ut1:adult-crossref'] = {
    url: `${UT1_BASE}/adult.tar.gz`,
    uniqueDomains: scanned,
    note: `Chi doi chieu: ${hits.size} domain cua pool adult (StevenBlack ∪ BLP) co mat trong UT1 adult.`,
  };
  var ut1AdultHits = hits;
}

// Ánh xạ nhóm -> các nguồn (mỗi nguồn là Map domain -> thứ tự).
const CATEGORY_SOURCES = {
  adult: [['stevenblack', sbPorn], ['blp', blpPorn]],
  gambling: [['stevenblack', sbGambling], ['ut1', ut1Gambling], ['blp', blpGambling]],
  violence: [['ut1', ut1Violence]],
  games: [['ut1', ut1Games]],
  movies: [['ut1', ut1Movies]],
  social: [['stevenblack', sbSocial], ['ut1', ut1Social], ['blp', blpSocial]],
};

// Dựng pool ứng viên theo nhóm.
const pools = new Map();
for (const cat of CATEGORIES) {
  const pool = new Map();
  for (const [sourceName, map] of CATEGORY_SOURCES[cat.id]) {
    for (const [d, order] of map) {
      let entry = pool.get(d);
      if (!entry) { entry = { sources: new Set(), order: new Map(), tranco: null }; pool.set(d, entry); }
      entry.sources.add(sourceName);
      entry.order.set(sourceName, order);
    }
  }
  if (cat.id === 'adult') {
    for (const d of ut1AdultHits) {
      const entry = pool.get(d);
      if (entry) entry.sources.add('ut1');
    }
  }
  pools.set(cat.id, pool);
}

// Tranco top-1M: chỉ tra hạng cho domain đang là ứng viên (tiết kiệm bộ nhớ).
{
  const zip = download(TRANCO_URL, 'tranco-top-1m.csv.zip');
  const csvPath = path.join(CACHE, 'tranco-top-1m.csv');
  if (FORCE || !existsSync(csvPath)) {
    execFileSync('unzip', ['-o', '-q', zip, '-d', CACHE]);
    // File trong zip có thể tên khác: tìm file csv đầu tiên.
    const found = execFileSync('find', [CACHE, '-maxdepth', '2', '-name', '*.csv']).toString().trim().split('\n')[0];
    if (found && found !== csvPath) execFileSync('cp', [found, csvPath]);
  }
  const candidates = new Set();
  for (const pool of pools.values()) for (const d of pool.keys()) candidates.add(d);
  for (const s of allSeeds) candidates.add(s);
  let matched = 0;
  const rl = createInterface({ input: createReadStream(csvPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const rank = Number(line.slice(0, comma));
    const d = normalizeDomain(line.slice(comma + 1));
    if (d && candidates.has(d)) {
      matched++;
      for (const pool of pools.values()) {
        const entry = pool.get(d);
        if (entry) entry.tranco = rank;
      }
    }
  }
  manifest.sources['tranco:top-1m'] = { url: TRANCO_URL, matchedCandidates: matched };
}

// ---------------------------------------------------------------------------
// Chọn lọc. Thứ tự ưu tiên minh bạch:
//   (a) hạt giống — luôn giữ, tính vào ngân sách, thuộc nhóm của chúng;
//   (b) domain có >= 2 nguồn độc lập trong cùng nhóm;
//   (c) có hạng Tranco (phổ biến) — hạng càng nhỏ càng trước;
//   (d) thứ tự xuất hiện trong list nguồn (StevenBlack > UT1 > BLP).
// Mỗi domain chỉ thuộc một nhóm: xử lý nhóm theo thứ tự ưu tiên
// adult > gambling > violence > games > movies > social, domain đã được
// nhóm trước nhận thì nhóm sau không lấy nữa (ghi số vào manifest).
// ---------------------------------------------------------------------------
const SOURCE_PREFERENCE = ['stevenblack', 'ut1', 'blp'];
function rankKey(entry) {
  const tier = entry.sources.size >= 2 ? 0 : entry.tranco !== null ? 1 : 2;
  let bestOrder = Infinity;
  let prefBonus = 0;
  for (const [name, order] of entry.order) {
    const pref = SOURCE_PREFERENCE.indexOf(name);
    const key = pref * 1e9 + order;
    if (key < bestOrder) { bestOrder = key; prefBonus = pref; }
  }
  return { tier, tranco: entry.tranco ?? Infinity, negSources: -entry.sources.size, bestOrder };
}
function compareCandidates(a, b) {
  const ka = rankKey(a[1]); const kb = rankKey(b[1]);
  if (ka.tier !== kb.tier) return ka.tier - kb.tier;
  if (ka.tranco !== kb.tranco) return ka.tranco - kb.tranco;
  if (ka.negSources !== kb.negSources) return ka.negSources - kb.negSources;
  if (ka.bestOrder !== kb.bestOrder) return ka.bestOrder - kb.bestOrder;
  return a[0] < b[0] ? -1 : 1;
}

const claimed = new Map(); // domain -> categoryId đã nhận
const finalByCategory = new Map();

for (const cat of CATEGORIES) {
  const pool = pools.get(cat.id);
  const stats = {
    budget: cat.budget,
    poolSize: pool.size,
    multiSourceInPool: [...pool.values()].filter((e) => e.sources.size >= 2).length,
    seeds: seedByCategory.get(cat.id).size,
    droppedToHigherCategory: 0,
    collapsedSubdomains: 0,
    excludedRemoved: 0,
    backfilled: 0,
    finalCount: 0,
  };

  const selected = new Set();
  // (a) Hạt giống thuộc nhóm này — nhận trước, kể cả khi nguồn ngoài cũng
  // xếp domain đó vào nhóm khác (hạt giống là quyết định của SafePC).
  for (const d of seedByCategory.get(cat.id)) {
    selected.add(d);
    claimed.set(d, cat.id);
  }

  const ranked = [...pool.entries()]
    .filter(([d]) => !selected.has(d))
    .sort(compareCandidates);

  const fillFrom = (list, budget, st) => {
    for (const [d] of list) {
      if (selected.size >= budget) break;
      if (selected.has(d)) continue;
      const owner = claimed.get(d);
      if (owner && owner !== cat.id) { st.droppedToHigherCategory++; continue; }
      // Bỏ qua nếu đã có domain cha trong selected (extension khớp theo
      // hậu tố — giữ bản con là thừa ngân sách).
      let covered = false;
      for (const p of parentsOf(d)) if (selected.has(p)) { covered = true; break; }
      if (covered) { st.collapsedSubdomains++; continue; }
      // Nếu domain này là cha của domain con đã chọn, thay con bằng cha.
      for (const existing of [...selected]) {
        if (existing.endsWith('.' + d)) { selected.delete(existing); claimed.delete(existing); st.collapsedSubdomains++; }
      }
      selected.add(d);
      claimed.set(d, cat.id);
    }
  };

  fillFrom(ranked, cat.budget, stats);

  // Áp danh sách bảo vệ SAU chọn lọc (đúng yêu cầu), rồi lấp lại ngân sách
  // từ ứng viên còn lại (vẫn tôn trọng claimed + exclude). Lượt lấp lại
  // dùng stats rỗng để không đếm trùng các bộ đếm của lượt đầu.
  stats.excludedDomains = [];
  for (const d of [...selected]) {
    if (isExcluded(d)) { selected.delete(d); claimed.delete(d); stats.excludedRemoved++; stats.excludedDomains.push(d); }
  }
  if (stats.excludedRemoved > 0 && selected.size < cat.budget) {
    const before = selected.size;
    const dummyStats = { droppedToHigherCategory: 0, collapsedSubdomains: 0 };
    fillFrom(ranked.filter(([d]) => !isExcluded(d)), cat.budget, dummyStats);
    stats.backfilled = selected.size - before;
  }

  stats.finalCount = selected.size;
  manifest.categories[cat.id] = stats;
  finalByCategory.set(cat.id, selected);
}

// ---------------------------------------------------------------------------
// Ghi đầu ra: 6 file dữ liệu cho Agent + manifest.
// ---------------------------------------------------------------------------
for (const cat of CATEGORIES) {
  const domains = [...finalByCategory.get(cat.id)].sort();
  const header = [
    `# SafePC — danh sach domain danh muc "${cat.id}". File SINH TU DONG boi tools/import-category-lists/import.mjs — KHONG sua tay (chay lai script de cap nhat).`,
    `# Nguon: ${cat.sourcesText}. Giay phep: ${cat.licensesText}.`,
    `# Ngay nhap: ${TODAY} | So domain: ${domains.length} | Phuong phap chon loc + so lieu day du: docs/10-DATA-SOURCES.md va tools/import-category-lists/manifest.json.`,
  ];
  writeFileSync(path.join(OUT_DIR, `${cat.id}.txt`), header.join('\n') + '\n' + domains.join('\n') + '\n', 'utf8');
}

// Domain "nhạy cảm dễ chặn nhầm" tiêu biểu có mặt trong đầu ra (để cảnh báo
// trong tài liệu cho phụ huynh).
const SENSITIVE_WATCH = ['steampowered.com', 'itch.io', 'twitch.tv', 'roblox.com', 'netflix.com', 'hulu.com', 'disneyplus.com', 'spotify.com', 'youtube.com', 'vimeo.com', 'dailymotion.com', 'kick.com', 'epicgames.com', 'origin.com', 'battle.net', 'gog.com'];
manifest.sensitivePresent = {};
for (const d of SENSITIVE_WATCH) {
  if (claimed.has(d)) manifest.sensitivePresent[d] = claimed.get(d);
}
manifest.totalDomains = [...finalByCategory.values()].reduce((n, s) => n + s.size, 0);
manifest.excludedList = [...excludeSet];

writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('\n== KET QUA NHAP ==');
console.log('nhom        ngan sach   pool    >=2 nguon   hat giong   bi loai(exclude)   cuoi cung');
for (const cat of CATEGORIES) {
  const s = manifest.categories[cat.id];
  console.log(
    `${cat.id.padEnd(11)} ${String(s.budget).padStart(6)} ${String(s.poolSize).padStart(8)} ${String(s.multiSourceInPool).padStart(10)} ${String(s.seeds).padStart(10)} ${String(s.excludedRemoved).padStart(15)} ${String(s.finalCount).padStart(11)}`,
  );
}
console.log(`TONG: ${manifest.totalDomains} domain (ngan sach tong 19500)`);
console.log('Domain nhay cam de chan nham co mat trong dau ra:', JSON.stringify(manifest.sensitivePresent));
