/* ============================================================
 *  gh-cards —— 自己托管 GitHub 卡片，替代公共的
 *  github-readme-stats.vercel.app
 *
 *  为什么要有这个：
 *    公共实例是所有用户共用一个配额，随时可能被限流，
 *    结果就是 README 里出现破图。用自己的 Worker + 自己的 token，
 *    配额独立，而且出错时返回的是「一张写着错误的图」而不是破图。
 *
 *  路由：
 *    GET /api?username=<user>&type=stats
 *    GET /api?username=<user>&type=langs
 *    GET /api?username=<user>&type=stats&theme=light&hide=issues
 *
 *  环境变量（secret）：
 *    GH_TOKEN  GitHub classic PAT，不勾任何 scope 即可
 * ============================================================ */

import { CAVEAT_WOFF2, CAVEAT_TTF } from './font.js';

const CACHE_TTL = 21600;
// 改了渲染逻辑就加一，强制边缘重新生成（Cache API 的 key 会带上它）
const BUILD = 'v3';          // 6 小时
const GQL = 'https://api.github.com/graphql';

const THEMES = {
  dark:  { bg: '#0d1117', border: '#30363d', title: '#c9d1d9', text: '#8b949e',
           accent: '#58a6ff', extra: '#3fb950' },
  light: { bg: '#ffffff', border: '#d0d7de', title: '#24292f', text: '#57606a',
           accent: '#0969da', extra: '#1a7f37' },
  // 浅粉手写风（参考主题）
  pink:  { bg: '#ffffff', border: '#f3d6e0', title: '#f06292', text: '#ec6a8c',
           accent: '#f48fb1', extra: '#f8bbd0', track: '#fde8f0', script: true },
};

const HIDE_ALIAS = {
  star: '总 Star', stars: '总 Star',
  repos: '仓库', repo: '仓库',
  commits: '提交(一年)', commit: '提交(一年)',
  prs: 'PR(一年)', pr: 'PR(一年)',
  issues: 'Issue(一年)', issue: 'Issue(一年)',
  followers: '关注者', follower: '关注者',
};

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#563d7c',
  Python: '#3572a5', Shell: '#89e051', Java: '#b07219', Kotlin: '#A97BFF',
  Go: '#00ADD8', Rust: '#dea584', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600',
  Ruby: '#701516', PHP: '#4F5D95', Vue: '#41b883', Svelte: '#ff3e00',
  Swift: '#F05138', Dart: '#00B4AB', Lua: '#000080', Dockerfile: '#384d54',
};

/* ------------------------- 数据 ------------------------- */

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    login
    name
    followers { totalCount }
    following { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        stargazerCount
        forkCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
    }
  }
}`;

async function fetchUser(login, token) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'gh-cards',
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message || 'GraphQL error');
  const user = json.data?.user;
  if (!user) throw new Error(`用户不存在: ${login}`);
  return user;
}

function summarize(user) {
  const repos = user.repositories?.nodes || [];
  const stars = repos.reduce((n, r) => n + (r.stargazerCount || 0), 0);
  const forks = repos.reduce((n, r) => n + (r.forkCount || 0), 0);
  const langs = new Map();
  const seen = new Set();      // 同一个仓库内同一语言只算一次，避免 pre-100 重复
  for (const r of repos) {
    const local = new Set();
    for (const e of r.languages?.edges || []) {
      const name = e.node?.name;
      if (!name || local.has(name)) continue;
      local.add(name);
      langs.set(name, (langs.get(name) || 0) + (e.size || 0));
    }
  }
  const totalLang = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
  const langList = [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, size]) => ({ name, pct: (size / totalLang) * 100 }));

  return {
    name: user.name || user.login,
    login: user.login,
    followers: user.followers?.totalCount || 0,
    following: user.following?.totalCount || 0,
    repos: user.repositories?.totalCount || 0,
    stars, forks,
    commits: user.contributionsCollection?.totalCommitContributions || 0,
    prs: user.contributionsCollection?.totalPullRequestContributions || 0,
    issues: user.contributionsCollection?.totalIssueContributions || 0,
    langs: langList,
    seenLanguages: seen.size,
  };
}

/* ------------------------- 画图 ------------------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SCRIPT_STACK = `'Caveat','Segoe Script','Bradley Hand','Comic Sans MS',cursive`;
const SANS_STACK = `-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

function fontFace() {
  return `<style>@font-face{font-family:'Caveat';src:url(data:font/woff2;base64,${CAVEAT_WOFF2}) format('woff2'),url(data:font/ttf;base64,${CAVEAT_TTF}) format('truetype');}` +
    `.sc{font-family:${SCRIPT_STACK}}.sx{font-family:${SANS_STACK}}</style>`;
}

function frame(w, h, theme, body) {
  // 允许传主题名或已解析的主题对象（后者能带上 script/覆盖色）
  const t = typeof theme === 'string' ? (THEMES[theme] || THEMES.dark) : theme;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
  xmlns="http://www.w3.org/2000/svg" role="img">
  ${t.script ? fontFace() : ''}
  <rect width="${w}" height="${h}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
  ${body}
</svg>`;
}

/* ---------- 评级：把各项活动折算成一个等级（参考 github-readme-stats 的思路） ---------- */
function rankOf(s) {
  const commits = Math.max(1, s.commits);
  const score =
    Math.log(commits) * 12 +
    Math.log(1 + s.prs) * 18 +
    Math.log(1 + s.issues) * 14 +
    Math.log(1 + s.stars + s.forks) * 16 +
    Math.log(1 + s.followers) * 10;
  const table = [
    [135, 'A++', 100], [125, 'A+', 92], [115, 'A', 84], [105, 'A-', 76],
    [95, 'B+', 68], [85, 'B', 60], [75, 'B-', 52], [65, 'C+', 44],
    [55, 'C', 36], [45, 'C-', 28], [35, 'D+', 20], [0, 'D', 12],
  ];
  for (const [min, grade, pct] of table) if (score >= min) return { grade, pct };
  return { grade: 'D', pct: 12 };
}

const ICONS = {
  star: '<path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z"/>',
  clock: '<circle cx="8" cy="8" r="6.2" fill="none" stroke-width="1.6"/><path d="M8 4.4V8l2.6 1.7" fill="none" stroke-width="1.6"/>',
  branch: '<circle cx="4.4" cy="4" r="1.9"/><circle cx="4.4" cy="12" r="1.9"/><circle cx="11.6" cy="6.4" r="1.9"/><path d="M4.4 5.9v4.2M6.3 6.4h2.2a1.2 1.2 0 0 1 1.2 1.2v0" fill="none" stroke-width="1.4"/>',
  issue: '<circle cx="8" cy="8" r="6.2" fill="none" stroke-width="1.6"/><path d="M8 4.6v4.2" stroke-width="1.8" fill="none"/><circle cx="8" cy="11.3" r="1"/>',
  repo: '<rect x="2.4" y="3" width="11.2" height="10" rx="1.6" fill="none" stroke-width="1.5"/><path d="M2.4 6h11.2" stroke-width="1.3"/>',
};

function icon(kind, x, y, color) {
  return `<g transform="translate(${x},${y})" fill="${color}" stroke="${color}">${ICONS[kind]}</g>`;
}

function statsSvg(s, theme, opts) {
  const t = { ...(THEMES[theme] || THEMES.dark) };
  const script = t.script || opts.font === 'script';
  if (script && !t.script) {
    // 暗色 + 手写体：换成粉色系，否则手写体配灰白很怪
    t.title = '#f48fb1'; t.text = '#f8bbd0'; t.accent = '#f06292';
    t.track = '#30363d'; t.border = '#30363d';
  }
  if (script) t.script = true;   // 让 frame() 把 @font-face 打进去
  const rows = [
    ['star', 'Total Stars', s.stars],
    ['clock', 'Total Commits', s.commits >= 1000 ? (s.commits / 1000).toFixed(0) + 'k' : s.commits],
    ['branch', 'Total PRs', s.prs],
    ['issue', 'Total Issues', s.issues],
    ['repo', 'Contributed to', s.repos],
  ].filter(([, label]) => {
    const hide = (opts.hide || []).map((h) => HIDE_ALIAS[String(h).toLowerCase()] || h);
    return !hide.some((h) => label.toLowerCase().includes(String(h).toLowerCase()));
  });

  const rank = rankOf(s);
  const W = 460;
  const H = 78 + rows.length * 34;
  const ringX = W - 74, ringY = H / 2 + 6, r = 40;
  const dash = 2 * Math.PI * r;

  const list = rows.map(([kind, label, value], i) => {
    const y = 62 + i * 34;
    return `${icon(kind, 26, y - 13, t.accent)}
  <text x="52" y="${y}" class="${script ? 'sc' : 'sx'}" fill="${t.title}" font-size="${script ? 19 : 13}" font-weight="${script ? 400 : 500}">${esc(label)}</text>
  <text x="232" y="${y}" class="${script ? 'sc' : 'sx'}" fill="${t.text}" font-size="${script ? 19 : 13}" font-weight="${script ? 400 : 500}">${value}</text>`;
  }).join('\n  ');

  return frame(W, H, t, `
  <text x="26" y="34" class="${script ? 'sc' : 'sx'}" fill="${t.title}" font-size="${script ? 23 : 15}" font-weight="${script ? 400 : 700}">My GitHub Statistics</text>
  ${list}
  <circle cx="${ringX}" cy="${ringY}" r="${r}" fill="none" stroke="${t.track || '#fde8f0'}" stroke-width="9"/>
  <circle cx="${ringX}" cy="${ringY}" r="${r}" fill="none" stroke="${t.accent}" stroke-width="9"
          stroke-linecap="round" stroke-dasharray="${(dash * rank.pct) / 100} ${dash}"
          transform="rotate(-90 ${ringX} ${ringY})"/>
  <text x="${ringX}" y="${ringY + 8}" text-anchor="middle" class="${script ? 'sc' : 'sx'}"
        fill="${t.title}" font-size="${script ? 23 : 16}" font-weight="700">${rank.grade}</text>`);
}

function langsSvg(s, theme, opts) {
  const t = { ...(THEMES[theme] || THEMES.dark) };
  const script = t.script || opts.font === 'script';
  if (script && !t.script) {
    // 暗色 + 手写体：换成粉色系，否则手写体配灰白很怪
    t.title = '#f48fb1'; t.text = '#f8bbd0'; t.accent = '#f06292';
    t.track = '#30363d'; t.border = '#30363d';
  }
  if (script) t.script = true;   // 让 frame() 把 @font-face 打进去
  const count = Math.max(1, Math.min(opts.langs_count || 9, 12));
  const langs = s.langs.slice(0, count);
  const W = 460;
  const cols = 2;
  const rowH = 32;
  const legendTop = 108;
  const H = legendTop + Math.ceil(langs.length / cols) * rowH + 16;
  const barW = W - 52;

  let offset = 0;
  const segs = langs.map((l) => {
    const w = Math.max(2, (l.pct / 100) * barW);
    const seg = `<rect x="${26 + offset}" y="68" width="${w}" height="9" rx="4.5"
    fill="${LANG_COLORS[l.name] || '#8b949e'}"/>`;
    offset += w;
    return seg;
  }).join('\n  ');

  const legend = langs.map((l, i) => {
    const cx = 24 + (i % cols) * 226;
    const cy = legendTop + Math.floor(i / cols) * rowH;
    const label = `${l.name} (${l.pct.toFixed(2)}%)`;
    return `<circle cx="${cx + 6}" cy="${cy - 3}" r="5.5" fill="${LANG_COLORS[l.name] || '#8b949e'}"/>
  <text x="${cx + 20}" y="${cy + 2}" class="${script ? 'sc' : 'sx'}" fill="${t.title}"
        font-size="${script ? 17 : 12}" font-weight="${script ? 400 : 500}">${esc(label)}</text>`;
  }).join('\n  ');

  return frame(W, H, t, `
  <text x="26" y="40" class="${script ? 'sc' : 'sx'}" fill="${t.title}" font-size="${script ? 23 : 14}" font-weight="${script ? 400 : 700}">My Programming Languages</text>
  ${segs}
  ${legend}`);
}

function errorSvg(msg, theme) {
  const t = THEMES[theme] || THEMES.dark;
  const text = String(msg).slice(0, 90);
  return frame(400, 78, theme, `
  <text x="24" y="32" fill="#f85149" font-size="12" font-weight="700">卡片生成失败</text>
  <text x="24" y="52" fill="${t.text}" font-size="11">${esc(text)}</text>
  <text x="24" y="68" fill="${t.text}" font-size="10">检查 Worker 的 GH_TOKEN 是否已设置、是否已过期</text>`);
}

/* ------------------------- 入口 ------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('gh-cards ok\n路由: /api?username=xxx&type=stats|langs\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    if (url.pathname !== '/api') {
      return new Response('Not Found', { status: 404 });
    }

    const username = (url.searchParams.get('username') || '').trim();
    const type = (url.searchParams.get('type') || 'stats').trim();
    const themeParam = (url.searchParams.get('theme') || '').toLowerCase();
    const theme = themeParam in THEMES ? themeParam : 'dark';
    const opts = {
      langs_count: Number(url.searchParams.get('langs_count') || 6),
      hide: (url.searchParams.get('hide') || '').split(',').filter(Boolean),
      font: (url.searchParams.get('font') || '').toLowerCase(),
    };

    const svgHeaders = {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
    };

    if (!username) {
      return new Response(errorSvg('缺少 username 参数', theme), { headers: svgHeaders });
    }
    if (!env.GH_TOKEN) {
      return new Response(errorSvg('Worker 没有配置 GH_TOKEN 环境变量', theme), { headers: svgHeaders });
    }

    // 用 Cache API 缓存整个 SVG，省 GitHub 配额
    const cacheKey = new Request(`${url.toString()}&__build=${BUILD}`, { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let svg;
    try {
      const user = await fetchUser(username, env.GH_TOKEN);
      const s = summarize(user);
      svg = type === 'langs' ? langsSvg(s, theme, opts) : statsSvg(s, theme, opts);
    } catch (err) {
      svg = errorSvg(err.message || '未知错误', theme);
    }

    const res = new Response(svg, { headers: svgHeaders });
    if (!svg.includes('卡片生成失败')) {
      await cache.put(cacheKey, res.clone());
    }
    return res;
  },
};
