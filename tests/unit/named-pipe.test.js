const { aggregateTargets } = require('../../src/main/named-pipe');

describe('aggregateTargets', () => {
  it('lone caller returns its own target after timeout', async () => {
    const pipeName = `ContextHelper-test-${Date.now()}-${Math.random()}`;
    const result = await aggregateTargets({
      pipeName,
      myTarget: 'C:\\one.txt',
      waitMs: 100,
    });
    expect(result.role).toBe('leader');
    expect(result.targets).toEqual(['C:\\one.txt']);
  });

  it('two concurrent callers aggregate into one leader', async () => {
    const pipeName = `ContextHelper-test-${Date.now()}-${Math.random()}`;
    const [a, b] = await Promise.all([
      aggregateTargets({ pipeName, myTarget: 'A', waitMs: 300 }),
      new Promise((r) => setTimeout(r, 50)).then(() =>
        aggregateTargets({ pipeName, myTarget: 'B', waitMs: 300 }),
      ),
    ]);
    const leaders = [a, b].filter((x) => x.role === 'leader');
    const followers = [a, b].filter((x) => x.role === 'follower');
    expect(leaders).toHaveLength(1);
    expect(followers).toHaveLength(1);
    expect(leaders[0].targets.sort()).toEqual(['A', 'B']);
    expect(followers[0].targets).toEqual([]);
  });

  it('three concurrent callers all aggregate', async () => {
    const pipeName = `ContextHelper-test-${Date.now()}-${Math.random()}`;
    const results = await Promise.all([
      aggregateTargets({ pipeName, myTarget: 'A', waitMs: 400 }),
      new Promise((r) => setTimeout(r, 30)).then(() =>
        aggregateTargets({ pipeName, myTarget: 'B', waitMs: 400 }),
      ),
      new Promise((r) => setTimeout(r, 60)).then(() =>
        aggregateTargets({ pipeName, myTarget: 'C', waitMs: 400 }),
      ),
    ]);
    const leader = results.find((r) => r.role === 'leader');
    expect(leader).toBeDefined();
    expect(leader.targets.sort()).toEqual(['A', 'B', 'C']);
  });
});
