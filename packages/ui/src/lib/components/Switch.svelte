<script lang="ts">
  // An on/off switch in the app's look — the same control as Settings' toggles — for
  // forms, where a native checkbox would stand out as the one unstyled control.
  let {
    checked = $bindable(false),
    label,
    disabled = false
  }: { checked: boolean; label: string; disabled?: boolean } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => (checked = !checked)}
  class="relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {checked
    ? 'bg-accent'
    : 'bg-surface-inset'}"
>
  <span
    class="absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-soft transition-[left] {checked
      ? 'left-[1.375rem]'
      : 'left-0.5'}"
  ></span>
</button>
