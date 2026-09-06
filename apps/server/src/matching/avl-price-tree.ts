import { invariant } from './checked.js';

interface Node<T> {
  key: number;
  value: T;
  height: number;
  left: Node<T> | null;
  right: Node<T> | null;
}
const height = <T>(node: Node<T> | null): number => node?.height ?? 0;
function refresh<T>(node: Node<T>): Node<T> {
  node.height = 1 + Math.max(height(node.left), height(node.right));
  return node;
}
function rotateLeft<T>(node: Node<T>): Node<T> {
  const next = node.right!;
  node.right = next.left;
  next.left = refresh(node);
  return refresh(next);
}
function rotateRight<T>(node: Node<T>): Node<T> {
  const next = node.left!;
  node.left = next.right;
  next.right = refresh(node);
  return refresh(next);
}
function balance<T>(node: Node<T>): Node<T> {
  refresh(node);
  const difference = height(node.left) - height(node.right);
  if (difference > 1) {
    if (height(node.left!.left) < height(node.left!.right)) node.left = rotateLeft(node.left!);
    return rotateRight(node);
  }
  if (difference < -1) {
    if (height(node.right!.right) < height(node.right!.left)) node.right = rotateRight(node.right!);
    return rotateLeft(node);
  }
  return node;
}
function extreme<T>(node: Node<T> | null, descending: boolean): Node<T> | null {
  if (!node) return null;
  while (descending ? node.right : node.left) node = (descending ? node.right : node.left)!;
  return node;
}

/** One node per occupied price; no scan or re-sort on insertion/removal. */
export class AvlPriceTree<T> {
  private root: Node<T> | null = null;
  private count = 0;
  private minimum: number | null = null;
  private maximum: number | null = null;

  get size() {
    return this.count;
  }
  get height() {
    return height(this.root);
  }
  get minKey() {
    return this.minimum;
  }
  get maxKey() {
    return this.maximum;
  }

  get(key: number): T | undefined {
    let node = this.root;
    while (node) {
      if (key === node.key) return node.value;
      node = key < node.key ? node.left : node.right;
    }
    return undefined;
  }

  set(key: number, value: T): void {
    const insert = (node: Node<T> | null): Node<T> => {
      if (!node) {
        this.count++;
        return { key, value, height: 1, left: null, right: null };
      }
      if (key === node.key) {
        node.value = value;
        return node;
      }
      if (key < node.key) node.left = insert(node.left);
      else node.right = insert(node.right);
      return balance(node);
    };
    this.root = insert(this.root);
    if (this.minimum === null || key < this.minimum) this.minimum = key;
    if (this.maximum === null || key > this.maximum) this.maximum = key;
  }

  delete(key: number): boolean {
    let removed = false;
    const erase = (node: Node<T> | null, target: number): Node<T> | null => {
      if (!node) return null;
      if (target < node.key) node.left = erase(node.left, target);
      else if (target > node.key) node.right = erase(node.right, target);
      else {
        removed = true;
        if (!node.left) return node.right;
        if (!node.right) return node.left;
        const successor = extreme(node.right, false)!;
        node.key = successor.key;
        node.value = successor.value;
        node.right = erase(node.right, successor.key);
      }
      return balance(node);
    };
    this.root = erase(this.root, key);
    if (removed) {
      this.count--;
      if (key === this.minimum) this.minimum = extreme(this.root, false)?.key ?? null;
      if (key === this.maximum) this.maximum = extreme(this.root, true)?.key ?? null;
    }
    return removed;
  }

  *entries(descending = false): IterableIterator<[number, T]> {
    const stack: Node<T>[] = [];
    let node = this.root;
    while (node || stack.length) {
      while (node) {
        stack.push(node);
        node = descending ? node.right : node.left;
      }
      node = stack.pop()!;
      yield [node.key, node.value];
      node = descending ? node.left : node.right;
    }
  }

  /** Full structural audit for tests/diagnostics; deliberately outside the command path. */
  assertValid(): void {
    let count = 0;
    const visit = (node: Node<T> | null, low: number, high: number): number => {
      if (!node) return 0;
      invariant(Number.isSafeInteger(node.key) && node.key > low && node.key < high);
      const left = visit(node.left, low, node.key);
      const right = visit(node.right, node.key, high);
      invariant(Math.abs(left - right) <= 1 && node.height === Math.max(left, right) + 1);
      count++;
      return node.height;
    };
    visit(this.root, -Infinity, Infinity);
    invariant(count === this.count);
    invariant(this.minimum === (extreme(this.root, false)?.key ?? null));
    invariant(this.maximum === (extreme(this.root, true)?.key ?? null));
  }
}
