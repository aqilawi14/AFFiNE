import test from 'ava';
import { applyUpdate, Array as YArray, Doc as YDoc, Map as YMap } from 'yjs';

import { createDocWithMarkdown } from '../../../native';
import { DocWriter } from '../writer';

function createWriter(docs: Map<string, Uint8Array>) {
  const storage = {
    getDoc: async (_spaceId: string, docId: string) => {
      const bin = docs.get(docId);
      return bin ? { bin } : null;
    },
    pushDocUpdates: async (
      _spaceId: string,
      docId: string,
      updates: Uint8Array[]
    ) => {
      const doc = new YDoc();
      const existing = docs.get(docId);
      if (existing) applyUpdate(doc, existing);
      for (const update of updates) applyUpdate(doc, update);
      const { encodeStateAsUpdate } = await import('yjs');
      docs.set(docId, encodeStateAsUpdate(doc));
      return Date.now();
    },
  };
  const event = { emit: () => {} };
  return new DocWriter(storage as any, event as any);
}

function noteTexts(bin: Uint8Array) {
  const doc = new YDoc();
  applyUpdate(doc, bin);
  const blocks = doc.getMap<YMap<unknown>>('blocks');
  const page = [...blocks.values()].find(
    block => block.get('sys:flavour') === 'affine:page'
  );
  const pageChildren = page?.get('sys:children') as YArray<string>;
  const noteId = pageChildren
    .toArray()
    .find(id => blocks.get(id)?.get('sys:flavour') === 'affine:note');
  const note = blocks.get(noteId as string);
  const noteChildren = note?.get('sys:children') as YArray<string>;
  return noteChildren.toArray().map(id => {
    const block = blocks.get(id);
    return {
      flavour: block?.get('sys:flavour'),
      type: block?.get('prop:type'),
      text: String(block?.get('prop:text') ?? ''),
    };
  });
}

test('appendDoc should add blocks to the end without touching existing ones', async t => {
  const docs = new Map<string, Uint8Array>();
  docs.set(
    'doc1',
    createDocWithMarkdown('Progress', 'Intro paragraph\n\n- old item', 'doc1')
  );
  const writer = createWriter(docs);

  await writer.appendDoc('ws', 'doc1', '- new item 1\n- new item 2');

  const texts = noteTexts(docs.get('doc1') as Uint8Array);
  t.deepEqual(
    texts.map(item => item.text),
    ['Intro paragraph', 'old item', 'new item 1', 'new item 2']
  );
  t.is(texts[3].flavour, 'affine:list');
  t.is(texts[3].type, 'bulleted');
});

test('initWorkspaceRootDoc should write workspace name and empty pages', async t => {
  const docs = new Map<string, Uint8Array>();
  const writer = createWriter(docs);

  await writer.initWorkspaceRootDoc('ws2', 'My Workspace');

  const doc = new YDoc();
  applyUpdate(doc, docs.get('ws2') as Uint8Array);
  const meta = doc.getMap<unknown>('meta');
  t.is(meta.get('name'), 'My Workspace');
  t.true(meta.get('pages') instanceof YArray);

  const created = await writer.createDoc('ws2', 'First', '- a');
  t.truthy(created.docId);
});
