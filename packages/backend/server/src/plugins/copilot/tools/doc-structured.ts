import { Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  CANVAS_COLORS,
  type CanvasItemInput,
  DATABASE_COLUMN_TYPES,
  DocBlockEditor,
  SHAPE_TYPES,
} from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { type CopilotToolSet, defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocStructuredTool');

const colorEnum = z.enum(
  Object.keys(CANVAS_COLORS) as [
    keyof typeof CANVAS_COLORS,
    ...(keyof typeof CANVAS_COLORS)[],
  ]
);

const need = <T>(value: T | undefined | null, field: string): T => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`"${field}" is required for this action`);
  }
  return value;
};

const rowSchema = z
  .record(z.string(), z.any())
  .describe(
    'Cell values keyed by column name; use the key "title" for the row title. select: option name; multi-select: array of option names; number/progress: number; checkbox: boolean; date: YYYY-MM-DD; rich-text/link: text'
  );

/**
 * Tools for content that markdown cannot express: database (table / kanban)
 * blocks and the edgeless whiteboard.
 */
export function createDocStructuredTools(
  { ac, editor }: { ac: PermissionAccess; editor: DocBlockEditor },
  options: CopilotChatOptions
): CopilotToolSet {
  const guard = async (
    name: string,
    docId: string,
    write: boolean,
    fn: (workspaceId: string, userId: string) => Promise<object>
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(`${name} Failed`, 'Missing user or workspace context');
    }
    try {
      await ac
        .user(options.user)
        .workspace(options.workspace)
        .doc(docId)
        .assert(write ? 'Doc.Update' : 'Doc.Read');
      return await fn(options.workspace, options.user);
    } catch (err: any) {
      logger.error(`${name} failed`, err);
      return toolError(`${name} Failed`, err.message);
    }
  };

  return {
    database_manage: defineTool({
      description:
        'Read and edit database blocks (AFFiNE tables / kanban boards with typed columns) inside a doc. Actions: list (all databases in the doc with column and row ids and values), create (title, view table|kanban, columns, rows), add_rows, update_row (row_id, values), delete_rows (row_ids), add_column, update_column (column_id, name and/or new options), delete_column, delete_database. Use list first to get ids. A kanban board groups by its first select column.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'create',
          'add_rows',
          'update_row',
          'delete_rows',
          'add_column',
          'update_column',
          'delete_column',
          'delete_database',
        ]),
        doc_id: z.string(),
        database_id: z.string().optional(),
        title: z.string().optional(),
        view: z.enum(['table', 'kanban']).optional(),
        columns: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(DATABASE_COLUMN_TYPES),
              options: z
                .array(z.string())
                .optional()
                .describe('choices for select / multi-select columns'),
            })
          )
          .optional()
          .describe(
            'columns for create / add_column (the title column is built in)'
          ),
        rows: z.array(rowSchema).optional(),
        row_id: z.string().optional(),
        row_ids: z.array(z.string()).optional(),
        values: rowSchema.optional(),
        column_id: z.string().optional(),
        name: z.string().optional(),
        add_options: z.array(z.string()).optional(),
      }),
      execute: args =>
        guard(
          'Database',
          args.doc_id,
          args.action !== 'list',
          async (ws, user) => {
            const { doc_id } = args;
            switch (args.action) {
              case 'list':
                return { databases: await editor.listDatabases(ws, doc_id) };
              case 'create': {
                const result = await editor.createDatabase(
                  ws,
                  doc_id,
                  {
                    title: args.title ?? 'Database',
                    view: args.view ?? 'table',
                    columns: args.columns ?? [],
                    rows: args.rows ?? [],
                  },
                  user
                );
                return {
                  success: true,
                  docId: doc_id,
                  ...result,
                  message: `Database created with ${result.rowIds.length} row(s)`,
                };
              }
              case 'add_rows': {
                const rowIds = await editor.addDatabaseRows(
                  ws,
                  doc_id,
                  need(args.database_id, 'database_id'),
                  need(args.rows, 'rows'),
                  user
                );
                return {
                  success: true,
                  docId: doc_id,
                  rowIds,
                  message: `Added ${rowIds.length} row(s)`,
                };
              }
              case 'update_row':
                await editor.updateDatabaseRow(
                  ws,
                  doc_id,
                  need(args.database_id, 'database_id'),
                  need(args.row_id, 'row_id'),
                  need(args.values, 'values'),
                  user
                );
                return { success: true, docId: doc_id, message: 'Row updated' };
              case 'delete_rows': {
                const removed = await editor.deleteDatabaseRows(
                  ws,
                  doc_id,
                  need(args.database_id, 'database_id'),
                  need(args.row_ids, 'row_ids'),
                  user
                );
                return {
                  success: true,
                  docId: doc_id,
                  message: `Deleted ${removed} row(s)`,
                };
              }
              case 'add_column': {
                const ids: string[] = [];
                for (const column of need(args.columns, 'columns')) {
                  ids.push(
                    await editor.addDatabaseColumn(
                      ws,
                      doc_id,
                      need(args.database_id, 'database_id'),
                      column,
                      user
                    )
                  );
                }
                return {
                  success: true,
                  docId: doc_id,
                  columnIds: ids,
                  message: `Added ${ids.length} column(s)`,
                };
              }
              case 'update_column':
                await editor.updateDatabaseColumn(
                  ws,
                  doc_id,
                  need(args.database_id, 'database_id'),
                  need(args.column_id, 'column_id'),
                  { name: args.name, addOptions: args.add_options },
                  user
                );
                return {
                  success: true,
                  docId: doc_id,
                  message: 'Column updated',
                };
              case 'delete_column':
                await editor.deleteDatabaseColumn(
                  ws,
                  doc_id,
                  need(args.database_id, 'database_id'),
                  need(args.column_id, 'column_id'),
                  user
                );
                return {
                  success: true,
                  docId: doc_id,
                  message: 'Column deleted',
                };
              case 'delete_database':
                await editor.deleteDatabase(
                  ws,
                  doc_id,
                  need(args.database_id, 'database_id'),
                  user
                );
                return {
                  success: true,
                  docId: doc_id,
                  message: 'Database deleted',
                };
            }
          }
        ),
    }),

    canvas_manage: defineTool({
      description:
        "Read and draw on a doc's edgeless whiteboard. Actions: list (all shapes, connectors, notes and frames with ids and positions), add (items), update (item_id with new text, color, or position/size), delete (item_ids; connectors attached to deleted items are removed too). Item kinds: shape (rect, ellipse, diamond, triangle with optional text), connector (arrow from one item to another, optional label), note (a card with markdown content), frame (a titled area). Coordinates are canvas pixels; lay items out in a grid (e.g. 240px apart) so they do not overlap. Give items a key so connectors in the same call can reference them.",
      inputSchema: z.object({
        action: z.enum(['list', 'add', 'update', 'delete']),
        doc_id: z.string(),
        items: z
          .array(
            z.object({
              kind: z.enum(['shape', 'connector', 'note', 'frame']),
              key: z
                .string()
                .optional()
                .describe('local name for connectors in the same call'),
              shape: z.enum(SHAPE_TYPES).optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
              text: z
                .string()
                .optional()
                .describe('shape text, connector label or frame title'),
              markdown: z.string().optional().describe('note content'),
              color: colorEnum.optional(),
              from: z
                .string()
                .optional()
                .describe('connector start: item id or key'),
              to: z
                .string()
                .optional()
                .describe('connector end: item id or key'),
            })
          )
          .optional(),
        item_id: z.string().optional(),
        item_ids: z.array(z.string()).optional(),
        text: z.string().optional(),
        color: colorEnum.optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
      execute: args =>
        guard(
          'Canvas',
          args.doc_id,
          args.action !== 'list',
          async (ws, user) => {
            const { doc_id } = args;
            if (args.action === 'list') {
              return { items: await editor.listCanvas(ws, doc_id) };
            }
            if (args.action === 'add') {
              const items = need(args.items, 'items').map(
                (item): CanvasItemInput => {
                  switch (item.kind) {
                    case 'shape':
                      return {
                        kind: 'shape',
                        shape: item.shape ?? 'rect',
                        x: item.x ?? 0,
                        y: item.y ?? 0,
                        width: item.width ?? 200,
                        height: item.height ?? 100,
                        text: item.text,
                        color: item.color,
                        key: item.key,
                      };
                    case 'connector':
                      return {
                        kind: 'connector',
                        from: need(item.from, 'from'),
                        to: need(item.to, 'to'),
                        label: item.text,
                        key: item.key,
                      };
                    case 'note':
                      return {
                        kind: 'note',
                        x: item.x ?? 0,
                        y: item.y ?? 0,
                        width: item.width,
                        markdown: item.markdown ?? item.text ?? '',
                        color: item.color,
                        key: item.key,
                      };
                    default:
                      return {
                        kind: 'frame',
                        x: item.x ?? 0,
                        y: item.y ?? 0,
                        width: item.width ?? 800,
                        height: item.height ?? 600,
                        title: item.text ?? 'Frame',
                        key: item.key,
                      };
                  }
                }
              );
              const created = await editor.addCanvasItems(
                ws,
                doc_id,
                items,
                user
              );
              return {
                success: true,
                docId: doc_id,
                created,
                message: `Added ${created.length} item(s) to the whiteboard`,
              };
            }
            if (args.action === 'update') {
              await editor.updateCanvasItem(
                ws,
                doc_id,
                need(args.item_id, 'item_id'),
                {
                  text: args.text,
                  color: args.color,
                  x: args.x,
                  y: args.y,
                  width: args.width,
                  height: args.height,
                },
                user
              );
              return { success: true, docId: doc_id, message: 'Item updated' };
            }
            const removed = await editor.deleteCanvasItems(
              ws,
              doc_id,
              need(args.item_ids, 'item_ids'),
              user
            );
            return {
              success: true,
              docId: doc_id,
              removed,
              message: `Deleted ${removed.length} item(s)`,
            };
          }
        ),
    }),
  };
}
