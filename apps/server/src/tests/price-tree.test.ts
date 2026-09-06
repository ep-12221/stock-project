import { describe, expect, it } from 'vitest';
import { AvlPriceTree } from '../matching/avl-price-tree.js';
import { readConfig } from '../config.js';

function check(tree: AvlPriceTree<string>, model: Map<number, string>) {
  const sorted = [...model].sort(([a], [b]) => a - b);
  expect([...tree.entries()]).toEqual(sorted);
  expect([...tree.entries(true)]).toEqual([...sorted].reverse());
  expect(tree.size).toBe(model.size);
  expect(tree.minKey).toBe(sorted[0]?.[0] ?? null);
  expect(tree.maxKey).toBe(sorted.at(-1)?.[0] ?? null);
  tree.assertValid();
}

describe('AVL price index', () => {
  it.each([
    [30, 20, 10],
    [10, 20, 30],
    [30, 10, 20],
    [10, 30, 20],
  ])('balances insertion order %j', (...prices) => {
    const tree = new AvlPriceTree<string>();
    const model = new Map<number, string>();
    for (const price of prices) {
      tree.set(price, String(price));
      model.set(price, String(price));
      check(tree, model);
    }
    expect(tree.height).toBe(2);
  });

  it('updates a price without adding a node and deletes absent prices without changing state', () => {
    const tree = new AvlPriceTree<string>();
    tree.set(7, 'first');
    tree.set(7, 'replacement');
    expect(tree.get(7)).toBe('replacement');
    expect(tree.delete(99)).toBe(false);
    check(tree, new Map([[7, 'replacement']]));
    expect(tree.delete(7)).toBe(true);
    check(tree, new Map());
  });

  it('preserves order and AVL heights through randomized inserts and deletion of every price', () => {
    const tree = new AvlPriceTree<string>();
    const model = new Map<number, string>();
    let seed = 809;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 1200; i++) {
      const price = next() % 257;
      if (next() % 3 === 0) expect(tree.delete(price)).toBe(model.delete(price));
      else {
        tree.set(price, String(i));
        model.set(price, String(i));
      }
      check(tree, model);
    }
    for (const price of [...model.keys()]) {
      expect(tree.delete(price)).toBe(true);
      model.delete(price);
      check(tree, model);
    }
    expect(tree.height).toBe(0);
  });
});

describe('matching engine configuration', () => {
  it('defaults to the price tree and explicitly retains the array engine', () => {
    expect(readConfig({}).MATCHING_ENGINE).toBe('price-tree');
    expect(readConfig({ MATCHING_ENGINE: 'array' }).MATCHING_ENGINE).toBe('array');
  });
  it.each(['', 'tree', 'random'])('rejects unsupported engine %s', (value) => {
    expect(() => readConfig({ MATCHING_ENGINE: value })).toThrow();
  });
});
