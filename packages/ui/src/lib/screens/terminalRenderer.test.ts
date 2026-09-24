import { describe, expect, it } from 'vitest';
import { writable } from 'svelte/store';
import type { ITerminalAddon } from '@xterm/xterm';
import { followGpuPref, type GpuAddon } from './terminalRenderer';

class FakeAddon implements GpuAddon {
  disposed = false;
  private lossListeners: (() => void)[] = [];
  activate(): void {}
  dispose(): void {
    this.disposed = true;
  }
  onContextLoss(listener: () => void): void {
    this.lossListeners.push(listener);
  }
  loseContext(): void {
    for (const l of this.lossListeners) l();
  }
}

function harness(opts: { webgl2?: boolean } = {}) {
  const loaded: ITerminalAddon[] = [];
  const made: FakeAddon[] = [];
  const term = {
    loadAddon(addon: ITerminalAddon): void {
      if (opts.webgl2 === false) throw new Error('WebGL2 not supported');
      loaded.push(addon);
    }
  };
  const load = async (): Promise<GpuAddon> => {
    const addon = new FakeAddon();
    made.push(addon);
    return addon;
  };
  return { term, loaded, made, load };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('followGpuPref', () => {
  it('loads the WebGL addon while the pref is on', async () => {
    const { term, loaded, load } = harness();
    followGpuPref(term, writable(true), load);
    await settle();
    expect(loaded).toHaveLength(1);
  });

  it('leaves the DOM renderer alone while the pref is off', async () => {
    const { term, loaded, load } = harness();
    followGpuPref(term, writable(false), load);
    await settle();
    expect(loaded).toHaveLength(0);
  });

  it('follows the pref live, both ways', async () => {
    const { term, made, load } = harness();
    const pref = writable(true);
    followGpuPref(term, pref, load);
    await settle();
    pref.set(false);
    expect(made[0].disposed).toBe(true);
    pref.set(true);
    await settle();
    expect(made).toHaveLength(2);
    expect(made[1].disposed).toBe(false);
  });

  it('drops a load that resolves after the pref was switched off again', async () => {
    const { term, loaded, made, load } = harness();
    const pref = writable(true);
    followGpuPref(term, pref, load);
    pref.set(false);
    await settle();
    expect(loaded).toHaveLength(0);
    expect(made[0].disposed).toBe(true);
  });

  it('stays on the DOM renderer without WebGL2', async () => {
    const { term, made, load } = harness({ webgl2: false });
    followGpuPref(term, writable(true), load);
    await settle();
    expect(made[0].disposed).toBe(true);
  });

  it('falls back to the DOM renderer when the context is lost', async () => {
    const { term, made, load } = harness();
    followGpuPref(term, writable(true), load);
    await settle();
    made[0].loseContext();
    expect(made[0].disposed).toBe(true);
  });

  it('disposes the addon with the terminal', async () => {
    const { term, made, load } = harness();
    const stop = followGpuPref(term, writable(true), load);
    await settle();
    stop();
    expect(made[0].disposed).toBe(true);
  });
});
