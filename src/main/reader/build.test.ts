import { describe, expect, it } from 'vitest';
import { citedPaths, contentHash } from './build';

describe('citedPaths', () => {
  it('finds the pages and sources a text links to, by their brain path', () => {
    const body = [
      'See [orders](../wiki/subject-orders.md#rules), [again](../wiki/subject-orders.md)',
      'and [a mail][m], [a space](../sources/a%20mail.md).',
      '',
      '[m]: ../sources/mail.md "The mail"',
      '[angle]: <../wiki/with space.md>',
    ].join('\n');
    expect(citedPaths('reads/order-to-invoice.md', body).sort()).toEqual([
      'sources/a mail.md',
      'sources/mail.md',
      'wiki/subject-orders.md',
      'wiki/with space.md',
    ]);
  });

  it('resolves from where the text is', () => {
    expect(
      citedPaths('reads/letters/2026-11-10-a.md', '[p](../../wiki/a.md)'),
    ).toEqual(['wiki/a.md']);
  });

  it('leaves out everything that is not a page or source of the brain', () => {
    const body = [
      '[web](https://example.com/a.md) [mail](mailto:a@b.c) [abs](/wiki/a.md)',
      '[other read](other.md) [picture](../sources/files/scan.png)',
      '[out](../../../etc/passwd.md) [up](../wiki/../../secrets/a.md)',
      '```',
      '[in code](../wiki/code.md)',
      '```',
    ].join('\n');
    expect(citedPaths('reads/a.md', body)).toEqual([]);
  });
});

describe('contentHash', () => {
  it('is the same for the same value and differs for another', () => {
    expect(contentHash({ a: 1, b: 'x' })).toBe(contentHash({ a: 1, b: 'x' }));
    expect(contentHash({ a: 1, b: 'x' })).not.toBe(contentHash({ a: 2 }));
  });
});
