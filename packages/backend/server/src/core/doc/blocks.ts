import { Injectable, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import {
  applyUpdate,
  Array as YArray,
  Doc as YDoc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
  Text as YText,
} from 'yjs';

import { EventBus } from '../../base';
import { createDocWithMarkdown } from '../../native';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';

// ========== database ==========

export const DATABASE_COLUMN_TYPES = [
  'rich-text',
  'select',
  'multi-select',
  'number',
  'checkbox',
  'date',
  'progress',
  'link',
] as const;
export type DatabaseColumnType = (typeof DATABASE_COLUMN_TYPES)[number];

export interface DatabaseColumnInput {
  name: string;
  type: DatabaseColumnType;
  options?: string[];
}

/** Cell values keyed by column name; the row title uses the key "title". */
export type DatabaseRowInput = Record<string, unknown>;

export interface DatabaseInfo {
  databaseId: string;
  title: string;
  views: { id: string; name: string; mode: string }[];
  columns: { id: string; name: string; type: string; options?: string[] }[];
  rows: { rowId: string; title: string; values: Record<string, unknown> }[];
}

// ========== edgeless ==========

export const CANVAS_COLORS = {
  red: '#fb7081',
  orange: '#ff8c38',
  yellow: '#fcd34d',
  green: '#3cbc36',
  blue: '#84cfff',
  purple: '#6e52df',
  magenta: '#e96cab',
  grey: '#929292',
  white: '#ffffff',
  black: '#000000',
} as const;
export type CanvasColor = keyof typeof CANVAS_COLORS;

const NOTE_BACKGROUNDS: Record<CanvasColor, { dark: string; light: string }> = {
  red: { dark: '#460606', light: '#fbb7b7' },
  orange: { dark: '#843b06', light: '#ffc58f' },
  yellow: { dark: '#704200', light: '#fde68a' },
  green: { dark: '#3b5315', light: '#c9f8c1' },
  blue: { dark: '#004b7b', light: '#ceecff' },
  purple: { dark: '#312e81', light: '#ddd6fe' },
  magenta: { dark: '#5f0a35', light: '#ffdaed' },
  grey: { dark: '#565656', light: '#e6e6e6' },
  white: { dark: '#252525', light: '#ffffff' },
  black: { dark: '#252525', light: '#b3b3b3' },
};

export const SHAPE_TYPES = ['rect', 'ellipse', 'diamond', 'triangle'] as const;

export type CanvasItemInput =
  | {
      kind: 'shape';
      shape: (typeof SHAPE_TYPES)[number];
      x: number;
      y: number;
      width: number;
      height: number;
      text?: string;
      color?: CanvasColor;
      key?: string;
    }
  | {
      kind: 'connector';
      from: string;
      to: string;
      label?: string;
      key?: string;
    }
  | {
      kind: 'note';
      x: number;
      y: number;
      width?: number;
      markdown: string;
      color?: CanvasColor;
      key?: string;
    }
  | {
      kind: 'frame';
      x: number;
      y: number;
      width: number;
      height: number;
      title: string;
      key?: string;
    };

export interface CanvasItem {
  id: string;
  kind: string;
  text?: string;
  xywh?: string;
  from?: string;
  to?: string;
}

const BOXED_NATIVE = '$blocksuite:internal:native$';

/**
 * Writes structured blocks that markdown cannot express: database (table /
 * kanban) blocks and edgeless canvas content (shapes, connectors, notes and
 * frames), using the same yjs layout blocksuite produces.
 */
@Injectable()
export class DocBlockEditor {
  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus
  ) {}

  // ========== database ==========

  async listDatabases(
    workspaceId: string,
    docId: string
  ): Promise<DatabaseInfo[]> {
    const doc = await this.load(workspaceId, docId);
    const blocks = blocksOf(doc);
    const result: DatabaseInfo[] = [];
    for (const [id, block] of blocks) {
      if (block.get('sys:flavour') !== 'affine:database') continue;
      result.push(readDatabase(blocks, id, block));
    }
    return result;
  }

  async createDatabase(
    workspaceId: string,
    docId: string,
    input: {
      title: string;
      view: 'table' | 'kanban';
      columns: DatabaseColumnInput[];
      rows: DatabaseRowInput[];
    },
    editorId?: string
  ) {
    return this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      const noteId = pageNoteId(blocks);
      if (!noteId) throw new NotFoundException('Doc has no page note block');

      const databaseId = nanoid();
      const columns = input.columns.map(column => ({
        id: nanoid(),
        type: column.type,
        name: column.name,
        data: columnData(column),
      }));
      if (input.view === 'kanban' && !columns.some(isSelectColumn)) {
        columns.unshift({
          id: nanoid(),
          type: 'select',
          name: 'Status',
          data: columnData({
            name: 'Status',
            type: 'select',
            options: ['Todo', 'In Progress', 'Done'],
          }),
        });
      }

      const block = insertBlock(blocks, databaseId, 'affine:database', 3);
      setText(block, 'prop:title', input.title);
      const groupColumn = columns.find(isSelectColumn);
      block.set(
        'prop:views',
        native2Y([
          input.view === 'kanban'
            ? {
                id: nanoid(),
                name: 'Kanban View',
                mode: 'kanban',
                columns: [{ id: 'title' }, ...columns.map(c => ({ id: c.id }))],
                filter: { type: 'group', op: 'and', conditions: [] },
                groupBy: {
                  type: 'groupBy',
                  columnId: groupColumn?.id,
                  name: groupColumn?.type,
                  hideEmpty: false,
                },
                header: { titleColumn: 'title', iconColumn: 'type' },
                groupProperties: [],
              }
            : {
                id: nanoid(),
                name: 'Table View',
                mode: 'table',
                columns: [],
                filter: { type: 'group', op: 'and', conditions: [] },
                header: { titleColumn: 'title', iconColumn: 'type' },
              },
        ])
      );
      block.set('prop:columns', native2Y(columns));
      block.set('prop:cells', new YMap());
      appendChild(blocks, noteId, databaseId);

      const rowIds = this.writeRows(blocks, databaseId, input.rows);
      return { databaseId, rowIds };
    });
  }

  async addDatabaseRows(
    workspaceId: string,
    docId: string,
    databaseId: string,
    rows: DatabaseRowInput[],
    editorId?: string
  ) {
    return this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      databaseBlock(blocks, databaseId);
      return this.writeRows(blocks, databaseId, rows);
    });
  }

  async updateDatabaseRow(
    workspaceId: string,
    docId: string,
    databaseId: string,
    rowId: string,
    values: DatabaseRowInput,
    editorId?: string
  ) {
    await this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      const database = databaseBlock(blocks, databaseId);
      if (!childIds(database).includes(rowId)) {
        throw new NotFoundException(`Row ${rowId} not found`);
      }
      writeRowValues(blocks, database, rowId, values);
    });
  }

  async deleteDatabaseRows(
    workspaceId: string,
    docId: string,
    databaseId: string,
    rowIds: string[],
    editorId?: string
  ) {
    return this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      const database = databaseBlock(blocks, databaseId);
      const cells = database.get('prop:cells');
      let removed = 0;
      for (const rowId of rowIds) {
        if (!childIds(database).includes(rowId)) continue;
        removeChild(database, rowId);
        deleteBlockTree(blocks, rowId);
        if (cells instanceof YMap) cells.delete(rowId);
        removed++;
      }
      return removed;
    });
  }

  async addDatabaseColumn(
    workspaceId: string,
    docId: string,
    databaseId: string,
    column: DatabaseColumnInput,
    editorId?: string
  ) {
    return this.mutate(workspaceId, docId, editorId, doc => {
      const database = databaseBlock(blocksOf(doc), databaseId);
      const id = nanoid();
      columnArray(database).push([
        native2Y({
          id,
          type: column.type,
          name: column.name,
          data: columnData(column),
        }) as YMap<unknown>,
      ]);
      return id;
    });
  }

  async updateDatabaseColumn(
    workspaceId: string,
    docId: string,
    databaseId: string,
    columnId: string,
    update: { name?: string; addOptions?: string[] },
    editorId?: string
  ) {
    await this.mutate(workspaceId, docId, editorId, doc => {
      const database = databaseBlock(blocksOf(doc), databaseId);
      const column = findColumn(database, columnId);
      if (update.name) column.set('name', update.name);
      for (const option of update.addOptions ?? []) {
        ensureOption(column, option);
      }
    });
  }

  async deleteDatabaseColumn(
    workspaceId: string,
    docId: string,
    databaseId: string,
    columnId: string,
    editorId?: string
  ) {
    await this.mutate(workspaceId, docId, editorId, doc => {
      const database = databaseBlock(blocksOf(doc), databaseId);
      const columns = columnArray(database);
      const index = columns
        .toArray()
        .findIndex(column => column.get('id') === columnId);
      if (index < 0)
        throw new NotFoundException(`Column ${columnId} not found`);
      columns.delete(index, 1);
      const cells = database.get('prop:cells');
      if (cells instanceof YMap) {
        for (const row of cells.values()) {
          if (row instanceof YMap) row.delete(columnId);
        }
      }
    });
  }

  async deleteDatabase(
    workspaceId: string,
    docId: string,
    databaseId: string,
    editorId?: string
  ) {
    await this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      databaseBlock(blocks, databaseId);
      detachBlock(blocks, databaseId);
      deleteBlockTree(blocks, databaseId);
    });
  }

  private writeRows(
    blocks: YMap<YMap<unknown>>,
    databaseId: string,
    rows: DatabaseRowInput[]
  ) {
    const database = databaseBlock(blocks, databaseId);
    return rows.map(row => {
      const rowId = nanoid();
      const block = insertBlock(blocks, rowId, 'affine:paragraph', 1);
      block.set('prop:type', 'text');
      setText(block, 'prop:text', '');
      appendChild(blocks, databaseId, rowId);
      writeRowValues(blocks, database, rowId, row);
      return rowId;
    });
  }

  // ========== edgeless ==========

  async listCanvas(workspaceId: string, docId: string): Promise<CanvasItem[]> {
    const doc = await this.load(workspaceId, docId);
    const blocks = blocksOf(doc);
    const items: CanvasItem[] = [];
    const elements = surfaceElements(blocks, false);
    for (const [id, element] of elements ?? []) {
      const type = String(element.get('type'));
      const text = element.get('text');
      items.push({
        id,
        kind: type === 'shape' ? `shape:${element.get('shapeType')}` : type,
        text: text instanceof YText ? text.toString() : undefined,
        xywh: element.get('xywh') as string | undefined,
        from: endpointId(element.get('source')),
        to: endpointId(element.get('target')),
      });
    }
    for (const [id, block] of blocks) {
      const flavour = block.get('sys:flavour');
      if (flavour === 'affine:frame') {
        items.push({
          id,
          kind: 'frame',
          text: textOf(block.get('prop:title')),
          xywh: block.get('prop:xywh') as string,
        });
      } else if (flavour === 'affine:note') {
        items.push({
          id,
          kind: `note:${block.get('prop:displayMode') ?? 'both'}`,
          text: plainTextOfTree(blocks, id).slice(0, 200),
          xywh: block.get('prop:xywh') as string,
        });
      }
    }
    return items;
  }

  /**
   * Adds canvas items. Connectors may reference ids of existing items, or the
   * `key` of an item added in the same call.
   */
  async addCanvasItems(
    workspaceId: string,
    docId: string,
    items: CanvasItemInput[],
    editorId?: string
  ) {
    return this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      const pageId = pageBlockId(blocks);
      if (!pageId) throw new NotFoundException('Doc has no page block');
      const elements = surfaceElements(blocks, true, pageId);
      let index = maxCanvasIndex(blocks, elements);
      const nextIndex = () => (index = index ? `${index}V` : 'a1');
      const keyToId = new Map<string, string>();
      const created: { key?: string; id: string; kind: string }[] = [];

      const ordered = [
        ...items.filter(item => item.kind === 'frame'),
        ...items.filter(
          item => item.kind !== 'frame' && item.kind !== 'connector'
        ),
        ...items.filter(item => item.kind === 'connector'),
      ];
      for (const item of ordered) {
        let id: string;
        if (item.kind === 'shape') {
          id = nanoid(10);
          const color = CANVAS_COLORS[item.color ?? 'yellow'];
          const element = new YMap<unknown>();
          elements.set(id, element);
          writeFields(element, {
            type: 'shape',
            id,
            index: nextIndex(),
            seed: seed(),
            color: '#000000',
            fillColor: color,
            filled: true,
            fontFamily: 'blocksuite:surface:Inter',
            fontSize: 20,
            fontStyle: 'normal',
            fontWeight: '400',
            maxWidth: false,
            padding: [10, 20],
            radius: 0,
            rotate: 0,
            roughness: 1.4,
            shadow: null,
            shapeStyle: 'General',
            shapeType: item.shape,
            strokeColor: color,
            strokeStyle: 'solid',
            strokeWidth: 2,
            textAlign: 'center',
            textHorizontalAlign: 'center',
            textVerticalAlign: 'center',
            textResizing: 1,
            xywh: xywh(item.x, item.y, item.width, item.height),
            hidden: false,
            lockedBySelf: false,
          });
          if (item.text) {
            const text = new YText();
            element.set('text', text);
            text.insert(0, item.text);
          }
        } else if (item.kind === 'connector') {
          const from = keyToId.get(item.from) ?? item.from;
          const to = keyToId.get(item.to) ?? item.to;
          for (const end of [from, to]) {
            if (!elements.has(end) && !blocks.has(end)) {
              throw new NotFoundException(`Canvas item ${end} not found`);
            }
          }
          id = nanoid(10);
          const element = new YMap<unknown>();
          elements.set(id, element);
          writeFields(element, {
            type: 'connector',
            id,
            index: nextIndex(),
            seed: seed(),
            frontEndpointStyle: 'None',
            rearEndpointStyle: 'Arrow',
            labelOffset: { distance: 0.5, anchor: 'center' },
            labelStyle: {
              color: { dark: '#ffffff', light: '#000000' },
              fontSize: 16,
              fontFamily: 'blocksuite:surface:Inter',
              fontWeight: '400',
              fontStyle: 'normal',
              textAlign: 'center',
            },
            mode: 2,
            rough: false,
            roughness: 1.4,
            source: { id: from },
            target: { id: to },
            stroke: CANVAS_COLORS.grey,
            strokeStyle: 'solid',
            strokeWidth: 2,
            hidden: false,
            lockedBySelf: false,
          });
          if (item.label) {
            const text = new YText();
            element.set('text', text);
            text.insert(0, item.label);
          }
        } else if (item.kind === 'note') {
          id = nanoid();
          const note = insertBlock(blocks, id, 'affine:note', 1);
          writeFields(note, {
            'prop:xywh': xywh(item.x, item.y, item.width ?? 448, 120),
            'prop:index': nextIndex(),
            'prop:hidden': false,
            'prop:displayMode': 'edgeless',
            'prop:lockedBySelf': false,
          });
          note.set(
            'prop:background',
            native2Y(NOTE_BACKGROUNDS[item.color ?? 'white'])
          );
          note.set(
            'prop:edgeless',
            native2Y({
              style: {
                borderRadius: 8,
                borderSize: 4,
                borderStyle: 'none',
                shadowType: '--affine-note-shadow-box',
              },
            })
          );
          appendChild(blocks, pageId, id);
          copyMarkdownInto(blocks, id, item.markdown);
        } else {
          id = nanoid();
          const frame = insertBlock(blocks, id, 'affine:frame', 1);
          setText(frame, 'prop:title', item.title);
          writeFields(frame, {
            'prop:background': 'transparent',
            'prop:xywh': xywh(item.x, item.y, item.width, item.height),
            'prop:index': nextIndex(),
            'prop:lockedBySelf': false,
          });
          frame.set('prop:childElementIds', new YMap());
          appendChild(blocks, pageId, id);
        }
        if (item.key) keyToId.set(item.key, id);
        created.push({ key: item.key, id, kind: item.kind });
      }
      return created;
    });
  }

  async updateCanvasItem(
    workspaceId: string,
    docId: string,
    itemId: string,
    update: {
      text?: string;
      color?: CanvasColor;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    editorId?: string
  ) {
    await this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      const element = surfaceElements(blocks, false)?.get(itemId);
      const block = blocks.get(itemId);
      const target = element ?? block;
      if (!target)
        throw new NotFoundException(`Canvas item ${itemId} not found`);
      const xywhKey = element ? 'xywh' : 'prop:xywh';
      const current = parseXYWH(target.get(xywhKey));
      if (current) {
        target.set(
          xywhKey,
          xywh(
            update.x ?? current[0],
            update.y ?? current[1],
            update.width ?? current[2],
            update.height ?? current[3]
          )
        );
      }
      if (update.text !== undefined) {
        if (element) {
          const text = new YText();
          element.set('text', text);
          text.insert(0, update.text);
        } else if (block?.get('sys:flavour') === 'affine:frame') {
          setText(block, 'prop:title', update.text);
        } else {
          throw new Error('Use doc_append or doc_update to change note text');
        }
      }
      if (update.color) {
        if (element?.get('type') === 'shape') {
          element.set('fillColor', CANVAS_COLORS[update.color]);
          element.set('strokeColor', CANVAS_COLORS[update.color]);
        } else if (element?.get('type') === 'connector') {
          element.set('stroke', CANVAS_COLORS[update.color]);
        } else if (block?.get('sys:flavour') === 'affine:note') {
          block.set(
            'prop:background',
            native2Y(NOTE_BACKGROUNDS[update.color])
          );
        }
      }
    });
  }

  async deleteCanvasItems(
    workspaceId: string,
    docId: string,
    itemIds: string[],
    editorId?: string
  ) {
    return this.mutate(workspaceId, docId, editorId, doc => {
      const blocks = blocksOf(doc);
      const elements = surfaceElements(blocks, false);
      const removed = new Set<string>();
      for (const id of itemIds) {
        if (elements?.has(id)) {
          elements.delete(id);
          removed.add(id);
        } else if (blocks.has(id)) {
          const flavour = blocks.get(id)?.get('sys:flavour');
          if (flavour !== 'affine:note' && flavour !== 'affine:frame') {
            throw new Error(`${id} is not a canvas item`);
          }
          if (flavour === 'affine:note' && pageNoteId(blocks) === id) {
            throw new Error('The main page note cannot be deleted');
          }
          detachBlock(blocks, id);
          deleteBlockTree(blocks, id);
          removed.add(id);
        }
      }
      // drop connectors that pointed at removed items
      for (const [id, element] of elements ?? []) {
        if (
          element.get('type') === 'connector' &&
          (removed.has(endpointId(element.get('source')) ?? '') ||
            removed.has(endpointId(element.get('target')) ?? ''))
        ) {
          elements?.delete(id);
          removed.add(id);
        }
      }
      return [...removed];
    });
  }

  // ========== yjs helpers ==========

  private async load(workspaceId: string, docId: string) {
    const existing = await this.storage.getDoc(workspaceId, docId);
    if (!existing?.bin) throw new NotFoundException(`Doc ${docId} not found`);
    const doc = new YDoc({ guid: docId });
    applyUpdate(doc, existing.bin);
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
}

// ========== block tree helpers ==========

function blocksOf(doc: YDoc) {
  return doc.getMap<YMap<unknown>>('blocks');
}

function childIds(block: YMap<unknown> | undefined): string[] {
  const children = block?.get('sys:children');
  return children instanceof YArray
    ? children.toArray().filter((id): id is string => typeof id === 'string')
    : [];
}

function pageBlockId(blocks: YMap<YMap<unknown>>) {
  for (const [id, block] of blocks) {
    if (block.get('sys:flavour') === 'affine:page') return id;
  }
  return undefined;
}

function pageNoteId(blocks: YMap<YMap<unknown>>) {
  const pageId = pageBlockId(blocks);
  if (!pageId) return undefined;
  return childIds(blocks.get(pageId)).findLast(id => {
    const block = blocks.get(id);
    return (
      block?.get('sys:flavour') === 'affine:note' &&
      block.get('prop:displayMode') !== 'edgeless'
    );
  });
}

function insertBlock(
  blocks: YMap<YMap<unknown>>,
  id: string,
  flavour: string,
  version: number
) {
  const block = new YMap<unknown>();
  blocks.set(id, block);
  block.set('sys:id', id);
  block.set('sys:flavour', flavour);
  block.set('sys:version', version);
  block.set('sys:children', new YArray<string>());
  return block;
}

function appendChild(
  blocks: YMap<YMap<unknown>>,
  parentId: string,
  childId: string
) {
  const parent = blocks.get(parentId);
  if (!parent) throw new NotFoundException(`Block ${parentId} not found`);
  let children = parent.get('sys:children');
  if (!(children instanceof YArray)) {
    children = new YArray<string>();
    parent.set('sys:children', children);
  }
  (children as YArray<string>).push([childId]);
}

function removeChild(parent: YMap<unknown>, childId: string) {
  const children = parent.get('sys:children');
  if (!(children instanceof YArray)) return;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children.get(i) === childId) children.delete(i, 1);
  }
}

function detachBlock(blocks: YMap<YMap<unknown>>, id: string) {
  for (const block of blocks.values()) {
    if (childIds(block).includes(id)) removeChild(block, id);
  }
}

function deleteBlockTree(blocks: YMap<YMap<unknown>>, id: string) {
  for (const child of childIds(blocks.get(id))) {
    deleteBlockTree(blocks, child);
  }
  blocks.delete(id);
}

function setText(block: YMap<unknown>, key: string, value: string) {
  const text = new YText();
  block.set(key, text);
  if (value) text.insert(0, value);
}

function textOf(value: unknown) {
  return value instanceof YText ? value.toString() : undefined;
}

function plainTextOfTree(blocks: YMap<YMap<unknown>>, id: string): string {
  const block = blocks.get(id);
  const own = textOf(block?.get('prop:text')) ?? '';
  return [own, ...childIds(block).map(child => plainTextOfTree(blocks, child))]
    .filter(Boolean)
    .join(' ');
}

function writeFields(target: YMap<unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) target.set(key, value);
  }
}

/** Mirrors blocksuite's deep native2Y used for block props. */
function native2Y(value: unknown): unknown {
  if (Array.isArray(value)) {
    const array = new YArray<unknown>();
    array.insert(0, value.map(native2Y));
    return array;
  }
  if (value && typeof value === 'object' && !(value instanceof YText)) {
    const map = new YMap<unknown>();
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) map.set(key, native2Y(item));
    }
    return map;
  }
  return value;
}

/** Copies the blocks of a markdown snippet under the given parent block. */
function copyMarkdownInto(
  blocks: YMap<YMap<unknown>>,
  parentId: string,
  markdown: string
) {
  const scratchId = nanoid();
  const scratch = new YDoc({ guid: scratchId });
  applyUpdate(scratch, createDocWithMarkdown('', markdown || ' ', scratchId));
  const scratchBlocks = blocksOf(scratch);
  const noteId = pageNoteId(scratchBlocks);
  const roots = noteId ? childIds(scratchBlocks.get(noteId)) : [];
  const pending = [...roots];
  while (pending.length) {
    const id = pending.shift() as string;
    const source = scratchBlocks.get(id);
    if (!source) continue;
    const target = new YMap<unknown>();
    blocks.set(id, target);
    for (const [key, value] of source) {
      if (value instanceof YText) {
        const text = new YText();
        target.set(key, text);
        text.applyDelta(value.toDelta());
      } else if (value instanceof YArray || value instanceof YMap) {
        target.set(key, native2Y(value.toJSON()));
      } else {
        target.set(key, value);
      }
    }
    pending.push(...childIds(source));
  }
  for (const id of roots) appendChild(blocks, parentId, id);
}

// ========== database helpers ==========

function databaseBlock(blocks: YMap<YMap<unknown>>, databaseId: string) {
  const block = blocks.get(databaseId);
  if (block?.get('sys:flavour') !== 'affine:database') {
    throw new NotFoundException(`Database ${databaseId} not found`);
  }
  return block;
}

function columnArray(database: YMap<unknown>) {
  let columns = database.get('prop:columns');
  if (!(columns instanceof YArray)) {
    columns = new YArray<YMap<unknown>>();
    database.set('prop:columns', columns);
  }
  return columns as YArray<YMap<unknown>>;
}

function findColumn(database: YMap<unknown>, columnId: string) {
  const column = columnArray(database)
    .toArray()
    .find(item => item.get('id') === columnId);
  if (!column) throw new NotFoundException(`Column ${columnId} not found`);
  return column;
}

function isSelectColumn(column: { type: string }) {
  return column.type === 'select' || column.type === 'multi-select';
}

const OPTION_COLORS = [
  'var(--affine-v2-chip-label-blue)',
  'var(--affine-v2-chip-label-green)',
  'var(--affine-v2-chip-label-orange)',
  'var(--affine-v2-chip-label-purple)',
  'var(--affine-v2-chip-label-red)',
  'var(--affine-v2-chip-label-teal)',
  'var(--affine-v2-chip-label-yellow)',
  'var(--affine-v2-chip-label-magenta)',
  'var(--affine-v2-chip-label-grey)',
];

function columnData(column: DatabaseColumnInput) {
  switch (column.type) {
    case 'select':
    case 'multi-select':
      return {
        options: [...new Set(column.options ?? [])].map((value, i) => ({
          id: nanoid(),
          value,
          color: OPTION_COLORS[i % OPTION_COLORS.length],
        })),
      };
    case 'number':
      return { decimal: 0, format: 'number' };
    default:
      return {};
  }
}

/** Returns the option id for `value`, adding the option when missing. */
function ensureOption(column: YMap<unknown>, value: string) {
  let data = column.get('data');
  if (!(data instanceof YMap)) {
    data = new YMap<unknown>();
    column.set('data', data);
  }
  let options = (data as YMap<unknown>).get('options');
  if (!(options instanceof YArray)) {
    options = new YArray<unknown>();
    (data as YMap<unknown>).set('options', options);
  }
  const list = options as YArray<unknown>;
  const existing = list
    .toArray()
    .find(
      option =>
        String(fieldOf(option, 'value')).toLowerCase() === value.toLowerCase()
    );
  if (existing) return String(fieldOf(existing, 'id'));
  const id = nanoid();
  list.push([
    native2Y({
      id,
      value,
      color: OPTION_COLORS[list.length % OPTION_COLORS.length],
    }),
  ]);
  return id;
}

function fieldOf(item: unknown, key: string): unknown {
  if (item instanceof YMap) return item.get(key);
  if (item && typeof item === 'object') {
    return (item as Record<string, unknown>)[key];
  }
  return undefined;
}

function columnByName(database: YMap<unknown>, name: string) {
  const lower = name.toLowerCase();
  return columnArray(database)
    .toArray()
    .find(
      column =>
        column.get('id') === name ||
        String(column.get('name')).toLowerCase() === lower
    );
}

function writeRowValues(
  blocks: YMap<YMap<unknown>>,
  database: YMap<unknown>,
  rowId: string,
  values: DatabaseRowInput
) {
  let cells = database.get('prop:cells');
  if (!(cells instanceof YMap)) {
    cells = new YMap<unknown>();
    database.set('prop:cells', cells);
  }
  for (const [name, raw] of Object.entries(values)) {
    if (name.toLowerCase() === 'title') {
      const row = blocks.get(rowId);
      if (row) setText(row, 'prop:text', raw == null ? '' : String(raw));
      continue;
    }
    const column = columnByName(database, name);
    if (!column) throw new NotFoundException(`Column "${name}" not found`);
    const columnId = String(column.get('id'));
    let rowCells = (cells as YMap<unknown>).get(rowId);
    if (!(rowCells instanceof YMap)) {
      rowCells = new YMap<unknown>();
      (cells as YMap<unknown>).set(rowId, rowCells);
    }
    const cellMap = rowCells as YMap<unknown>;
    if (raw === null || raw === undefined || raw === '') {
      cellMap.delete(columnId);
      continue;
    }
    const cell = new YMap<unknown>();
    cellMap.set(columnId, cell);
    cell.set('columnId', columnId);
    cell.set('value', cellValue(column, raw));
  }
}

function cellValue(column: YMap<unknown>, raw: unknown): unknown {
  const type = String(column.get('type'));
  switch (type) {
    case 'select':
      return ensureOption(column, String(raw));
    case 'multi-select': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      const array = new YArray<string>();
      array.push(
        list
          .map(item => String(item).trim())
          .filter(Boolean)
          .map(item => ensureOption(column, item))
      );
      return array;
    }
    case 'number':
    case 'progress': {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`"${raw}" is not a number`);
      return type === 'progress' ? Math.max(0, Math.min(100, value)) : value;
    }
    case 'checkbox':
      return (
        raw === true ||
        ['true', 'yes', 'ya', '1', 'done'].includes(String(raw).toLowerCase())
      );
    case 'date': {
      const value =
        typeof raw === 'number' ? raw : new Date(String(raw)).getTime();
      if (Number.isNaN(value)) throw new Error(`"${raw}" is not a date`);
      return value;
    }
    case 'rich-text': {
      const text = new YText();
      text.insert(0, String(raw));
      return text;
    }
    default:
      return String(raw);
  }
}

function readDatabase(
  blocks: YMap<YMap<unknown>>,
  id: string,
  block: YMap<unknown>
): DatabaseInfo {
  const columns = columnArray(block)
    .toArray()
    .map(column => {
      const options = (column.get('data') as YMap<unknown> | undefined)?.get?.(
        'options'
      );
      const optionList =
        options instanceof YArray
          ? options.toArray().map(option => ({
              id: String(fieldOf(option, 'id')),
              value: String(fieldOf(option, 'value')),
            }))
          : undefined;
      return {
        id: String(column.get('id')),
        name: String(column.get('name')),
        type: String(column.get('type')),
        optionList,
      };
    });
  const cells = block.get('prop:cells');
  const views = block.get('prop:views');
  return {
    databaseId: id,
    title: textOf(block.get('prop:title')) ?? '',
    views:
      views instanceof YArray
        ? views.toArray().map(view => ({
            id: String(fieldOf(view, 'id')),
            name: String(fieldOf(view, 'name')),
            mode: String(fieldOf(view, 'mode')),
          }))
        : [],
    columns: columns.map(({ optionList, ...column }) => ({
      ...column,
      options: optionList?.map(option => option.value),
    })),
    rows: childIds(block).map(rowId => {
      const rowCells =
        cells instanceof YMap ? (cells.get(rowId) as YMap<unknown>) : undefined;
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        const cell = rowCells?.get?.(column.id);
        let value = fieldOf(cell, 'value');
        if (value instanceof YText || value instanceof YArray) {
          value = value.toJSON();
        }
        if (value === undefined || value === null) continue;
        const name = (optionId: unknown) =>
          column.optionList?.find(option => option.id === optionId)?.value ??
          optionId;
        if (column.type === 'select') value = name(value);
        if (column.type === 'multi-select' && Array.isArray(value)) {
          value = value.map(name);
        }
        if (column.type === 'date' && typeof value === 'number') {
          value = new Date(value).toISOString().slice(0, 10);
        }
        values[column.name] = value;
      }
      return {
        rowId,
        title: textOf(blocks.get(rowId)?.get('prop:text')) ?? '',
        values,
      };
    }),
  };
}

// ========== canvas helpers ==========

function surfaceElements(
  blocks: YMap<YMap<unknown>>,
  create: true,
  pageId: string
): YMap<YMap<unknown>>;
function surfaceElements(
  blocks: YMap<YMap<unknown>>,
  create: false
): YMap<YMap<unknown>> | undefined;
function surfaceElements(
  blocks: YMap<YMap<unknown>>,
  create: boolean,
  pageId?: string
) {
  let surface: YMap<unknown> | undefined;
  for (const block of blocks.values()) {
    if (block.get('sys:flavour') === 'affine:surface') surface = block;
  }
  if (!surface) {
    if (!create || !pageId) return undefined;
    const id = nanoid();
    surface = insertBlock(blocks, id, 'affine:surface', 5);
    const children = blocks.get(pageId)?.get('sys:children');
    if (children instanceof YArray) children.insert(0, [id]);
  }
  let boxed = surface.get('prop:elements');
  if (!(boxed instanceof YMap)) {
    if (!create) return undefined;
    boxed = new YMap<unknown>();
    surface.set('prop:elements', boxed);
    (boxed as YMap<unknown>).set('type', BOXED_NATIVE);
  }
  let value = (boxed as YMap<unknown>).get('value');
  if (!(value instanceof YMap)) {
    if (!create) return undefined;
    value = new YMap<unknown>();
    (boxed as YMap<unknown>).set('value', value);
  }
  return value as YMap<YMap<unknown>>;
}

function maxCanvasIndex(
  blocks: YMap<YMap<unknown>>,
  elements: YMap<YMap<unknown>>
) {
  const indexes: string[] = [];
  for (const element of elements.values()) {
    const index = element.get('index');
    if (typeof index === 'string') indexes.push(index);
  }
  for (const block of blocks.values()) {
    const index = block.get('prop:index');
    if (typeof index === 'string') indexes.push(index);
  }
  return indexes.sort().at(-1);
}

function endpointId(value: unknown) {
  const id = fieldOf(value, 'id');
  return typeof id === 'string' ? id : undefined;
}

function xywh(x: number, y: number, w: number, h: number) {
  return `[${x},${y},${w},${h}]`;
}

function parseXYWH(value: unknown): number[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 4 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function seed() {
  return Math.floor(Math.random() * 2 ** 31);
}
