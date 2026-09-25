import { describe, expect, it } from 'vitest';
import { explainRdpError } from './rdpEmbedded';

const ironError = (kind: number, backtrace = ''): unknown => ({ kind: () => kind, backtrace: () => backtrace });

describe('explainRdpError', () => {
  it("prefers the gateway's own account of the handshake", () => {
    expect(explainRdpError(ironError(4), 'could not reach 10.0.0.5:3389: connect ECONNREFUSED')).toBe(
      'Could not reach 10.0.0.5:3389: connect ECONNREFUSED.'
    );
  });

  it("says what IronRDP's error kinds mean", () => {
    expect(explainRdpError(ironError(1))).toBe('The username or password was not accepted.');
    expect(explainRdpError(ironError(2))).toBe('The username or password was not accepted.');
    expect(explainRdpError(ironError(3))).toMatch(/refused this user/);
    expect(explainRdpError(ironError(6))).toMatch(/Remote Desktop app/);
    expect(explainRdpError(ironError(5))).toBe('Could not reach the server.');
  });

  it('falls back to the first line of a general error, or a plain message', () => {
    expect(explainRdpError(ironError(0, 'something broke\n  at frame'))).toBe('something broke');
    expect(explainRdpError(new Error('boom'))).toBe('boom');
    expect(explainRdpError(undefined)).toBe('The connection failed.');
  });
});
