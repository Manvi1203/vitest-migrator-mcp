#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { classifyPackage } from './tools/classifier.js';
import { scaffoldConfig } from './tools/scaffolder.js';
import { applyCodemods } from './tools/codemods.js';
import { lookupError, recordLearning, loadKnowledgeBank } from './tools/knowledgeBank.js';
import { runVerification } from './tools/runner.js';

const server = new Server(
  {
    name: 'mcp-vitest-migrator',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Register list of available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'vitest_classify_package',
        description: 'Analyzes a package in the repository to determine its Vitest migration tier (simple unit vs emulator/integration vs multi-target platform aliases).',
        inputSchema: {
          type: 'object',
          properties: {
            packagePath: {
              type: 'string',
              description: 'Absolute path to the package directory (e.g. /path/to/firebase-js-sdk/packages/functions)'
            }
          },
          required: ['packagePath']
        }
      },
      {
        name: 'vitest_scaffold_config',
        description: 'Deterministically generates vitest.config.browser.mjs, test/setup.ts, and adds package.json test:vitest:browser script.',
        inputSchema: {
          type: 'object',
          properties: {
            packagePath: {
              type: 'string',
              description: 'Absolute path to the package directory'
            },
            tier: {
              type: 'string',
              enum: ['tier1', 'tier2', 'tier3'],
              description: 'Package classification tier from vitest_classify_package'
            }
          },
          required: ['packagePath']
        }
      },
      {
        name: 'vitest_apply_ast_codemods',
        description: 'Executes TypeScript AST transformations using ts-morph to fix isolated ESM type exports, Mocha timeouts, and require() calls.',
        inputSchema: {
          type: 'object',
          properties: {
            packagePath: {
              type: 'string',
              description: 'Absolute path to the package directory'
            }
          },
          required: ['packagePath']
        }
      },
      {
        name: 'vitest_lookup_knowledge_bank',
        description: 'Queries the permanent Knowledge Bank for known error signatures and returns diagnosis, root cause, and fix template.',
        inputSchema: {
          type: 'object',
          properties: {
            errorMessage: {
              type: 'string',
              description: 'The failing test error message or stack trace'
            }
          },
          required: ['errorMessage']
        }
      },
      {
        name: 'vitest_run_verification',
        description: 'Runs test verification for Vitest Browser, Vitest Node, or legacy Mocha Node / Karma Browser in the target package.',
        inputSchema: {
          type: 'object',
          properties: {
            packagePath: {
              type: 'string',
              description: 'Absolute path to the package directory'
            },
            target: {
              type: 'string',
              enum: ['vitest-browser', 'vitest-node', 'mocha-node', 'karma-browser'],
              description: 'The test runner target to execute (default: vitest-browser)'
            }
          },
          required: ['packagePath']
        }
      },
      {
        name: 'vitest_record_learning',
        description: 'Records a newly resolved error pattern, root cause, and fix template into the permanent Knowledge Bank.',
        inputSchema: {
          type: 'object',
          properties: {
            errorSignature: {
              type: 'string',
              description: 'Regex pattern or substring matching the error'
            },
            rootCause: {
              type: 'string',
              description: 'Why the error occurred in Vitest'
            },
            fixRule: {
              type: 'string',
              description: 'The rule/pattern used to fix it'
            },
            commentTemplate: {
              type: 'string',
              description: 'The mandatory code comment template'
            },
            name: {
              type: 'string',
              description: 'Short descriptive name for the rule'
            }
          },
          required: ['errorSignature', 'rootCause', 'fixRule']
        }
      },
      {
        name: 'vitest_list_knowledge_rules',
        description: 'Lists all currently known migration rules stored in the Knowledge Bank.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  };
});

// Handle tool executions
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'vitest_classify_package': {
        const pkgPath = String(args?.packagePath);
        const classification = classifyPackage(pkgPath);
        return {
          content: [{ type: 'text', text: JSON.stringify(classification, null, 2) }]
        };
      }

      case 'vitest_scaffold_config': {
        const pkgPath = String(args?.packagePath);
        const tier = args?.tier ? String(args.tier) : 'tier1';
        const scaffold = scaffoldConfig(pkgPath, tier);
        return {
          content: [{ type: 'text', text: JSON.stringify(scaffold, null, 2) }]
        };
      }

      case 'vitest_apply_ast_codemods': {
        const pkgPath = String(args?.packagePath);
        const codemod = applyCodemods(pkgPath);
        return {
          content: [{ type: 'text', text: JSON.stringify(codemod, null, 2) }]
        };
      }

      case 'vitest_lookup_knowledge_bank': {
        const errorMsg = String(args?.errorMessage);
        const match = lookupError(errorMsg);
        if (match) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ matched: true, rule: match }, null, 2) }]
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ matched: false, message: 'No matching pattern in Knowledge Bank' }, null, 2) }]
        };
      }

      case 'vitest_run_verification': {
        const pkgPath = String(args?.packagePath);
        const target = (args?.target as any) || 'vitest-browser';
        const run = await runVerification(pkgPath, target);
        return {
          content: [{ type: 'text', text: JSON.stringify(run, null, 2) }]
        };
      }

      case 'vitest_record_learning': {
        const sig = String(args?.errorSignature);
        const cause = String(args?.rootCause);
        const rule = String(args?.fixRule);
        const comment = args?.commentTemplate ? String(args.commentTemplate) : '';
        const ruleName = args?.name ? String(args.name) : undefined;
        const newRule = recordLearning(sig, cause, rule, comment, ruleName);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, savedRule: newRule }, null, 2) }]
        };
      }

      case 'vitest_list_knowledge_rules': {
        const bank = loadKnowledgeBank();
        return {
          content: [{ type: 'text', text: JSON.stringify(bank, null, 2) }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool error (${name}): ${error?.message || String(error)}` }]
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-vitest-migrator server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
