import { KeyedLock } from './KeyedLock';

describe('KeyedLock', () => {
  it('serializes work for the same key and allows other keys in parallel', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const work = (key: string, name: string, ms: number) =>
      lock.run(key, async () => {
        log.push(`start ${name}`);
        await new Promise(r => setTimeout(r, ms));
        log.push(`end ${name}`);
      });

    await Promise.all([work('a', 'a1', 30), work('a', 'a2', 1), work('b', 'b1', 1)]);
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'));
    expect(log.indexOf('start b1')).toBeLessThan(log.indexOf('end a1'));
  });

  it('releases the lock when work throws', async () => {
    const lock = new KeyedLock();
    await expect(lock.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(lock.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});
