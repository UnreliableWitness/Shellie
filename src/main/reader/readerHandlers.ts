import { z } from 'zod';
import type { Handlers } from '../../shared/ipc';
import { ReaderMarkSchema, type ReaderStatus } from '../../shared/reader';
import type { ReaderSync } from './ReaderSync';

export type ReaderChannels =
  | 'reader:status'
  | 'reader:connect'
  | 'reader:disconnect'
  | 'reader:link'
  | 'reader:send'
  | 'reader:marks';

export type ReaderHandlerDeps = Pick<
  ReaderSync,
  | 'status'
  | 'connect'
  | 'disconnect'
  | 'link'
  | 'sendNow'
  | 'marks'
  | 'knownMarks'
>;

const NOT_CONNECTED: ReaderStatus = {
  connected: false,
  url: null,
  lastPush: null,
  refused: false,
};
const MarksSchema = z.record(z.string(), ReaderMarkSchema);

/** Settings › User › Phone and the Read view's marks. Without a reader (tests that don't care) nothing is connected. */
export function createReaderHandlers(
  reader: ReaderHandlerDeps | undefined,
): Pick<Handlers, ReaderChannels> {
  const need = () => {
    if (!reader) throw new Error('The phone reader is not available');
    return reader;
  };
  return {
    'reader:status': async () => reader?.status() ?? NOT_CONNECTED,
    'reader:connect': async (address, invite) =>
      need().connect(String(address), String(invite)),
    'reader:disconnect': async (anyway) => need().disconnect(anyway === true),
    'reader:link': async () => reader?.link() ?? null,
    'reader:send': async () => need().sendNow(),
    'reader:marks': async (brainId, marks) => {
      const parsed = MarksSchema.safeParse(marks);
      const local = parsed.success ? parsed.data : {};
      return reader ? reader.marks(String(brainId), local) : local;
    },
  };
}
