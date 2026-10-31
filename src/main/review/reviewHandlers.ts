// src/main/review/reviewHandlers.ts
import { z } from 'zod';
import type { Handlers } from '../../shared/ipc';
import {
  NewReviewCommentSchema,
  ReviewFileRefSchema,
  ReviewScopeSchema,
} from '../../shared/review';
import type { Task } from '../../shared/types';
import { parseDocsTarget } from '../../shared/workspaces';
import type { DocsWatcher } from '../docs/DocsWatcher';
import { watchableWorkspace } from '../workspaces/existing';
import type { GitDirWatcher } from './GitDirWatcher';
import type { ReviewService } from './ReviewService';

type ReviewChannels =
  | 'review:files'
  | 'review:file'
  | 'review:state'
  | 'review:setViewed'
  | 'review:addComment'
  | 'review:updateComment'
  | 'review:deleteComment'
  | 'review:markSent'
  | 'review:summary'
  | 'review:discard'
  | 'review:watch';

export type ReviewHandlerDeps = {
  taskById: (id: string) => Task;
  review: ReviewService;
  docsWatcher: DocsWatcher;
  gitDirWatcher: GitDirWatcher;
};

const PatchSchema = z.object({
  text: z.string().min(1).max(20000).optional(),
  status: z.enum(['open', 'resolved']).optional(),
});
const Id = z.string().min(1).max(200);

export function createReviewHandlers(
  d: ReviewHandlerDeps,
): Pick<Handlers, ReviewChannels> {
  const task = (id: string) => d.taskById(Id.parse(id));
  return {
    'review:files': async (taskId, scope) =>
      d.review.files(task(taskId), ReviewScopeSchema.parse(scope)),
    'review:file': async (taskId, workspaceId, file, scope) =>
      d.review.file(
        task(taskId),
        Id.parse(workspaceId),
        ReviewFileRefSchema.parse(file),
        ReviewScopeSchema.parse(scope),
      ),
    'review:state': async (taskId) => d.review.state(task(taskId)),
    'review:setViewed': async (taskId, key, hash) =>
      d.review.setViewed(
        task(taskId),
        z.string().min(1).max(4096).parse(key),
        z.string().max(80).nullable().parse(hash),
      ),
    'review:addComment': async (taskId, input) =>
      d.review.addComment(task(taskId), NewReviewCommentSchema.parse(input)),
    'review:updateComment': async (taskId, id, patch) =>
      d.review.updateComment(
        task(taskId),
        Id.parse(id),
        PatchSchema.parse(patch),
      ),
    'review:deleteComment': async (taskId, id) =>
      d.review.deleteComment(task(taskId), Id.parse(id)),
    'review:markSent': async (taskId, ids) =>
      d.review.markSent(task(taskId), z.array(Id).max(500).parse(ids)),
    'review:summary': async (taskId) => d.review.summary(task(taskId)),
    'review:discard': async (taskId, workspaceId, path, scope) =>
      d.review.discard(
        task(taskId),
        Id.parse(workspaceId),
        z.string().min(1).max(4096).parse(path),
        ReviewScopeSchema.parse(scope),
      ),
    'review:watch': async (target, on) => {
      if (!on) {
        d.docsWatcher.stop(target);
        d.gitDirWatcher.stop(target);
        return { live: false };
      }
      const { taskId, workspaceId } = parseDocsTarget(target);
      const ws = watchableWorkspace(task(taskId), workspaceId);
      if (!ws) return { live: false };
      const files = d.docsWatcher.start(target, ws.worktreePath);
      const gitDir = await d.gitDirWatcher.start(target, ws.worktreePath);
      return { live: files && gitDir };
    },
  };
}
