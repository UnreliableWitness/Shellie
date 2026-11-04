import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { drawioToMarkdown } from './drawio';

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;

const file = (...pages: string[]) =>
  `<mxfile host="app.diagrams.net">${pages
    .map((p, i) => `<diagram id="d${i}" name="Page ${i + 1}">${p}</diagram>`)
    .join('')}</mxfile>`;

const compress = (xml: string) =>
  zlib.deflateRawSync(encodeURIComponent(xml)).toString('base64');

const TWO_NODES = model(
  '<mxCell id="a" value="Web app" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>' +
    '<mxCell id="b" value="Database" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>' +
    '<mxCell id="e" value="reads" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>',
);

describe('drawioToMarkdown', () => {
  it('turns shapes and a labelled edge into a mermaid flowchart and a label list', () => {
    const r = drawioToMarkdown(file(TWO_NODES));
    expect(r.markdown).toContain('## Page 1');
    expect(r.markdown).toContain('```mermaid\nflowchart TD');
    expect(r.markdown).toContain('n1["Web app"]');
    expect(r.markdown).toContain('n2["Database"]');
    expect(r.markdown).toContain('n1 -->|"reads"| n2');
    expect(r.markdown).toContain('- Web app\n- Database\n- reads');
    expect(r.warnings).toEqual([]);
  });

  it('reads the compressed form the same way', () => {
    expect(drawioToMarkdown(file(compress(TWO_NODES)))).toEqual(
      drawioToMarkdown(file(TWO_NODES)),
    );
  });

  it('reduces HTML labels to text and escapes quotes', () => {
    const r = drawioToMarkdown(
      file(
        model(
          '<mxCell id="a" value="&lt;b&gt;Order&lt;/b&gt;&lt;br&gt;service&amp;nbsp;&quot;v2&quot;" style="html=1;" vertex="1" parent="1"/>',
        ),
      ),
    );
    expect(r.markdown).toContain('n1["Order service #quot;v2#quot;"]');
    expect(r.markdown).toContain('- Order service "v2"');
    expect(r.markdown).not.toContain('<b>');
  });

  it('turns a container into a subgraph', () => {
    const r = drawioToMarkdown(
      file(
        model(
          '<mxCell id="g" value="Azure" style="swimlane;" vertex="1" parent="1"/>' +
            '<mxCell id="a" value="API" vertex="1" parent="g"/>' +
            '<mxCell id="b" value="Queue" vertex="1" parent="g"/>',
        ),
      ),
    );
    expect(r.markdown).toContain(
      'subgraph n1["Azure"]\n    n2["API"]\n    n3["Queue"]\n  end',
    );
  });

  it('keeps labels of an object wrapper and of labels drawn on edges', () => {
    const r = drawioToMarkdown(
      file(
        model(
          '<UserObject label="Gateway" id="a"><mxCell vertex="1" parent="1"/></UserObject>' +
            '<mxCell id="b" value="Backend" vertex="1" parent="1"/>' +
            '<mxCell id="e" edge="1" parent="1" source="a" target="b"/>' +
            '<mxCell id="l" value="https" style="edgeLabel;" vertex="1" parent="e"/>',
        ),
      ),
    );
    expect(r.markdown).toContain('n1["Gateway"]');
    expect(r.markdown).toContain('n1 -->|"https"| n2');
    expect(r.markdown).not.toContain('["https"]');
  });

  it('skips empty shapes and pages', () => {
    const r = drawioToMarkdown(
      file(
        model('<mxCell id="x" vertex="1" parent="1"/>'),
        model('<mxCell id="a" value="Only" vertex="1" parent="1"/>'),
      ),
    );
    expect(r.markdown).not.toContain('## Page 1');
    expect(r.markdown).toContain('## Page 2');
    expect(r.markdown).not.toContain('[" "]');
  });

  it('warns instead of throwing on an empty diagram', () => {
    const r = drawioToMarkdown(file(model('')));
    expect(r.warnings).toEqual(['no readable shapes or text']);
    expect(r.markdown).toContain('no readable shapes or text');
    expect(drawioToMarkdown('not xml').warnings).toHaveLength(1);
  });
});
