/** The four steps from adding a source to reading its pages, behind the composer's `?`. */
export const STEPS: { title: string; text: string }[] = [
  {
    title: '1 · You add',
    text: 'Drop a file or paste text. It is stored untouched under sources/.',
  },
  {
    title: '2 · Capture (auto)',
    text: 'The agent reads the source and writes or updates wiki pages.',
  },
  {
    title: '3 · Lint (auto)',
    text: 'After each successful capture: checks for broken links, contradictions and gaps.',
  },
  { title: '4 · Read', text: 'New and changed pages get a blue dot in Read.' },
];
