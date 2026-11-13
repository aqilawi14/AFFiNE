import { Injectable, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import {
  applyUpdate,
  Array as YArray,
  Doc as YDoc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
} from 'yjs';

import { EventBus } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';

export type FolderNodeType = 'folder' | 'doc' | 'collection' | 'tag';
export type FavoriteType = 'doc' | 'collection' | 'folder' | 'tag';

export interface DocListItem {
  id: string;
  title: string;
  tags: string[];
  trash: boolean;
  createDate?: number;
  journal?: string;
}

export interface TagInfo {
  id: string;
  name: string;
  color: string;
}

export interface CollectionInfo {
  id: string;
  name: string;
  allowList: string[];
  filters: number;
}

export interface FolderNode {
  id: string;
  parentId: string | null;
  type: FolderNodeType;
  data: string;
  index: string;
}

export interface DocSettings {
  primaryMode?: 'page' | 'edgeless';
  pageWidth?: 'standard' | 'fullWidth';
  isTemplate?: boolean;
}

const DELETED = '$$DELETED';

export const TAG_COLORS = [
  'red',
  'magenta',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'grey',
] as const;

/**
 * Reads and writes workspace organization data (doc list, trash, tags,
 * collections, folders, favorites, journals and doc settings) directly in the
 * workspace's yjs docs, using the same layout as the frontend.
 */
@Injectable()
export class DocOrganizer {
  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus
  ) {}

  // ========== docs ==========

  async listDocs(workspaceId: string): Promise<DocListItem[]> {
    const root = await this.load(workspaceId, workspaceId);
    const journals = await this.readTable(
      workspaceId,
      `db$${workspaceId}$docProperties`
    );
    return pages(root).map(page => {
      const id = String(page.get('id'));
      const journal = journals.get(id)?.journal;
      return {
        id,
        title: String(page.get('title') ?? ''),
        tags: toStrings(page.get('tags')),
        trash: page.get('trash') === true,
        createDate: numberOrUndefined(page.get('createDate')),
        journal: typeof journal === 'string' && journal ? journal : undefined,
      };
    });
  }

  async setDocTrash(
    workspaceId: string,
    docId: string,
    trash: boolean,
    editorId?: string
  ) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      const page = findPage(doc, docId);
      if (trash) {
        page.set('trash', true);
        page.set('trashDate', Date.now());
      } else {
        page.set('trash', false);
        page.delete('trashDate');
      }
    });
  }

  async setDocCreateDate(
    workspaceId: string,
    docId: string,
    createDate: number,
    editorId?: string
  ) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      findPage(doc, docId).set('createDate', createDate);
    });
  }

  async renameWorkspace(workspaceId: string, name: string, editorId?: string) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      doc.getMap('meta').set('name', name);
    });
  }

  // ========== tags ==========

  async listTags(workspaceId: string): Promise<TagInfo[]> {
    const root = await this.load(workspaceId, workspaceId);
    return tagOptions(root, false).map(option => ({
      id: String(field(option, 'id')),
      name: String(field(option, 'value') ?? ''),
      color: String(field(option, 'color') ?? ''),
    }));
  }

  async createTag(
    workspaceId: string,
    name: string,
    color: (typeof TAG_COLORS)[number] | undefined,
    editorId?: string
  ) {
    const id = nanoid();
    const picked =
      color ?? TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      const option = new YMap<unknown>();
      tagOptions(doc, true).push([option]);
      option.set('id', id);
      option.set('value', name);
      option.set('color', `var(--affine-palette-line-${picked})`);
      option.set('createDate', Date.now());
      option.set('updateDate', Date.now());
    });
    return id;
  }

  async renameTag(
    workspaceId: string,
    tagId: string,
    name: string,
    editorId?: string
  ) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      const options = tagOptions(doc, false);
      const index = options.findIndex(item => field(item, 'id') === tagId);
      if (index < 0) throw new NotFoundException(`Tag ${tagId} not found`);
      const option = options[index];
      if (option instanceof YMap) {
        option.set('value', name);
        option.set('updateDate', Date.now());
      } else {
        const array = tagOptionArray(doc, true);
        array.delete(index, 1);
        array.insert(index, [
          { ...(option as object), value: name, updateDate: Date.now() },
        ]);
      }
    });
  }

  async deleteTag(workspaceId: string, tagId: string, editorId?: string) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      const array = tagOptionArray(doc, false);
      if (array) {
        for (let i = array.length - 1; i >= 0; i--) {
          if (field(array.get(i), 'id') === tagId) array.delete(i, 1);
        }
      }
      for (const page of pages(doc)) {
        const tags = page.get('tags');
        if (tags instanceof YArray) {
          for (let i = tags.length - 1; i >= 0; i--) {
            if (tags.get(i) === tagId) tags.delete(i, 1);
          }
        }
      }
    });
  }

  async setDocTag(
    workspaceId: string,
    docId: string,
    tagId: string,
    attached: boolean,
    editorId?: string
  ) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      if (!tagOptions(doc, false).some(item => field(item, 'id') === tagId)) {
        throw new NotFoundException(`Tag ${tagId} not found`);
      }
      const page = findPage(doc, docId);
      let tags = page.get('tags');
      if (!(tags instanceof YArray)) {
        const existing = toStrings(tags);
        tags = new YArray<string>();
        page.set('tags', tags);
        (tags as YArray<string>).push(existing);
      }
      const array = tags as YArray<string>;
      const index = array.toArray().indexOf(tagId);
      if (attached && index < 0) array.push([tagId]);
      if (!attached && index >= 0) array.delete(index, 1);
    });
  }

  // ========== collections ==========

  async listCollections(workspaceId: string): Promise<CollectionInfo[]> {
    const root = await this.load(workspaceId, workspaceId);
    const collections = root.getMap('setting').get('collections');
    if (!(collections instanceof YArray)) return [];
    return collections.toArray().map(item => {
      const value = toPlain(item) as Record<string, any>;
      return {
        id: String(value.id),
        name: String(value.name ?? ''),
        allowList: toStrings(value.allowList),
        filters: Array.isArray(value.rules?.filters)
          ? value.rules.filters.length
          : 0,
      };
    });
  }

  async createCollection(
    workspaceId: string,
    name: string,
    docIds: string[],
    editorId?: string
  ) {
    const id = nanoid();
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      collectionArray(doc).push([
        { id, name, rules: { filters: [] }, allowList: [...new Set(docIds)] },
      ]);
    });
    return id;
  }

  async updateCollection(
    workspaceId: string,
    collectionId: string,
    update: (info: Record<string, any>) => Record<string, any>,
    editorId?: string
  ) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      const array = collectionArray(doc);
      const index = array
        .toArray()
        .findIndex(item => field(item, 'id') === collectionId);
      if (index < 0) {
        throw new NotFoundException(`Collection ${collectionId} not found`);
      }
      const current = toPlain(array.get(index)) as Record<string, any>;
      array.delete(index, 1);
      array.insert(index, [
        update({
          ...current,
          rules: current.rules ?? { filters: [] },
          allowList: toStrings(current.allowList),
        }),
      ]);
    });
  }

  async deleteCollection(
    workspaceId: string,
    collectionId: string,
    editorId?: string
  ) {
    await this.mutate(workspaceId, workspaceId, editorId, doc => {
      const array = collectionArray(doc);
      const index = array
        .toArray()
        .findIndex(item => field(item, 'id') === collectionId);
      if (index < 0) {
        throw new NotFoundException(`Collection ${collectionId} not found`);
      }
      array.delete(index, 1);
    });
  }

  // ========== folders ==========

  async listFolderNodes(workspaceId: string): Promise<FolderNode[]> {
    const rows = await this.readTable(workspaceId, folderTable(workspaceId));
    return [...rows.values()].map(row => ({
      id: String(row.id),
      parentId: typeof row.parentId === 'string' ? row.parentId : null,
      type: row.type as FolderNodeType,
      data: String(row.data ?? ''),
      index: String(row.index ?? ''),
    }));
  }

  async createFolderNode(
    workspaceId: string,
    node: { parentId: string | null; type: FolderNodeType; data: string },
    editorId?: string
  ) {
    const nodes = await this.listFolderNodes(workspaceId);
    if (node.parentId && !nodes.some(item => item.id === node.parentId)) {
      throw new NotFoundException(`Folder ${node.parentId} not found`);
    }
    const siblings = nodes.filter(
      item => (item.parentId ?? null) === node.parentId
    );
    const id = nanoid();
    await this.upsertRow(
      workspaceId,
      folderTable(workspaceId),
      id,
      {
        id,
        parentId: node.parentId ?? undefined,
        type: node.type,
        data: node.data,
        index: indexAfter(siblings.map(item => item.index)),
      },
      editorId
    );
    return id;
  }

  async renameFolder(
    workspaceId: string,
    folderId: string,
    name: string,
    editorId?: string
  ) {
    const nodes = await this.listFolderNodes(workspaceId);
    if (!nodes.some(item => item.id === folderId && item.type === 'folder')) {
      throw new NotFoundException(`Folder ${folderId} not found`);
    }
    await this.upsertRow(
      workspaceId,
      folderTable(workspaceId),
      folderId,
      { data: name },
      editorId
    );
  }

  /**
   * Removes a folder node; for a folder, all of its descendants are removed
   * too. Docs, collections and tags themselves are not touched.
   */
  async deleteFolderNode(
    workspaceId: string,
    nodeId: string,
    editorId?: string
  ) {
    const nodes = await this.listFolderNodes(workspaceId);
    if (!nodes.some(item => item.id === nodeId)) {
      throw new NotFoundException(`Folder item ${nodeId} not found`);
    }
    const toDelete = new Set([nodeId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of nodes) {
        if (
          item.parentId &&
          toDelete.has(item.parentId) &&
          !toDelete.has(item.id)
        ) {
          toDelete.add(item.id);
          grew = true;
        }
      }
    }
    await this.mutate(workspaceId, folderTable(workspaceId), editorId, doc => {
      for (const id of toDelete) markDeleted(doc, id);
    });
    return toDelete.size;
  }

  // ========== favorites ==========

  async listFavorites(workspaceId: string, userId: string) {
    const rows = await this.readTable(
      workspaceId,
      favoriteTable(workspaceId, userId)
    );
    return [...rows.values()]
      .sort((a, b) => String(a.index).localeCompare(String(b.index)))
      .map(row => {
        const key = String(row.key);
        const split = key.indexOf(':');
        return {
          type: key.slice(0, split) as FavoriteType,
          id: key.slice(split + 1),
        };
      });
  }

  async setFavorite(
    workspaceId: string,
    userId: string,
    type: FavoriteType,
    id: string,
    favorite: boolean
  ) {
    const table = favoriteTable(workspaceId, userId);
    const key = `${type}:${id}`;
    if (favorite) {
      const rows = await this.readTable(workspaceId, table);
      if (rows.has(key)) return;
      await this.upsertRow(
        workspaceId,
        table,
        key,
        {
          key,
          index: indexAfter([...rows.values()].map(row => String(row.index))),
        },
        userId
      );
    } else {
      await this.mutate(workspaceId, table, userId, doc => {
        markDeleted(doc, key);
      });
    }
  }

  // ========== doc settings ==========

  async getDocSettings(workspaceId: string, docId: string) {
    const rows = await this.readTable(
      workspaceId,
      `db$${workspaceId}$docProperties`
    );
    return rows.get(docId) ?? {};
  }

  async setDocProperties(
    workspaceId: string,
    docId: string,
    props: Record<string, string | boolean | undefined>,
    editorId?: string
  ) {
    await this.upsertRow(
      workspaceId,
      `db$${workspaceId}$docProperties`,
      docId,
      { id: docId, ...props },
      editorId
    );
  }

  // ========== yjs helpers ==========

  private async load(workspaceId: string, docId: string) {
    const doc = new YDoc({ guid: docId });
    const existing = await this.storage.getDoc(workspaceId, docId);
    if (existing?.bin) applyUpdate(doc, existing.bin);
    return doc;
  }

  private async mutate<T>(
    workspaceId: string,
    docId: string,
    editorId: string | undefined,
    fn: (doc: YDoc) => T
  ): Promise<T> {
    const doc = await this.load(workspaceId, docId);
    const before = encodeStateVector(doc);
    let result!: T;
    doc.transact(() => {
      result = fn(doc);
    });
    const update = encodeStateAsUpdate(doc, before);
    // an empty update is 2 bytes (no structs, no delete set)
    if (update.byteLength > 2) {
      const timestamp = await this.storage.pushDocUpdates(
        workspaceId,
        docId,
        [update],
        editorId
      );
      this.event.emit('doc.updates.pushed', {
        spaceType: 'workspace',
        spaceId: workspaceId,
        docId,
        updates: [update],
        timestamp,
        editor: editorId,
      });
    }
    return result;
  }

  private async readTable(workspaceId: string, docId: string) {
    const doc = await this.load(workspaceId, docId);
    const rows = new Map<string, Record<string, unknown>>();
    for (const [key, value] of doc.share) {
      const record = doc.getMap(key);
      if (!value || record.size === 0 || record.get(DELETED) === true) {
        continue;
      }
      rows.set(key, record.toJSON());
    }
    return rows;
  }

  private async upsertRow(
    workspaceId: string,
    docId: string,
    key: string,
    data: Record<string, unknown>,
    editorId?: string
  ) {
    await this.mutate(workspaceId, docId, editorId, doc => {
      const record = doc.getMap<unknown>(key);
      for (const [field, value] of Object.entries(data)) {
        if (value === undefined) continue;
        record.set(field, value);
      }
      record.delete(DELETED);
    });
  }
}

function folderTable(workspaceId: string) {
  return `db$${workspaceId}$folders`;
}

function favoriteTable(workspaceId: string, userId: string) {
  return `userdata$${userId}$${workspaceId}$favorite`;
}

function markDeleted(doc: YDoc, key: string) {
  if (!doc.share.has(key)) return;
  const record = doc.getMap<unknown>(key);
  // copy the keys first: deleting while iterating the live map skips entries
  for (const field of Array.from(record.keys())) {
    if (field !== 'id' && field !== 'key') record.delete(field);
  }
  record.set(DELETED, true);
}

function pages(doc: YDoc): YMap<unknown>[] {
  const list = doc.getMap('meta').get('pages');
  if (!(list instanceof YArray)) return [];
  return list
    .toArray()
    .filter((page): page is YMap<unknown> => page instanceof YMap);
}

function findPage(doc: YDoc, docId: string) {
  const page = pages(doc).find(item => item.get('id') === docId);
  if (!page) throw new NotFoundException(`Doc ${docId} not found`);
  return page;
}

function tagOptionArray(doc: YDoc, create: true): YArray<unknown>;
function tagOptionArray(
  doc: YDoc,
  create: boolean
): YArray<unknown> | undefined;
function tagOptionArray(doc: YDoc, create: boolean) {
  const meta = doc.getMap<unknown>('meta');
  let properties = meta.get('properties');
  if (!(properties instanceof YMap)) {
    if (!create) return undefined;
    properties = new YMap<unknown>();
    meta.set('properties', properties);
  }
  let tags = (properties as YMap<unknown>).get('tags');
  if (!(tags instanceof YMap)) {
    if (!create) return undefined;
    tags = new YMap<unknown>();
    (properties as YMap<unknown>).set('tags', tags);
  }
  let options = (tags as YMap<unknown>).get('options');
  if (!(options instanceof YArray)) {
    if (!create) return undefined;
    options = new YArray<unknown>();
    (tags as YMap<unknown>).set('options', options);
  }
  return options as YArray<unknown>;
}

function tagOptions(doc: YDoc, create: true): YArray<unknown>;
function tagOptions(doc: YDoc, create: false): unknown[];
function tagOptions(doc: YDoc, create: boolean) {
  const array = tagOptionArray(doc, create);
  if (create) return array;
  return array?.toArray() ?? [];
}

function collectionArray(doc: YDoc) {
  const setting = doc.getMap<unknown>('setting');
  let collections = setting.get('collections');
  if (!(collections instanceof YArray)) {
    collections = new YArray<unknown>();
    setting.set('collections', collections);
  }
  return collections as YArray<unknown>;
}

function field(item: unknown, key: string): unknown {
  if (item instanceof YMap) return item.get(key);
  if (item && typeof item === 'object') {
    return (item as Record<string, unknown>)[key];
  }
  return undefined;
}

function toPlain(value: unknown): unknown {
  if (value instanceof YMap || value instanceof YArray) return value.toJSON();
  return value;
}

function toStrings(value: unknown): string[] {
  const plain = toPlain(value);
  return Array.isArray(plain)
    ? plain.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberOrUndefined(value: unknown) {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Returns a fractional index key that sorts after every given key. Appending
 * a non-zero digit keeps the key valid for the frontend's fractional-indexing.
 */
function indexAfter(keys: string[]) {
  const max = keys.filter(Boolean).sort().at(-1);
  return max ? `${max}V` : 'a0';
}
