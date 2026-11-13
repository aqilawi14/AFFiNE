import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DocWriter } from '../../../core/doc';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('WorkspaceCreateTool');

export const buildWorkspaceCreateHandler = (
  models: Models,
  writer: DocWriter
) => {
  return async (options: CopilotChatOptions, name: string) => {
    if (!options?.user) {
      return toolError('Workspace Create Failed', 'Missing user context');
    }

    const sanitizedName = name.replace(/[\r\n]+/g, ' ').trim();
    if (!sanitizedName) {
      return toolError('Workspace Create Failed', 'Name cannot be empty');
    }

    const workspace = await models.workspace.create(options.user);
    await writer.initWorkspaceRootDoc(
      workspace.id,
      sanitizedName,
      options.user
    );

    return {
      success: true,
      workspaceId: workspace.id,
      name: sanitizedName,
      message: `Workspace "${sanitizedName}" created successfully. The user can switch to it from the workspace list.`,
    };
  };
};

export const createWorkspaceCreateTool = (
  createWorkspace: (name: string) => Promise<object>
) => {
  return defineTool({
    description:
      'Create a new, empty workspace owned by the current user. Only use it when the user explicitly confirmed they want a NEW workspace (not a new document). Documents cannot be created in the new workspace from this chat; tell the user to switch to it from the workspace list.',
    inputSchema: z.object({
      name: z.string().min(1).describe('The name of the new workspace'),
    }),
    execute: async ({ name }) => {
      try {
        return await createWorkspace(name);
      } catch (err: any) {
        logger.error(`Failed to create workspace: ${name}`, err);
        return toolError('Workspace Create Failed', err.message);
      }
    },
  });
};
