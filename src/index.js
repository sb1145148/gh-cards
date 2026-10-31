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

const CACHE_TTL = 21600;          // 6 小时
const GQL = 'https://api.github.com/graphql';

const THEMES = {
  dark:  { bg: '#0d1117', border: '#30363d', title: '#c9d1d9', text: '#8b949e',
           accent: '#58a6ff', extra: '#3fb950' },
  light: { bg: '#ffffff', border: '#d0d7de', title: '#24292f', text: '#57606a',
           accent: '#0969da', extra: '#1a7f37' },
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

function frame(w, h, theme, body) {
  const t = THEMES[theme] || THEMES.dark;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
  xmlns="http://www.w3.org/2000/svg" role="img">
  <rect width="${w}" height="${h}" rx="8" fill="${t.bg}" stroke="${t.border}"/>
  ${body}
</svg>`;
}

function statsSvg(s, theme, opts) {
  const t = THEMES[theme] || THEMES.dark;
  const items = [
    ['总 Star', s.stars], ['仓库', s.repos],
    ['提交(一年)', s.commits], ['PR(一年)', s.prs],
    ['Issue(一年)', s.issues], ['关注者', s.followers],
  ].filter(([k]) => {
    const hide = (opts.hide || []).map((h) => HIDE_ALIAS[String(h).toLowerCase()] || h);
    return !hide.includes(k);
  });

  const rows = Math.ceil(items.length / 2);
  const h = 70 + rows * 34;
  const cells = items.map(([label, value], i) => {
    const cx = 30 + (i % 2) * 195;
    const cy = 66 + Math.floor(i / 2) * 34;
    return `<text x="${cx}" y="${cy}" fill="${t.accent}" font-size="17" font-weight="700">${value}</text>
  <text x="${cx + 52}" y="${cy}" fill="${t.text}" font-size="12">${esc(label)}</text>`;
  }).join('\n  ');

  return frame(400, h, theme, `
  <text x="24" y="32" fill="${t.title}" font-size="15" font-weight="700">${esc(s.name)}</text>
  <text x="24" y="48" fill="${t.text}" font-size="11">@${esc(s.login)}</text>
  ${cells}`);
}

function langsSvg(s, theme, opts) {
  const t = THEMES[theme] || THEMES.dark;
  const count = Math.max(1, Math.min(opts.langs_count || 6, 12));
  const langs = s.langs.slice(0, count);
  const h = 60 + Math.ceil(count / 2) * 30 + 24;
  const barW = 352;

  let offset = 0;
  const segs = langs.map((l) => {
    const w = Math.max(2, (l.pct / 100) * barW);
    const seg = `<rect x="${24 + offset}" y="58" width="${w}" height="8" rx="4"
    fill="${LANG_COLORS[l.name] || '#8b949e'}"/>`;
    offset += w;
    return seg;
  }).join('\n  ');

  const legend = langs.map((l, i) => {
    const cx = 24 + (i % 2) * 180;
    const cy = 88 + Math.floor(i / 2) * 30;
    return `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${LANG_COLORS[l.name] || '#8b949e'}"/>
  <text x="${cx + 16}" y="${cy}" fill="${t.title}" font-size="12">${esc(l.name)}</text>
  <text x="${cx + 118}" y="${cy}" fill="${t.text}" font-size="12">${l.pct.toFixed(1)}%</text>`;
  }).join('\n  ');

  return frame(400, h, theme, `
  <text x="24" y="32" fill="${t.title}" font-size="14" font-weight="700">Most Used Languages</text>
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
    const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
    const opts = {
      langs_count: Number(url.searchParams.get('langs_count') || 6),
      hide: (url.searchParams.get('hide') || '').split(',').filter(Boolean),
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
    const cacheKey = new Request(url.toString(), { method: 'GET' });
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
