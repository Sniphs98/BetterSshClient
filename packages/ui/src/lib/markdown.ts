// Markdown someone else wrote — a plugin's README — turned into HTML that is safe to
// put in the app window. The app window holds the IPC bridge to SSH sessions and saved
// hosts, so nothing in that text may run or phone home:
//
// - no scripts, event handlers, frames, forms or styles (DOMPurify);
// - no images or media: a remote image would tell its author when you read the docs;
// - links only to https:// and mailto: — the page opening them sends them to the
//   system browser rather than navigating the app.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const FORBID_TAGS = ['img', 'picture', 'svg', 'math', 'video', 'audio', 'source', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta', 'base'];

export function renderUntrustedMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR: ['style', 'srcset'],
    ALLOWED_URI_REGEXP: /^(?:https:|mailto:|#)/i
  });
}
