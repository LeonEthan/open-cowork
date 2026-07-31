/**
 * Shiki 按需懒加载（ticket #19，DESIGN.md §4 约束）：
 * - 高亮器本体与语言都动态 import——首个代码块出现前零成本，不拖启动；
 * - 语法高亮仅用 §4 白名单四色（ink / ink-3 / accent / 语义绿），
 *   颜色在运行时从 CSS token 解析（getComputedStyle），JS 侧不硬编码色值，
 *   主题切换后重新高亮（调用方按 resolvedTheme 作 key）。
 */

interface TokenColorRule {
  token: string;
  scopes: string[];
}

/** 四色宪法：其余 scope 一律回落 fg（ink） */
const RULES: TokenColorRule[] = [
  { token: '--ink-3', scopes: ['comment', 'punctuation.definition.comment'] },
  {
    token: '--accent',
    scopes: [
      'keyword',
      'storage',
      'entity.name.function',
      'support.function',
      'entity.name.tag',
      'markup.heading',
      'string.regexp',
      'variable.language',
    ],
  },
  {
    token: '--success',
    scopes: ['string', 'constant.numeric', 'constant.language', 'markup.inserted'],
  },
];

let highlighterPromise: Promise<import('shiki').HighlighterCore> | null = null;
let highlighterThemeKey: string | null = null;
const loadedLangs = new Set<string>();

/** 常见语言别名收敛（shiki 注册名） */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
};

function readToken(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // token 缺失时回落 currentColor（继承正文 ink——不硬编码色值，§6）
  return v || 'currentColor';
}

async function getHighlighter(themeKey: string): Promise<import('shiki').HighlighterCore> {
  // 主题切换后 token 值变化：重建高亮器（§6 瞬间切换，跟随当前 token）
  if (highlighterPromise && highlighterThemeKey === themeKey) return highlighterPromise;
  highlighterThemeKey = themeKey;
  loadedLangs.clear();
  highlighterPromise = (async () => {
    const { createHighlighterCore } = await import('shiki/core');
    const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript');
    // 自定义四色主题（颜色运行时从 token 解析，见 RULES）
    const theme = {
      name: 'open-cowork-constitution',
      type: 'dark' as const,
      fg: readToken('--ink'),
      bg: 'transparent',
      settings: RULES.map((r) => ({
        scope: r.scopes,
        settings: { foreground: readToken(r.token) },
      })),
    };
    return createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighterPromise;
}

/**
 * 高亮一段代码为 HTML（失败/未知语言回落 null——调用方用纯 <pre> 兜底）。
 * 语言按需注册；themeKey = 当前 resolvedTheme（调用方在主题切换时传入新值触发重建）。
 */
export async function highlightCode(
  code: string,
  lang: string | null,
  themeKey: string,
): Promise<string | null> {
  try {
    const highlighter = await getHighlighter(themeKey);
    const resolved = lang ? (LANG_ALIASES[lang] ?? lang) : null;
    if (resolved && !loadedLangs.has(resolved)) {
      try {
        // shiki 3 bundled 语言按需动态 import
        const mod = await import(`shiki/langs/${resolved}.mjs`);
        await highlighter.loadLanguage(mod.default);
        loadedLangs.add(resolved);
      } catch {
        return null; // 未知语言：纯文本兜底
      }
    }
    if (!resolved) return null;
    return highlighter.codeToHtml(code, { lang: resolved, theme: 'open-cowork-constitution' });
  } catch {
    return null;
  }
}
