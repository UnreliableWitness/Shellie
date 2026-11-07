import { describe, expect, it } from 'vitest';
import { xmlRoot, xmlToMarkdown } from './xml';

describe('xmlToMarkdown', () => {
  it('wraps the file in an xml code block', () => {
    expect(xmlToMarkdown('<a><b/></a>\n')).toBe('```xml\n<a><b/></a>\n```\n');
  });

  it('drops a byte order mark', () => {
    expect(xmlToMarkdown('﻿<a/>')).toBe('```xml\n<a/>\n```\n');
  });

  it('uses a longer fence than any backtick run inside', () => {
    const md = xmlToMarkdown('<a><![CDATA[\n```\nx\n````\n]]></a>');
    expect(md.startsWith('`````xml\n')).toBe(true);
    expect(md.endsWith('\n`````\n')).toBe(true);
  });

  it('gives empty markdown for a blank file', () => {
    expect(xmlToMarkdown('﻿  \n')).toBe('');
  });
});

describe('xmlRoot', () => {
  it('finds the root element past the declaration, comments and doctype', () => {
    expect(
      xmlRoot(
        '<?xml version="1.0"?>\n<!-- c --><!DOCTYPE note>\n<ns:config a="1"><b/></ns:config>',
      ),
    ).toBe('ns:config');
  });

  it('is null without an element', () => {
    expect(xmlRoot('just text')).toBeNull();
  });
});
