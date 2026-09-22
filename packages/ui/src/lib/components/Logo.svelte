<script lang="ts">
  // BetterSshClient mark: the terminal glyph lifted out of the app icon, as an alpha
  // mask. Drawn via a CSS mask rather than an <img> so it takes its colour from a theme
  // token — it stays legible on both light and dark (ink on light, paper on dark) and
  // never disappears into a same-colour surface.
  export let size = 24;
  export let color = 'var(--accent)'; // any theme token: --accent | --text | ...
  export let title = 'BetterSshClient';
</script>

<span
  class="logo"
  role="img"
  aria-label={title}
  style="--logo-size:{size}px; --logo-color:{color};"
></span>

<style>
  .logo {
    display: inline-block;
    width: var(--logo-size);
    height: var(--logo-size);
    background-color: var(--logo-color);
    -webkit-mask: url(/logo.png) center / contain no-repeat;
    mask: url(/logo.png) center / contain no-repeat;
  }
</style>
