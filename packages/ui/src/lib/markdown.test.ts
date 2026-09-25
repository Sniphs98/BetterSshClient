// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderUntrustedMarkdown } from './markdown';

describe('renderUntrustedMarkdown', () => {
  it('renders ordinary markdown', () => {
    const html = renderUntrustedMarkdown('# Docker\n\nLists **containers**.\n\n- one\n- two\n\n`docker ps`');
    expect(html).toContain('<h1>Docker</h1>');
    expect(html).toContain('<strong>containers</strong>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>docker ps</code>');
  });

  it('strips scripts, event handlers and frames', () => {
    const html = renderUntrustedMarkdown('<script>alert(1)</script>\n\n<a href="https://x.dev" onclick="evil()">x</a>\n\n<iframe src="https://x.dev"></iframe>');
    expect(html).not.toMatch(/<script|onclick|<iframe/i);
  });

  it('drops images, so reading the docs pings nobody', () => {
    const html = renderUntrustedMarkdown('![tracker](https://track.example/p.gif)\n\n<img src="https://track.example/q.gif">');
    expect(html).not.toMatch(/<img|track\.example/);
  });

  it('keeps https and mailto links, but not javascript:, http: or file:', () => {
    const html = renderUntrustedMarkdown(
      '[ok](https://docs.example) [mail](mailto:a@b.c) [js](javascript:alert(1)) [plain](http://x.dev) [file](file:///C:/x)'
    );
    expect(html).toContain('href="https://docs.example"');
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).not.toMatch(/javascript:|http:\/\/x\.dev|file:/);
  });
});
