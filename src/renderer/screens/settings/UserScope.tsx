import { Fragment, type ReactNode } from 'react';
import { AgentsSection } from '../../components/AgentsSection';
import { BudgetSection } from '../../components/BudgetSection';
import { ConnectionsSection } from '../../components/ConnectionsSection';
import { CostSection } from '../../components/CostSection';
import { CostServerSection } from '../../components/CostServerSection';
import { EditorSection } from '../../components/EditorSection';
import { TimeSection } from '../../components/TimeSection';
import { AboutCategory } from './AboutCategory';
import { AppearanceCategory } from './AppearanceCategory';
import { SecretsCategory } from './SecretsCategory';

export type SettingsCategoryInfo = { id: string; title: string };

/** The User scope's categories, in tree order. Each renders its own `<section id>` and rows. */
export const USER_CATEGORIES: SettingsCategoryInfo[] = [
  { id: 'ado', title: 'Connections' },
  { id: 'secrets', title: 'Secrets' },
  { id: 'editor', title: 'Editor' },
  { id: 'terminals', title: 'Agents and terminals' },
  { id: 'cost', title: 'AI cost and invoicing' },
  { id: 'time', title: 'Time tracking' },
  { id: 'budgets', title: 'Budgets' },
  { id: 'cost-server', title: 'Cost server' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'about', title: 'About' },
];

const SECTIONS: Record<string, () => ReactNode> = {
  ado: () => <ConnectionsSection />,
  secrets: () => <SecretsCategory />,
  editor: () => <EditorSection />,
  terminals: () => <AgentsSection />,
  cost: () => <CostSection />,
  time: () => <TimeSection />,
  budgets: () => <BudgetSection />,
  'cost-server': () => <CostServerSection />,
  appearance: () => <AppearanceCategory />,
  about: () => <AboutCategory />,
};

/** The app-wide settings, as rows; each category keeps its `id` for deep links and the tree. */
export function UserScope() {
  return (
    <>
      {USER_CATEGORIES.map((c) => (
        <Fragment key={c.id}>{SECTIONS[c.id]()}</Fragment>
      ))}
    </>
  );
}
