import { describe, expect, it } from 'vitest';
import { connectReporter, reportConnectStage, withConnectProgress, withoutConnectProgress, type SshConnectStage } from './connectProgress.js';

describe('connect progress', () => {
  it('reaches the listener through awaits, and is silent without one', async () => {
    const heard: SshConnectStage[] = [];
    reportConnectStage({ stage: 'reach' });
    await withConnectProgress(
      (s) => heard.push(s),
      async () => {
        await Promise.resolve();
        reportConnectStage({ stage: 'reach' });
        await new Promise((r) => setTimeout(r, 1));
        connectReporter()({ stage: 'shell' });
      }
    );
    expect(heard).toEqual([{ stage: 'reach' }, { stage: 'shell' }]);
  });

  it("a jump host's own steps stay out of it", async () => {
    const heard: string[] = [];
    await withConnectProgress(
      (s) => heard.push(s.stage),
      async () => {
        reportConnectStage({ stage: 'jump', host: 'bastion' });
        await withoutConnectProgress(async () => reportConnectStage({ stage: 'signIn' }));
        reportConnectStage({ stage: 'reach' });
      }
    );
    expect(heard).toEqual(['jump', 'reach']);
  });
});
