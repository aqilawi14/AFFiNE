/* oxlint-disable import/no-cycle -- Tools can invoke nested prompts and semantic search. */
import { forwardRef, Inject, Injectable } from '@nestjs/common';

import { Config } from '../../../base';
import {
  DocBlockEditor,
  DocOrganizer,
  DocReader,
  DocWriter,
} from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { Models } from '../../../models';
import { DelegatedEditorService } from '../delegated/service';
import {
  type CopilotChatOptions,
  type CopilotChatTools,
} from '../providers/types';
import { ArtifactRetrievalService } from '../retrieval/artifact';
import { DocumentRetrievalService } from '../retrieval/document';
import {
  buildDocAppendHandler,
  buildDocCanvasGetter,
  buildDocContentGetter,
  buildDocCreateHandler,
  buildDocumentSearch,
  buildDocUpdateHandler,
  buildDocUpdateMetaHandler,
  buildWorkspaceCreateHandler,
  type CopilotTool,
  type CopilotToolSet,
  createArtifactReadTool,
  createArtifactSearchTool,
  createCodeArtifactTool,
  createConversationSummaryTool,
  createDocAppendTool,
  createDocCanvasReadTool,
  createDocComposeTool,
  createDocCreateTool,
  createDocReadTool,
  createDocSearchTool,
  createDocStructuredTools,
  createDocUpdateMetaTool,
  createDocUpdateTool,
  createExaCrawlTool,
  createExaSearchTool,
  createFrontendEditorStateTool,
  createFrontendNodesTool,
  createFrontendSelectionTool,
  createFrontendSnapshotTool,
  createSectionEditTool,
  createWorkspaceCreateTool,
  createWorkspaceOrganizeTools,
} from '../tools';
import { PromptRuntime } from './prompt-runtime';

export type ProviderSpecificToolResolver = (
  toolName: CopilotChatTools,
  model: string
) => [string, CopilotTool?] | undefined;

@Injectable()
export class ToolRuntime {
  constructor(
    private readonly config: Config,
    private readonly ac: PermissionAccess,
    private readonly docReader: DocReader,
    private readonly docWriter: DocWriter,
    private readonly docOrganizer: DocOrganizer,
    private readonly docBlockEditor: DocBlockEditor,
    private readonly models: Models,
    @Inject(forwardRef(() => PromptRuntime))
    private readonly promptRuntime: Pick<PromptRuntime, 'runText'>,
    private readonly retrieval: DocumentRetrievalService,
    private readonly artifactRetrieval: ArtifactRetrievalService,
    private readonly delegated: DelegatedEditorService
  ) {}

  async getTools(
    options: CopilotChatOptions,
    model: string,
    resolveProviderSpecificTool?: ProviderSpecificToolResolver
  ): Promise<CopilotToolSet> {
    const tools: CopilotToolSet = {};
    if (!options?.tools?.length) {
      return tools;
    }
    const runPromptText = (
      promptName: string,
      params: Record<string, unknown>
    ) =>
      this.promptRuntime.runText(promptName, params, {
        providerOptions: {
          user: options.user,
          session: options.session,
          workspace: options.workspace,
          byokLeaseId: options.byokLeaseId,
          billingUnitId: options.billingUnitId,
          quotaBackedRoutesAllowed: options.quotaBackedRoutesAllowed,
          featureKind: options.featureKind,
        },
      });

    const documentScope =
      options.retrievalScope?.mode === 'required'
        ? {
            mode: 'selected' as const,
            allowedDocIds: options.retrievalScope.requiredDocIds,
          }
        : undefined;

    for (const tool of options.tools) {
      const toolDef = resolveProviderSpecificTool?.(tool, model);
      if (toolDef) {
        if (toolDef[1]) {
          tools[toolDef[0]] = toolDef[1];
        }
        continue;
      }

      switch (tool) {
        case 'artifactRead': {
          tools.artifact_read = createArtifactReadTool(
            this.artifactRetrieval,
            options
          );
          break;
        }
        case 'artifactSearch': {
          tools.artifact_search = createArtifactSearchTool(
            this.artifactRetrieval,
            options
          );
          break;
        }
        case 'codeArtifact': {
          tools.code_artifact = createCodeArtifactTool(runPromptText);
          break;
        }
        case 'conversationSummary': {
          tools.conversation_summary = createConversationSummaryTool(
            options.session,
            runPromptText
          );
          break;
        }
        case 'docRead': {
          const getDoc = buildDocContentGetter(
            this.ac,
            this.docReader,
            this.models,
            documentScope
          );
          tools.doc_read = createDocReadTool(getDoc.bind(null, options));
          break;
        }
        case 'docCanvasRead': {
          const readCanvas = buildDocCanvasGetter(
            this.ac,
            this.docReader,
            this.models,
            documentScope
          );
          tools.doc_canvas_read = createDocCanvasReadTool(
            readCanvas.bind(null, options)
          );
          break;
        }
        case 'docSearch': {
          tools.doc_search = createDocSearchTool(
            buildDocumentSearch(this.retrieval, options, documentScope)
          );
          break;
        }
        case 'frontendGetEditorState': {
          if (this.delegated.getLease(options, 'frontend_get_editor_state')) {
            tools.frontend_get_editor_state = createFrontendEditorStateTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'frontendReadSelection': {
          if (this.delegated.getLease(options, 'frontend_read_selection')) {
            tools.frontend_read_selection = createFrontendSelectionTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'frontendReadNodes': {
          if (this.delegated.getLease(options, 'frontend_read_nodes')) {
            tools.frontend_read_nodes = createFrontendNodesTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'frontendSnapshotDocument': {
          if (this.delegated.getLease(options, 'frontend_snapshot_document')) {
            tools.frontend_snapshot_document = createFrontendSnapshotTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'docCreate': {
          const createDoc = buildDocCreateHandler(this.ac, this.docWriter);
          tools.doc_create = createDocCreateTool(createDoc.bind(null, options));
          break;
        }
        case 'docUpdate': {
          const updateDoc = buildDocUpdateHandler(this.ac, this.docWriter);
          tools.doc_update = createDocUpdateTool(updateDoc.bind(null, options));
          break;
        }
        case 'docAppend': {
          const appendDoc = buildDocAppendHandler(this.ac, this.docWriter);
          tools.doc_append = createDocAppendTool(appendDoc.bind(null, options));
          break;
        }
        case 'workspaceCreate': {
          const createWorkspace = buildWorkspaceCreateHandler(
            this.models,
            this.docWriter
          );
          tools.workspace_create = createWorkspaceCreateTool(
            createWorkspace.bind(null, options)
          );
          break;
        }
        case 'docStructured': {
          Object.assign(
            tools,
            createDocStructuredTools(
              { ac: this.ac, editor: this.docBlockEditor },
              options
            )
          );
          break;
        }
        case 'workspaceOrganize': {
          Object.assign(
            tools,
            createWorkspaceOrganizeTools(
              {
                ac: this.ac,
                organizer: this.docOrganizer,
                writer: this.docWriter,
              },
              options
            )
          );
          break;
        }
        case 'docUpdateMeta': {
          const updateDocMeta = buildDocUpdateMetaHandler(
            this.ac,
            this.docWriter
          );
          tools.doc_update_meta = createDocUpdateMetaTool(
            updateDocMeta.bind(null, options)
          );
          break;
        }
        case 'webSearch': {
          tools.web_search_exa = createExaSearchTool(this.config);
          tools.web_crawl_exa = createExaCrawlTool(this.config);
          break;
        }
        case 'docCompose': {
          tools.doc_compose = createDocComposeTool(runPromptText);
          break;
        }
        case 'sectionEdit': {
          tools.section_edit = createSectionEditTool(runPromptText);
          break;
        }
      }
    }

    return tools;
  }
}
