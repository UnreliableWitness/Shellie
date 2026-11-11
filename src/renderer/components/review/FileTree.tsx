import {
  ArrowUndo16Regular,
  ChevronDown12Regular,
  ChevronRight12Regular,
  Delete16Regular,
} from '@fluentui/react-icons';
import { type ReactNode, useMemo, useState } from 'react';
import {
  isGenerated,
  type ReviewFile,
  type ReviewRepo,
  viewedKey,
} from '../../../shared/review';
import { RepoMark } from '../RepoMark';
import {
  buildTree,
  dirKey,
  treeFiles,
  type TreeDir,
} from '../../review/fileTree';
import { viewedIn } from '../../review/repoGroups';
import { plural } from '../../format';

export type FileRef = { workspaceId: string; path: string };
const STATUS_LABEL = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
} as const;
const split = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0
    ? { dir: '', name: p }
    : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
};

/** What discarding a file does to it: a new file (not on the scope's base side) is deleted. */
export const discardKind = (file: Pick<ReviewFile, 'status'>) =>
  file.status === 'A' ? 'delete' : 'discard';

const indent = (depth: number) => ({ paddingLeft: 12 + depth * 14 });

function Row({
  file,
  depth,
  selected,
  viewedHash,
  comments,
  onSelect,
  onViewed,
  onDiscard,
}: {
  file: ReviewFile;
  /** Set in the tree: the folder depth to indent by, and no folder after the name. */
  depth?: number;
  selected: boolean;
  viewedHash: string | undefined;
  comments: number;
  onSelect: () => void;
  onViewed: (on: boolean) => void;
  onDiscard?: () => void;
}) {
  const { dir, name } = split(file.path);
  const del = discardKind(file) === 'delete';
  const viewed = viewedHash === file.hash;
  const changedSince = viewedHash !== undefined && !viewed;
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      className={`review-file${selected ? ' selected' : ''}`}
      style={depth === undefined ? undefined : indent(depth)}
      onClick={onSelect}
    >
      <span
        className={`review-status review-status-${file.status}`}
        title={STATUS_LABEL[file.status]}
      >
        {file.status}
      </span>
      <span
        className="review-name"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <span>{name}</span>
        {dir && depth === undefined && (
          <span className="muted small"> {dir}</span>
        )}
        {changedSince && (
          <span className="tag tag-warn review-changed">
            Changed since viewed
          </span>
        )}
        {file.secret && (
          <span
            className="tag tag-warn review-changed"
            title="A stored secret appears in the added lines"
          >
            Secret
          </span>
        )}
      </span>
      {comments > 0 && (
        <span
          className="small review-count"
          aria-label={plural(comments, 'comment')}
        >
          {comments}
        </span>
      )}
      <span className="small mono review-stat">
        {file.binary ? (
          'bin'
        ) : (
          <>
            <span className="review-plus">+{file.added}</span>{' '}
            <span className="review-minus">−{file.removed}</span>
          </>
        )}
      </span>
      {onDiscard && (
        <button
          type="button"
          className="ibtn review-discard"
          aria-label={`${del ? 'Delete file' : 'Discard changes to'} ${file.path}`}
          title={del ? 'Delete file' : 'Discard changes'}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard();
          }}
        >
          {del ? (
            <Delete16Regular aria-hidden="true" />
          ) : (
            <ArrowUndo16Regular aria-hidden="true" />
          )}
        </button>
      )}
      <input
        type="checkbox"
        aria-label={`Viewed ${file.path}`}
        checked={viewed}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onViewed(e.target.checked)}
      />
    </div>
  );
}

/** A folder row and, unless folded, what it holds. */
function Dir({
  dir,
  depth,
  workspaceId,
  collapsed,
  viewedCount,
  comments,
  onToggle,
  row,
}: {
  dir: TreeDir;
  depth: number;
  workspaceId: string;
  collapsed: string[];
  viewedCount: (files: ReviewFile[]) => number;
  comments: (files: ReviewFile[]) => number;
  onToggle: (key: string) => void;
  row: (f: ReviewFile, depth: number) => ReactNode;
}) {
  const key = dirKey(workspaceId, dir.path);
  const expanded = !collapsed.includes(key);
  const all = treeFiles(dir);
  const seen = viewedCount(all);
  const notes = comments(all);
  return (
    <div role="group" aria-label={dir.path}>
      <div
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={false}
        className="review-dir"
        style={indent(depth)}
        title={dir.path}
        onClick={() => onToggle(key)}
      >
        {expanded ? (
          <ChevronDown12Regular aria-hidden="true" />
        ) : (
          <ChevronRight12Regular aria-hidden="true" />
        )}
        <span className="review-name">{dir.name}</span>
        {notes > 0 && (
          <span
            className="small review-count"
            aria-label={`${plural(notes, 'comment')} in ${dir.path}`}
          >
            {notes}
          </span>
        )}
        <span
          className="small muted mono"
          aria-label={`${seen} of ${all.length} viewed`}
        >
          {`${seen}/${all.length}`}
        </span>
      </div>
      {expanded && (
        <Level
          dir={dir}
          depth={depth + 1}
          workspaceId={workspaceId}
          collapsed={collapsed}
          viewedCount={viewedCount}
          comments={comments}
          onToggle={onToggle}
          row={row}
        />
      )}
    </div>
  );
}

/** A folder's subfolders, then its files. */
function Level(props: Parameters<typeof Dir>[0]) {
  const { dir, depth, row } = props;
  return (
    <>
      {dir.dirs.map((d) => (
        <Dir key={d.path} {...props} dir={d} depth={depth} />
      ))}
      {dir.files.map((f) => row(f, depth))}
    </>
  );
}

/** A repo's group header in a multi-repo task: name and viewed count, then what the group holds. */
function RepoHeader({
  repo,
  color,
  folded,
  viewedCount,
  comments,
  dropped,
  onToggle,
}: {
  repo: ReviewRepo;
  color: number | null;
  folded: boolean;
  viewedCount: number;
  comments: number;
  /** Finish would remove this repo without a push. */
  dropped: boolean;
  onToggle: () => void;
}) {
  const empty = repo.files.length === 0 && !repo.error;
  const added = repo.files.reduce((n, f) => n + f.added, 0);
  const removed = repo.files.reduce((n, f) => n + f.removed, 0);
  const allViewed = viewedCount === repo.files.length;
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-expanded={empty ? undefined : !folded}
      aria-label={repo.name}
      className={`review-repo-head${empty ? ' no-changes' : ''}`}
      onClick={empty ? undefined : onToggle}
    >
      <div className="review-repo-line">
        {empty ? (
          <span />
        ) : folded ? (
          <ChevronRight12Regular aria-hidden="true" />
        ) : (
          <ChevronDown12Regular aria-hidden="true" />
        )}
        {color === null ? <span /> : <RepoMark color={color} shape="bar" />}
        <span className="review-repo-name">{repo.name}</span>
        {!empty && !repo.error && (
          <span
            className={`small mono ${allViewed ? 'review-plus' : 'muted'}`}
            aria-label={`${viewedCount} of ${repo.files.length} viewed in ${repo.name}`}
          >
            {`${viewedCount}/${repo.files.length}`}
          </span>
        )}
      </div>
      {empty && (
        <div className="review-repo-stats small muted">
          {dropped ? 'No changes · not in Finish' : 'No changes'}
        </div>
      )}
      {!empty && !repo.error && (
        <div className="review-repo-stats small muted">
          <span>{plural(repo.files.length, 'file')}</span>
          <span className="mono">
            <span className="review-plus">+{added}</span>{' '}
            <span className="review-minus">−{removed}</span>
          </span>
          {comments > 0 && <span>{plural(comments, 'comment')}</span>}
          {repo.uncommitted > 0 && (
            <span className="review-uncommitted">{`● ${repo.uncommitted} uncommitted`}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Changed files per repo, as a folder tree or a flat list; generated files (lock files, dist, the repo's review.collapse) folded away. */
export function FileTree({
  repos,
  grouped = repos.length > 1,
  colorOf = () => null,
  folded = () => false,
  dropsAtFinish = () => false,
  onToggleRepo = () => {},
  view,
  selected,
  viewed,
  collapsed,
  commentCount,
  onSelect,
  onViewed,
  onToggleDir,
  onDiscard,
}: {
  repos: ReviewRepo[];
  /** Show a header per repo: the task has more than one, even when the list is narrowed to one. */
  grouped?: boolean;
  colorOf?: (workspaceId: string) => number | null;
  folded?: (repo: ReviewRepo) => boolean;
  dropsAtFinish?: (repo: ReviewRepo) => boolean;
  onToggleRepo?: (repo: ReviewRepo) => void;
  view: 'tree' | 'list';
  selected: FileRef | null;
  viewed: Record<string, string>;
  /** Folded folders, as `dirKey` keys. */
  collapsed: string[];
  commentCount: (ref: FileRef) => number;
  onSelect: (ref: FileRef) => void;
  onViewed: (repo: ReviewRepo, file: ReviewFile, on: boolean) => void;
  onToggleDir: (key: string) => void;
  /** Offers a discard action on each file row; left out where discarding does not apply (a commit). */
  onDiscard?: (repo: ReviewRepo, file: ReviewFile) => void;
}) {
  const [openGenerated, setOpenGenerated] = useState<Record<string, boolean>>(
    {},
  );
  // Each repo's files split into normal and generated, with their folder trees.
  const groups = useMemo(
    () =>
      new Map(
        repos.map((r) => {
          const normal = r.files.filter(
            (f) => !isGenerated(f.path, r.collapse),
          );
          const generated = r.files.filter((f) =>
            isGenerated(f.path, r.collapse),
          );
          return [
            r.workspaceId,
            {
              normal: { list: normal, tree: buildTree(normal) },
              generated: { list: generated, tree: buildTree(generated) },
            },
          ] as const;
        }),
      ),
    [repos],
  );
  return (
    <div role="tree" aria-label="Changed files" className="review-tree">
      {repos.map((r) => {
        const { normal, generated } = groups.get(r.workspaceId)!;
        const ref = (f: ReviewFile) => ({
          workspaceId: r.workspaceId,
          path: f.path,
        });
        const row = (f: ReviewFile, depth?: number) => (
          <Row
            key={f.path}
            file={f}
            depth={depth}
            selected={
              selected?.workspaceId === r.workspaceId &&
              selected.path === f.path
            }
            viewedHash={viewed[viewedKey(r.workspaceId, f.path)]}
            comments={commentCount(ref(f))}
            onSelect={() => onSelect(ref(f))}
            onViewed={(on) => onViewed(r, f, on)}
            onDiscard={onDiscard && (() => onDiscard(r, f))}
          />
        );
        const files = ({ list, tree }: { list: ReviewFile[]; tree: TreeDir }) =>
          view === 'list' ? (
            list.map((f) => row(f))
          ) : (
            <Level
              dir={tree}
              depth={0}
              workspaceId={r.workspaceId}
              collapsed={collapsed}
              viewedCount={(fs) =>
                fs.filter(
                  (f) => viewed[viewedKey(r.workspaceId, f.path)] === f.hash,
                ).length
              }
              comments={(fs) =>
                fs.reduce((n, f) => n + commentCount(ref(f)), 0)
              }
              onToggle={onToggleDir}
              row={row}
            />
          );
        const isFolded = grouped && folded(r);
        return (
          <div
            key={r.workspaceId}
            role="group"
            aria-label={r.name}
            className="review-repo"
          >
            {grouped && (
              <RepoHeader
                repo={r}
                color={colorOf(r.workspaceId)}
                folded={isFolded}
                viewedCount={viewedIn(r, viewed)}
                comments={r.files.reduce((n, f) => n + commentCount(ref(f)), 0)}
                dropped={dropsAtFinish(r)}
                onToggle={() => onToggleRepo(r)}
              />
            )}
            {r.error && (
              <div role="alert" className="review-repo-error small">
                {r.error}
              </div>
            )}
            {!isFolded && files(normal)}
            {!isFolded && generated.list.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm review-generated"
                  aria-expanded={Boolean(openGenerated[r.workspaceId])}
                  onClick={() =>
                    setOpenGenerated({
                      ...openGenerated,
                      [r.workspaceId]: !openGenerated[r.workspaceId],
                    })
                  }
                >
                  {`Generated (${generated.list.length})`}
                </button>
                {openGenerated[r.workspaceId] && files(generated)}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
