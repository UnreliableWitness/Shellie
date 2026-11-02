import { Settings16Regular } from '@fluentui/react-icons';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { ConfigSource } from '../../../shared/repoConfig';
import { IconButton } from '../ui/IconButton';
import { PopupMenu } from '../ui/PopupMenu';
import { useSettingsSearch } from './settingsSearch';

const CategoryContext = createContext('');

const SOURCE_LABEL: Record<ConfigSource, string> = {
  default: 'Default',
  file: 'From .shellie.yml',
  override: 'Modified by you',
};

/** A section of the settings tree; hidden while a search matches none of its rows. */
export function SettingsCategory({
  id,
  title,
  commands,
  children,
}: {
  id: string;
  title: string;
  /** Buttons next to the heading. */
  commands?: ReactNode;
  children: ReactNode;
}) {
  const search = useSettingsSearch();
  const { matching } = search.categoryCount(id);
  const hidden = search.query.trim() !== '' && matching === 0;
  return (
    <CategoryContext.Provider value={id}>
      <section id={id} className="section settings-category" hidden={hidden}>
        {commands ? (
          <div className="settings-category-head">
            <h2>{title}</h2>
            {commands}
          </div>
        ) : (
          <h2>{title}</h2>
        )}
        {children}
      </section>
    </CategoryContext.Provider>
  );
}

/** One setting, VS Code style: "Category: Title", description, control, source and a gear menu. */
export function SettingRow({
  id,
  category,
  title,
  description,
  keywords = [],
  modified = false,
  source = 'app',
  scope = 'user',
  onReset,
  extraMenu = [],
  children,
}: {
  id: string;
  category: string;
  title: string;
  description?: ReactNode;
  keywords?: string[];
  modified?: boolean;
  source?: ConfigSource | 'app';
  /** Which scope tab the row belongs to (used for "N more in …" hints). */
  scope?: string;
  onReset?: () => void;
  extraMenu?: { label: string; onClick: () => void }[];
  children: ReactNode;
}) {
  const search = useSettingsSearch();
  const categoryId = useContext(CategoryContext);
  const descText = typeof description === 'string' ? description : '';
  const texts = [title, descText, category, ...keywords];
  const textKey = texts.join('\u0000');
  const { register } = search;
  useEffect(
    () => register(id, scope, texts, categoryId),
    [register, id, scope, categoryId, textKey],
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  if (!search.matches(texts)) return null;
  const close = () => setOpen(false);
  return (
    <div
      id={id}
      className="setting-row"
      data-modified={modified ? 'true' : undefined}
    >
      <div className="setting-head">
        <div className="setting-title">
          <span className="setting-category">{category}: </span>
          {title}
        </div>
        <span ref={setAnchor} className="setting-gear">
          <IconButton
            label={`More actions for ${title}`}
            onClick={() => setOpen((o) => !o)}
          >
            <Settings16Regular />
          </IconButton>
        </span>
      </div>
      {description ? <div className="setting-desc">{description}</div> : null}
      <div className="setting-control">{children}</div>
      {source !== 'app' ? (
        <div className="setting-source">{SOURCE_LABEL[source]}</div>
      ) : null}
      <PopupMenu
        label={`Actions for ${title}`}
        anchor={anchor}
        open={open}
        onClose={close}
      >
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="menu-item"
          disabled={!onReset || !modified}
          onClick={() => {
            close();
            onReset?.();
          }}
        >
          Reset
        </button>
        {extraMenu.map((m) => (
          <button
            key={m.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            onClick={() => {
              close();
              m.onClick();
            }}
          >
            {m.label}
          </button>
        ))}
      </PopupMenu>
    </div>
  );
}
