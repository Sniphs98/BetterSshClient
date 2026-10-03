// Keeps a scrolling list at its newest line while it grows — like a terminal: as long as
// the user is at the bottom, new content scrolls into view; once they scroll up to read
// something, it stays where they are, and scrolling back down picks the following up again.

/** How close to the bottom (px) still counts as "at the bottom". */
const SLACK = 24;

/** Whether a box scrolled to `scrollTop` shows its last `SLACK` px. Pure, for tests. */
export function isAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = SLACK): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

export function stickToBottom(node: HTMLElement): { destroy(): void } {
  let following = true;
  const toBottom = (): void => {
    node.scrollTop = node.scrollHeight;
  };
  // Where the user is, read on every scroll — including the ones this makes.
  const onScroll = (): void => {
    following = isAtBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
  };
  node.addEventListener('scroll', onScroll, { passive: true });
  // New lines, a step finishing, output appearing: follow if the user was at the bottom.
  const observer = new MutationObserver(() => {
    if (following) toBottom();
  });
  observer.observe(node, { childList: true, subtree: true, characterData: true });
  toBottom();
  return {
    destroy() {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
    }
  };
}
