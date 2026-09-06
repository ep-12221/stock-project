import { describe, expect, it } from 'vitest';
import { parsePrice, parseQuantity, formatMoney, portfolioValue } from '../utils/money.js';
import { quote } from './trading-fixture.js';
describe('integer money and quantity input', () => {
  it.each([
    ['0.01', 1],
    ['10.01', 1001],
    ['0.29', 29],
    ['10.1', 1010],
    [' 10 ', 1000],
    ['100000.00', 10000000],
  ])('parses price %s exactly', (value, expected) => {
    expect(parsePrice(String(value))).toBe(expected);
  });
  it.each([
    '',
    '0',
    '-1',
    '+1',
    '1e2',
    'Infinity',
    'NaN',
    '1.001',
    '.01',
    '1.',
    '1,000',
    '100000.01',
    '999999999999999999999',
  ])('rejects price %s', (value) => expect(() => parsePrice(value)).toThrow());
  it.each([
    ['1', 1],
    ['100000', 100000],
    [' 12 ', 12],
  ])('parses quantity %s', (value, expected) =>
    expect(parseQuantity(String(value))).toBe(expected),
  );
  it.each(['', '0', '-1', '1.2', '1e2', '100001', '9007199254740992'])(
    'rejects quantity %s',
    (value) => expect(() => parseQuantity(value)).toThrow(),
  );
  it('formats cents and large aggregate values without floating-point rounding', () => {
    expect(formatMoney(1001)).toBe('10.01');
    expect(formatMoney(100000000)).toBe('1,000,000.00');
    expect(formatMoney(900719925474099301n)).toBe('9,007,199,254,740,993.01');
  });
  it('values total shares once, including frozen shares', () => {
    expect(
      portfolioValue(
        [{ symbol: 'SIM001', quantity: 10, frozenQuantity: 8, availableQuantity: 2 }],
        [quote()],
      ),
    ).toBe(10000n);
  });
});
