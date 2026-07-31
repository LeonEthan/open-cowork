import { Children, isValidElement, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightCode } from '../lib/shiki';

/**
 * markdown 渲染（react-markdown + remark-gfm + Shiki 按需高亮）。
 * 代码块规则（DESIGN.md §4）：--bg-soft 底 + 1px 边框 + 8px 圆角；
 * 高亮四色见 lib/shiki.ts（token 运行时解析）。
 */

function CodeBlock(props: { lang: string | null; code: string; themeKey: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setHtml(null);
    void highlightCode(props.code, props.lang).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [props.code, props.lang, props.themeKey]);

  if (html) {
    // Shiki 输出为本进程生成的受信 HTML（不含用户脚本——highlight.js 语义着色仅 span+style）
    return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre className="code-block code-plain">
      <code>{props.code}</code>
    </pre>
  );
}

export function Markdown(props: { text: string; themeKey: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const child = Children.only(children);
            if (isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
              const lang = /language-([\w+-]+)/.exec(child.props.className ?? '')?.[1] ?? null;
              const raw = String(child.props.children ?? '').replace(/\n$/, '');
              return <CodeBlock lang={lang} code={raw} themeKey={props.themeKey} />;
            }
            return <pre className="code-block code-plain">{children}</pre>;
          },
          code({ children }) {
            return <code className="inline-code">{children}</code>;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
