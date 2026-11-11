import { scratchDbName } from './scratch-db';

describe('scratchDbName (doc 16 C-4)', () => {
  const local = {} as NodeJS.ProcessEnv;
  const ci = { CI: 'true' } as NodeJS.ProcessEnv;

  it('accepts *_test databases everywhere', () => {
    expect(scratchDbName('postgresql://ci:ci@localhost:5432/veetrax_ci_test', ci)).toBe('veetrax_ci_test');
    expect(scratchDbName('postgresql://ci:ci@localhost:5432/veetrax_etms_test?schema=public', local)).toBe('veetrax_etms_test');
  });

  it('never veetracer; veetrax_assess only outside CI; nothing else', () => {
    expect(scratchDbName('postgresql://u:p@127.0.0.1:5432/veetracer', local)).toBeNull();
    expect(scratchDbName('postgresql://u:p@127.0.0.1:5432/veetrax_assess', local)).toBe('veetrax_assess');
    expect(scratchDbName('postgresql://u:p@127.0.0.1:5432/veetrax_assess', ci)).toBeNull();
    expect(scratchDbName('postgresql://u:p@127.0.0.1:5432/ci', ci)).toBeNull();
    expect(scratchDbName('postgresql://u:p@127.0.0.1:5432/test_veetracer', local)).toBeNull();
    expect(scratchDbName('', local)).toBeNull();
    expect(scratchDbName('not a url', local)).toBeNull();
  });
});
