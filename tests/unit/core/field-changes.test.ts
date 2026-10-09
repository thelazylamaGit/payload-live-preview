import { describe, expect, it } from 'vitest';
import { FieldChangeTracker } from '@core/field-changes';

function lexicalFields(reordered = false, text = 'One') {
  const ordered = <T extends object>(node: T): T =>
    reordered ? (Object.fromEntries(Object.entries(node).reverse()) as T) : node;
  const leaf = (value: string) => {
    const node = { type: 'text', version: 1, text: value, format: 0, style: '', detail: 0 };
    return ordered(node);
  };
  const paragraph = {
    type: 'paragraph',
    version: 1,
    format: '',
    children: [leaf(text), leaf('Two')],
  };
  const root = {
    type: 'root',
    version: 1,
    direction: null,
    children: [ordered(paragraph)],
  };
  return { content: { root: ordered(root) } };
}

describe('FieldChangeTracker', () => {
  it('ignores Lexical property insertion order during the first text edit', () => {
    const tracker = new FieldChangeTracker();
    tracker.diff(lexicalFields(), {}, true);
    const changes = tracker.diff(lexicalFields(true, 'Edited'), {}, true);
    expect([...changes.paths]).toEqual(['content.root.children.0.children.0.text']);
    expect(changes.structuralPaths.size).toBe(0);
  });

  it('reports no precise changes when only Lexical property order changes', () => {
    const tracker = new FieldChangeTracker();
    tracker.diff(lexicalFields(), {}, true);
    const changes = tracker.diff(lexicalFields(true), {}, true);
    expect(changes.paths.size).toBe(0);
    expect(changes.structuralPaths.size).toBe(0);
  });

  it.each(['format', 'metadata', 'children order', 'paragraph order', 'embedded block'])(
    'retains structural fallback for %s despite different property order',
    (edit) => {
      const tracker = new FieldChangeTracker();
      const before = lexicalFields();
      const after = lexicalFields(true);
      const paragraphs = after.content.root.children;
      const children = paragraphs[0]!.children as Record<string, unknown>[];
      if (edit === 'format') children[0]!['format'] = 1;
      if (edit === 'metadata') children[0]!['detail'] = 1;
      if (edit === 'children order') children.reverse();
      if (edit === 'paragraph order') {
        const secondBefore = lexicalFields(false, 'Other').content.root.children[0]!;
        const secondAfter = lexicalFields(true, 'Other').content.root.children[0]!;
        before.content.root.children.push(secondBefore);
        paragraphs.push(secondAfter);
        paragraphs.reverse();
      }
      if (edit === 'embedded block') {
        children[0]!['type'] = 'block';
        children[0]!['fields'] = { id: 'cta', blockType: 'cta' };
      }
      tracker.diff(before, {}, true);
      const changes = tracker.diff(after, {}, true);
      expect(changes.structuralPaths.size).toBeGreaterThan(0);
    },
  );

  it('reports every field on the first message and only differences afterwards', () => {
    const tracker = new FieldChangeTracker();
    expect([...tracker.diff({ a: 1, b: 'x' }, {}).changed].sort()).toEqual(['a', 'b']);
    expect([...tracker.diff({ a: 1, b: 'y' }, {}).changed]).toEqual(['b']);
    expect([...tracker.diff({ a: 1, b: 'y' }, {}).changed]).toEqual([]);
  });

  it('compares structurally, so a fresh object graph with equal content is unchanged', () => {
    const tracker = new FieldChangeTracker();
    tracker.diff({ rich: { root: { children: [{ text: 'a' }] } } }, {});
    expect(tracker.diff({ rich: { root: { children: [{ text: 'a' }] } } }, {}).changed.size).toBe(
      0,
    );
    expect([
      ...tracker.diff({ rich: { root: { children: [{ text: 'b' }] } } }, {}).changed,
    ]).toEqual(['rich']);
  });

  it('counts a removed field and a value without identity as changed', () => {
    const tracker = new FieldChangeTracker();
    tracker.diff({ a: 1, gone: 2 }, {});
    expect([...tracker.diff({ a: 1 }, {}).changed]).toEqual(['gone']);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    tracker.diff({ a: cyclic }, {});
    expect([...tracker.diff({ a: cyclic }, {}).changed]).toEqual(['a']);
  });

  it('invalidates the dependents of changed sources only', () => {
    const tracker = new FieldChangeTracker();
    const dependencies = { price: ['priceLabel'], currency: ['priceLabel', 'total'] };
    tracker.diff({ price: 1, currency: 'EUR' }, dependencies);
    const changes = tracker.diff({ price: 2, currency: 'EUR' }, dependencies);
    expect([...changes.changed]).toEqual(['price']);
    expect([...changes.invalidated]).toEqual(['priceLabel']);
  });

  it('forgets the baseline on reset', () => {
    const tracker = new FieldChangeTracker();
    tracker.diff({ a: 1 }, {});
    tracker.reset();
    expect([...tracker.diff({ a: 1 }, {}).changed]).toEqual(['a']);
  });

  it('keeps ordinary ID-less children arrays structural, even with text-shaped items', () => {
    const tracker = new FieldChangeTracker();
    const fields = (text: string) => ({ content: { children: [{ type: 'text', text }] } });
    tracker.diff(fields('One'), {}, true);
    const changes = tracker.diff(fields('Two'), {}, true);
    expect(changes.structuralPaths.has('content.children')).toBe(true);
  });

  it('does no path tracking without opt-in and forgets Lexical order history on reset', () => {
    const tracker = new FieldChangeTracker();
    const fields = (values: string[]) => ({
      content: { root: { type: 'root', children: values.map((text) => ({ type: 'text', text })) } },
    });
    expect(tracker.diff(fields(['One', 'Two']), {}).paths.size).toBe(0);
    tracker.diff(fields(['One', 'Two']), {}, true);
    tracker.reset();
    expect(tracker.diff(fields(['Two', 'One']), {}, true).baseline).toBe(true);
    const changes = tracker.diff(fields(['Edited', 'One']), {}, true);
    expect([...changes.paths]).toEqual(['content.root.children.0.text']);
    expect(changes.structuralPaths.size).toBe(0);
  });
});
