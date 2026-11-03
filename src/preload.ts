import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_PREFIX, type ShellieApi } from './shared/ipc';
import { TELEMETRY_CHANNEL } from './shared/telemetry';
import { titleBarKind } from './shared/titleBar';
import { errorMessage } from './shared/errors';

const api: ShellieApi = {
  invoke: async (channel, ...args) => {
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (e) {
      // Electron wraps handler errors as "Error invoking remote method 'x': Error: <message>"; hand the renderer the plain message.
      const message = errorMessage(e);
      throw new Error(
        message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          '',
        ),
      );
    }
  },
  on: (event, listener) => {
    const channel = `${EVENT_PREFIX}${event}`;
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) =>
      listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  track: (message) => ipcRenderer.send(TELEMETRY_CHANNEL, message),
  titleBar: titleBarKind(process.platform),
};

contextBridge.exposeInMainWorld('shellie', api);
