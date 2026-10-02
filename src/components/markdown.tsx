import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model-generated markdown. react-markdown does not render raw HTML, so output
 * from agents cannot inject markup; links open in a new tab without opener access.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-out">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
