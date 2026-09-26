import { describe, expect, it } from 'vitest';
import { commandErrorFrom } from '$lib/bindings';

describe('commandErrorFrom', () => {
  it("unwraps the handler's message from Electron's rejected invoke", () => {
    const e = new Error("Error invoking remote method 'rdp_embedded_open': Error: 1Password: could not read secret");
    expect(commandErrorFrom(e)).toEqual({ message: '1Password: could not read secret' });
  });

  it('keeps messages over several lines', () => {
    const e = new Error("Error invoking remote method 'x': Error: first\nsecond");
    expect(commandErrorFrom(e)).toEqual({ message: 'first\nsecond' });
  });

  it('takes the plain { message } the test stubs reject with', () => {
    expect(commandErrorFrom({ message: 'stub said no' })).toEqual({ message: 'stub said no' });
  });

  it('leaves other errors to be thrown (a missing bridge is a bug, not a failed command)', () => {
    expect(commandErrorFrom(new Error('bsshClient is not defined'))).toBeUndefined();
    expect(commandErrorFrom('nope')).toBeUndefined();
  });
});
