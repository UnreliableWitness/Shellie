import { describe, expect, it } from 'vitest';
import { vttToMarkdown } from './vtt';

describe('vttToMarkdown', () => {
  it('keeps voice tags and merges consecutive cues', () => {
    const md = vttToMarkdown(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>Hello there\n\n00:00:03.000 --> 00:00:05.000\n<v Alice>again\n\n00:01:10.000 --> 00:01:12.000\n<v Bob>Hi\n',
    );
    expect(md).toContain('## 00:00:01');
    expect(md).toContain('**Alice:** Hello there again');
    expect(md).toContain('## 00:01:10');
    expect(md).toContain('**Bob:** Hi');
  });

  it('handles cues without voice tags, settings, notes and overlapping duplicates', () => {
    const md = vttToMarkdown(
      [
        '﻿WEBVTT',
        '',
        'NOTE a comment',
        '',
        'STYLE',
        '::cue { color: red }',
        '',
        'cue-1',
        '00:00:01.000 --> 00:00:03.000 align:start position:0%',
        'Plain <c>line</c> <00:00:02.000>one',
        '',
        '00:00:02.000 --> 00:00:04.000',
        'Plain line one',
        '',
        '00:00:04.000 --> 00:00:06.000',
        'Second line',
        '',
      ].join('\r\n'),
    );
    expect(md.match(/Plain line one/g)).toHaveLength(1);
    expect(md).toContain('Second line');
    expect(md).not.toContain('NOTE');
    expect(md).not.toContain('color');
    expect(md).not.toContain('align');
    expect(md).not.toContain('cue-1');
    expect(md).not.toContain('**');
  });

  it('accepts mm:ss.mmm timestamps', () => {
    expect(
      vttToMarkdown('WEBVTT\n\n01:05.000 --> 01:07.000\n<v A>x\n'),
    ).toContain('## 00:01:05');
  });
});
