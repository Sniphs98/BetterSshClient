<script lang="ts">
  // Sits in a form field's label row and switches that field between a typed value and
  // a 1Password secret reference (op://vault/item/field) read when connecting — per
  // field, so the address, the user and the password can each come from 1Password or not.
  import { Icon } from '$lib/theme';

  let { on = $bindable(false), field }: { on: boolean; field: string } = $props();
</script>

<button
  type="button"
  aria-pressed={on}
  aria-label="{field} from 1Password"
  title={on ? `${field} is read from 1Password when connecting — click to type it instead` : `Read ${field.toLowerCase()} from 1Password`}
  onclick={() => (on = !on)}
  class="-my-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {on
    ? 'border-transparent bg-accent text-accent-fg'
    : 'border-default text-faint hover:border-strong hover:text-muted'}"
>
  <Icon name="key" size={10} />
  1Password
</button>
