import type { Connection } from '../../shared/types';
import { useStore } from '../store';

/** A project (connection) for tests of what belongs to one, such as dreams. */
export const projectOf = (id: string, project = 'Shellie'): Connection => ({
  id,
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project,
  user: 'D',
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops',
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
});

/** The id of the project `activateProject` makes the active one. */
export const PROJECT_ID = 'p1';

/** Puts one project in the store and makes it the active one; returns it. */
export function activateProject(id = PROJECT_ID): Connection {
  const connection = projectOf(id);
  useStore.setState((s) => ({
    connections: [...s.connections.filter((c) => c.id !== id), connection],
    connectionId: id,
  }));
  return connection;
}
