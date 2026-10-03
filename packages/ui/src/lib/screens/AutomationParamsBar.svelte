<script lang="ts">
  // The automation's parameters and variables, in a bar under the editor's top bar: one
  // chip per parameter (name, kind, and the value of a fixed one), then "Add parameter".
  // Reads/writes `params` through `AUTOMATION_PARAMS_CONTEXT`, which AutomationEditor
  // provides.
  //
  // Text and host parameters are asked for when the automation runs; a host one is where
  // every "on host" step runs. A fixed one is a variable set right here, never asked for.
  // Every node uses them as {{params.<name>}}.
  //
  // Edits apply on every keystroke. "Add parameter" appends one (text, a placeholder name)
  // and selects its name, so typing replaces the placeholder. Chips are keyed by index,
  // not name: keying by name would remount (and defocus) a chip on every keystroke.
  import { getContext, tick } from 'svelte';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import type { AutomationParamKindDto } from '$lib/bindings';
  import { AUTOMATION_PARAMS_CONTEXT, type AutomationParamsContext } from './automationCanvasTypes';

  const ctx = getContext<AutomationParamsContext>(AUTOMATION_PARAMS_CONTEXT);

  let rowNameInputs: Array<HTMLInputElement | undefined> = [];

  function uniqueParamName(): string {
    const taken = new Set(ctx.params().map((p) => p.name));
    if (!taken.has('param')) return 'param';
    let i = 2;
    while (taken.has(`param-${i}`)) i += 1;
    return `param-${i}`;
  }

  function addParam(): void {
    const newIndex = ctx.params().length;
    ctx.addParam(uniqueParamName(), 'text');
    void tick().then(() => {
      const el = rowNameInputs[newIndex];
      el?.focus();
      el?.select();
    });
  }

  // A chip's own "host" option is only disabled by *another* one already being host.
  function hostTakenElsewhere(index: number): boolean {
    return ctx.params().some((p, i) => i !== index && p.kind === 'host');
  }

  const chipField =
    'min-w-0 rounded-md bg-transparent px-1.5 py-1 text-xs text-fg outline-none transition ' +
    'hover:bg-surface focus-visible:bg-surface focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<div class="flex flex-wrap items-center gap-2 border-b border-default px-6 py-2">
  <span
    class="mr-1 text-xs font-medium text-muted"
    title={'Text and host parameters are asked for when the automation runs; a host one is where every "on host" step runs. A fixed one is a variable set here. Use any of them as {{params.<name>}}.'}
  >
    Parameters
  </span>

  {#each ctx.params() as param, i (i)}
    <div class="flex items-center gap-0.5 rounded-lg border border-default bg-surface-inset py-0.5 pl-1 pr-0.5">
      <input
        bind:this={rowNameInputs[i]}
        value={param.name}
        oninput={(e) => ctx.updateParam(param.name, { name: e.currentTarget.value })}
        class="{chipField} w-24 font-mono"
        placeholder="name"
        aria-label="Parameter {i + 1} name"
        spellcheck="false"
      />
      <Select
        value={param.kind}
        onchange={(e: Event & { currentTarget: HTMLSelectElement }) =>
          ctx.updateParam(param.name, { kind: e.currentTarget.value as AutomationParamKindDto })}
        class="{chipField} text-muted"
        aria-label="Parameter {i + 1} kind"
      >
        <option value="text">text</option>
        <option value="host" disabled={hostTakenElsewhere(i)}>host</option>
        <option value="fixed">fixed</option>
      </Select>
      {#if param.kind === 'fixed'}
        <span class="text-xs text-faint">=</span>
        <input
          value={param.default ?? ''}
          oninput={(e) => ctx.updateParam(param.name, { value: e.currentTarget.value })}
          class="{chipField} w-28 font-mono"
          placeholder="value"
          aria-label="Parameter {i + 1} value"
          spellcheck="false"
        />
      {/if}
      <button
        type="button"
        class="grid h-6 w-6 shrink-0 place-items-center rounded text-faint transition hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        title="Remove parameter {param.name}"
        aria-label="Remove parameter {param.name}"
        onclick={() => ctx.removeParam(param.name)}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  {/each}

  <button
    type="button"
    class="flex items-center gap-1 rounded-lg border border-dashed border-default px-2.5 py-1 text-xs text-muted transition hover:border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    onclick={addParam}
  >
    <Icon name="plus" size={12} />
    Add parameter
  </button>

  {#if ctx.params().length === 0}
    <span class="text-xs text-faint">Values asked for when it runs (a host, a tag…), or fixed variables — used as {'{{params.<name>}}'}.</span>
  {/if}
</div>
