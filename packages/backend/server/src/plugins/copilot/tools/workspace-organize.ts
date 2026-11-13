import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DocOrganizer, DocWriter, TAG_COLORS } from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { type CopilotToolSet, defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('WorkspaceOrganizeTool');

type Deps = {
  ac: PermissionAccess;
  organizer: DocOrganizer;
  writer: DocWriter;
};

type Context = {
  userId: string;
  workspaceId: string;
};

const run = async (
  name: string,
  options: CopilotChatOptions,
  fn: (ctx: Context) => Promise<object>
) => {
  if (!options?.user || !options.workspace) {
    return toolError(`${name} Failed`, 'Missing user or workspace context');
  }
  try {
    return await fn({ userId: options.user, workspaceId: options.workspace });
  } catch (err: any) {
    logger.error(`${name} failed`, err);
    return toolError(`${name} Failed`, err.message);
  }
};

const need = <T>(value: T | undefined | null, field: string): T => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`"${field}" is required for this action`);
  }
  return value;
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Tools that let the agent read and change how a workspace is organized:
 * the doc list and trash, tags, collections, folders, favorites, journals,
 * per-doc settings and the workspace name.
 */
export function createWorkspaceOrganizeTools(
  { ac, organizer, writer }: Deps,
  options: CopilotChatOptions
): CopilotToolSet {
  const workspace = (ctx: Context) =>
    ac.user(ctx.userId).workspace(ctx.workspaceId);

  const readableDocs = async (ctx: Context) => {
    await workspace(ctx).assert('Workspace.Organize.Read');
    const docs = (await organizer.listDocs(ctx.workspaceId)).map(doc => ({
      ...doc,
      docId: doc.id,
    }));
    return (await workspace(ctx).docs(docs, 'Doc.Read')) ?? [];
  };

  return {
    doc_list: defineTool({
      description:
        'List docs in the workspace with their id, title, tag names, journal date and trash state. Use it to browse the workspace, find a doc by exact title, list docs with a tag, or see what is in the trash. For searching doc content use doc_search.',
      inputSchema: z.object({
        title_contains: z
          .string()
          .optional()
          .describe('Only docs whose title contains this text'),
        tag: z.string().optional().describe('Only docs with this tag name'),
        in_trash: z
          .boolean()
          .optional()
          .describe('true lists only trashed docs; default lists live docs'),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      execute: ({ title_contains, tag, in_trash, limit }) =>
        run('Doc List', options, async ctx => {
          const [docs, tags] = await Promise.all([
            readableDocs(ctx),
            organizer.listTags(ctx.workspaceId),
          ]);
          const tagName = new Map(tags.map(item => [item.id, item.name]));
          const query = title_contains?.toLowerCase();
          const tagQuery = tag?.toLowerCase();
          const items = docs
            .filter(doc => doc.trash === (in_trash ?? false))
            .map(doc => ({
              ...doc,
              tags: doc.tags.map(id => tagName.get(id) ?? id),
            }))
            .filter(doc => !query || doc.title.toLowerCase().includes(query))
            .filter(
              doc =>
                !tagQuery ||
                doc.tags.some(name => name.toLowerCase() === tagQuery)
            );
          return {
            total: items.length,
            docs: items.slice(0, limit ?? 200).map(doc => ({
              doc_id: doc.id,
              title: doc.title,
              tags: doc.tags,
              journal: doc.journal,
              created: doc.createDate
                ? new Date(doc.createDate).toISOString()
                : undefined,
            })),
          };
        }),
    }),

    doc_trash: defineTool({
      description:
        'Move a doc to the trash, or restore it from the trash. Trashed docs can be restored; permanently deleting docs is only possible by the user in the Trash page. Always confirm with the user before trashing.',
      inputSchema: z.object({
        doc_id: z.string(),
        action: z.enum(['trash', 'restore']),
      }),
      execute: ({ doc_id, action }) =>
        run('Doc Trash', options, async ctx => {
          await workspace(ctx)
            .doc(doc_id)
            .assert(action === 'trash' ? 'Doc.Trash' : 'Doc.Restore');
          await organizer.setDocTrash(
            ctx.workspaceId,
            doc_id,
            action === 'trash',
            ctx.userId
          );
          return {
            success: true,
            docId: doc_id,
            message:
              action === 'trash'
                ? 'Doc moved to the trash'
                : 'Doc restored from the trash',
          };
        }),
    }),

    tag_manage: defineTool({
      description:
        'Manage workspace tags. Actions: list (all tags), create (name, optional color), rename (tag_id, name), delete (tag_id; also removes it from every doc), add_to_doc / remove_from_doc (tag_id, doc_id). Use list first to get tag ids.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'create',
          'rename',
          'delete',
          'add_to_doc',
          'remove_from_doc',
        ]),
        tag_id: z.string().optional(),
        name: z.string().optional(),
        color: z.enum(TAG_COLORS).optional(),
        doc_id: z.string().optional(),
      }),
      execute: ({ action, tag_id, name, color, doc_id }) =>
        run('Tag', options, async ctx => {
          if (action === 'list') {
            await workspace(ctx).assert('Workspace.Organize.Read');
            const [tags, docs] = await Promise.all([
              organizer.listTags(ctx.workspaceId),
              organizer.listDocs(ctx.workspaceId),
            ]);
            return {
              tags: tags.map(tag => ({
                tag_id: tag.id,
                name: tag.name,
                docs: docs.filter(
                  doc => !doc.trash && doc.tags.includes(tag.id)
                ).length,
              })),
            };
          }
          if (action === 'add_to_doc' || action === 'remove_from_doc') {
            const docId = need(doc_id, 'doc_id');
            await workspace(ctx).doc(docId).assert('Doc.Update');
            await organizer.setDocTag(
              ctx.workspaceId,
              docId,
              need(tag_id, 'tag_id'),
              action === 'add_to_doc',
              ctx.userId
            );
            return { success: true, docId, message: `Tag ${action}` };
          }
          await workspace(ctx).assert('Workspace.Sync');
          if (action === 'create') {
            const tagName = need(name, 'name').trim();
            const existing = (await organizer.listTags(ctx.workspaceId)).find(
              tag => tag.name.toLowerCase() === tagName.toLowerCase()
            );
            if (existing) {
              return {
                success: true,
                tag_id: existing.id,
                message: `Tag "${existing.name}" already exists`,
              };
            }
            const id = await organizer.createTag(
              ctx.workspaceId,
              tagName,
              color,
              ctx.userId
            );
            return {
              success: true,
              tag_id: id,
              message: `Tag "${tagName}" created`,
            };
          }
          if (action === 'rename') {
            await organizer.renameTag(
              ctx.workspaceId,
              need(tag_id, 'tag_id'),
              need(name, 'name').trim(),
              ctx.userId
            );
            return { success: true, message: 'Tag renamed' };
          }
          await organizer.deleteTag(
            ctx.workspaceId,
            need(tag_id, 'tag_id'),
            ctx.userId
          );
          return { success: true, message: 'Tag deleted' };
        }),
    }),

    collection_manage: defineTool({
      description:
        'Manage collections (named groups of docs shown in the sidebar). Actions: list, create (name, optional doc_ids), rename (collection_id, name), delete (collection_id; docs are kept), add_docs / remove_docs (collection_id, doc_ids).',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'create',
          'rename',
          'delete',
          'add_docs',
          'remove_docs',
        ]),
        collection_id: z.string().optional(),
        name: z.string().optional(),
        doc_ids: z.array(z.string()).optional(),
      }),
      execute: ({ action, collection_id, name, doc_ids }) =>
        run('Collection', options, async ctx => {
          if (action === 'list') {
            await workspace(ctx).assert('Workspace.Organize.Read');
            const [collections, docs] = await Promise.all([
              organizer.listCollections(ctx.workspaceId),
              organizer.listDocs(ctx.workspaceId),
            ]);
            const title = new Map(docs.map(doc => [doc.id, doc.title]));
            return {
              collections: collections.map(collection => ({
                collection_id: collection.id,
                name: collection.name,
                docs: collection.allowList.map(id => ({
                  doc_id: id,
                  title: title.get(id) ?? '',
                })),
                filter_rules: collection.filters,
              })),
            };
          }
          await workspace(ctx).assert('Workspace.Sync');
          if (action === 'create') {
            const collectionName = need(name, 'name').trim();
            const id = await organizer.createCollection(
              ctx.workspaceId,
              collectionName,
              doc_ids ?? [],
              ctx.userId
            );
            return {
              success: true,
              collection_id: id,
              message: `Collection "${collectionName}" created`,
            };
          }
          const id = need(collection_id, 'collection_id');
          if (action === 'delete') {
            await organizer.deleteCollection(ctx.workspaceId, id, ctx.userId);
            return { success: true, message: 'Collection deleted' };
          }
          if (action === 'rename') {
            const collectionName = need(name, 'name').trim();
            await organizer.updateCollection(
              ctx.workspaceId,
              id,
              info => ({ ...info, name: collectionName }),
              ctx.userId
            );
            return { success: true, message: 'Collection renamed' };
          }
          const ids = need(doc_ids, 'doc_ids');
          await organizer.updateCollection(
            ctx.workspaceId,
            id,
            info => ({
              ...info,
              allowList:
                action === 'add_docs'
                  ? [...new Set([...info.allowList, ...ids])]
                  : info.allowList.filter((doc: string) => !ids.includes(doc)),
            }),
            ctx.userId
          );
          return { success: true, message: `Collection ${action}` };
        }),
    }),

    folder_manage: defineTool({
      description:
        'Manage folders in the sidebar "Organize" section. Actions: list (whole folder tree with item ids), create_folder (name, optional parent_folder_id for a subfolder), rename (folder_id, name), delete (folder_id; removes the folder and everything inside it from the tree, docs themselves are kept), add_doc / add_collection / add_tag (folder_id, target_id), remove_item (item_id from list).',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'create_folder',
          'rename',
          'delete',
          'add_doc',
          'add_collection',
          'add_tag',
          'remove_item',
        ]),
        folder_id: z.string().optional(),
        parent_folder_id: z.string().optional(),
        name: z.string().optional(),
        target_id: z
          .string()
          .optional()
          .describe('doc, collection or tag id to put in the folder'),
        item_id: z.string().optional(),
      }),
      execute: ({
        action,
        folder_id,
        parent_folder_id,
        name,
        target_id,
        item_id,
      }) =>
        run('Folder', options, async ctx => {
          if (action === 'list') {
            await workspace(ctx).assert('Workspace.Organize.Read');
            const [nodes, docs, tags, collections] = await Promise.all([
              organizer.listFolderNodes(ctx.workspaceId),
              organizer.listDocs(ctx.workspaceId),
              organizer.listTags(ctx.workspaceId),
              organizer.listCollections(ctx.workspaceId),
            ]);
            const label = new Map<string, string>([
              ...docs.map(doc => [`doc:${doc.id}`, doc.title] as const),
              ...tags.map(tag => [`tag:${tag.id}`, tag.name] as const),
              ...collections.map(
                item => [`collection:${item.id}`, item.name] as const
              ),
            ]);
            const build = (parentId: string | null): object[] =>
              nodes
                .filter(node => node.parentId === parentId)
                .sort((a, b) => a.index.localeCompare(b.index))
                .map(node =>
                  node.type === 'folder'
                    ? {
                        item_id: node.id,
                        type: 'folder',
                        name: node.data,
                        children: build(node.id),
                      }
                    : {
                        item_id: node.id,
                        type: node.type,
                        target_id: node.data,
                        name: label.get(`${node.type}:${node.data}`) ?? '',
                      }
                );
            return { folders: build(null) };
          }
          await workspace(ctx).assert('Workspace.Sync');
          if (action === 'create_folder') {
            const folderName = need(name, 'name').trim();
            const id = await organizer.createFolderNode(
              ctx.workspaceId,
              {
                parentId: parent_folder_id ?? null,
                type: 'folder',
                data: folderName,
              },
              ctx.userId
            );
            return {
              success: true,
              folder_id: id,
              message: `Folder "${folderName}" created`,
            };
          }
          if (action === 'rename') {
            await organizer.renameFolder(
              ctx.workspaceId,
              need(folder_id, 'folder_id'),
              need(name, 'name').trim(),
              ctx.userId
            );
            return { success: true, message: 'Folder renamed' };
          }
          if (action === 'delete' || action === 'remove_item') {
            const removed = await organizer.deleteFolderNode(
              ctx.workspaceId,
              action === 'delete'
                ? need(folder_id, 'folder_id')
                : need(item_id, 'item_id'),
              ctx.userId
            );
            return {
              success: true,
              message: `Removed ${removed} item(s) from the folder tree`,
            };
          }
          const type =
            action === 'add_doc'
              ? 'doc'
              : action === 'add_collection'
                ? 'collection'
                : 'tag';
          const id = await organizer.createFolderNode(
            ctx.workspaceId,
            {
              parentId: need(folder_id, 'folder_id'),
              type,
              data: need(target_id, 'target_id'),
            },
            ctx.userId
          );
          return { success: true, item_id: id, message: `Added ${type}` };
        }),
    }),

    favorite_manage: defineTool({
      description:
        "Manage the current user's favorites in the sidebar. Actions: list, add, remove. type is doc, collection, folder or tag; id is that item's id.",
      inputSchema: z.object({
        action: z.enum(['list', 'add', 'remove']),
        type: z.enum(['doc', 'collection', 'folder', 'tag']).optional(),
        id: z.string().optional(),
      }),
      execute: ({ action, type, id }) =>
        run('Favorite', options, async ctx => {
          await workspace(ctx).assert('Workspace.Organize.Read');
          if (action === 'list') {
            const [favorites, docs] = await Promise.all([
              organizer.listFavorites(ctx.workspaceId, ctx.userId),
              organizer.listDocs(ctx.workspaceId),
            ]);
            const title = new Map(docs.map(doc => [doc.id, doc.title]));
            return {
              favorites: favorites.map(item => ({
                ...item,
                title: item.type === 'doc' ? title.get(item.id) : undefined,
              })),
            };
          }
          await organizer.setFavorite(
            ctx.workspaceId,
            ctx.userId,
            need(type, 'type'),
            need(id, 'id'),
            action === 'add'
          );
          return {
            success: true,
            message: action === 'add' ? 'Added to favorites' : 'Removed',
          };
        }),
    }),

    journal_open: defineTool({
      description:
        "Get the journal doc for a date (YYYY-MM-DD, default today), creating it if it does not exist. Returns its doc_id; use doc_append to write into it. Journals are AFFiNE's daily notes.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
      execute: ({ date }) =>
        run('Journal', options, async ctx => {
          const day = date ?? today();
          const docs = await readableDocs(ctx);
          const existing = docs.find(doc => !doc.trash && doc.journal === day);
          if (existing) {
            return {
              success: true,
              docId: existing.id,
              created: false,
              message: `Journal ${day} already exists`,
            };
          }
          await workspace(ctx).assert('Workspace.CreateDoc');
          const { docId } = await writer.createDoc(
            ctx.workspaceId,
            day,
            '',
            ctx.userId
          );
          await organizer.setDocProperties(
            ctx.workspaceId,
            docId,
            { journal: day },
            ctx.userId
          );
          await organizer.setDocCreateDate(
            ctx.workspaceId,
            docId,
            new Date(`${day}T12:00:00Z`).getTime(),
            ctx.userId
          );
          return {
            success: true,
            docId,
            created: true,
            message: `Journal ${day} created`,
          };
        }),
    }),

    doc_settings: defineTool({
      description:
        'Read or change a doc\'s settings: primary_mode ("page" document or "edgeless" whiteboard), page_width ("standard" or "fullWidth") and is_template (use the doc as a template). Pass only the fields to change; pass none to read them.',
      inputSchema: z.object({
        doc_id: z.string(),
        primary_mode: z.enum(['page', 'edgeless']).optional(),
        page_width: z.enum(['standard', 'fullWidth']).optional(),
        is_template: z.boolean().optional(),
      }),
      execute: ({ doc_id, primary_mode, page_width, is_template }) =>
        run('Doc Settings', options, async ctx => {
          const changes = {
            primaryMode: primary_mode,
            pageWidth: page_width,
            isTemplate: is_template,
          };
          if (Object.values(changes).some(value => value !== undefined)) {
            await workspace(ctx).doc(doc_id).assert('Doc.Update');
            await organizer.setDocProperties(
              ctx.workspaceId,
              doc_id,
              changes,
              ctx.userId
            );
          } else {
            await workspace(ctx).doc(doc_id).assert('Doc.Read');
          }
          const settings = await organizer.getDocSettings(
            ctx.workspaceId,
            doc_id
          );
          return {
            success: true,
            docId: doc_id,
            primary_mode: settings.primaryMode ?? 'page',
            page_width: settings.pageWidth ?? 'standard',
            is_template: settings.isTemplate === true,
            journal: settings.journal || undefined,
          };
        }),
    }),

    workspace_rename: defineTool({
      description: 'Rename the current workspace.',
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: ({ name }) =>
        run('Workspace Rename', options, async ctx => {
          await workspace(ctx).assert('Workspace.Settings.Update');
          const workspaceName = name.replace(/[\r\n]+/g, ' ').trim();
          await organizer.renameWorkspace(
            ctx.workspaceId,
            workspaceName,
            ctx.userId
          );
          return {
            success: true,
            name: workspaceName,
            message: `Workspace renamed to "${workspaceName}"`,
          };
        }),
    }),
  };
}
