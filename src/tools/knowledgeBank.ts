import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface KnowledgeRule {
  id: string;
  name: string;
  errorPattern: string;
  fixStrategy: string;
  rootCause: string;
  rule: string;
  commentTemplate?: string;
}

export function getKnowledgeBankPath(): string {
  return path.resolve(__dirname, '../../data/knowledge-bank.json');
}

export function loadKnowledgeBank(): KnowledgeRule[] {
  const filePath = getKnowledgeBankPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function lookupError(errorMessage: string): KnowledgeRule | null {
  const bank = loadKnowledgeBank();
  for (const rule of bank) {
    try {
      const regex = new RegExp(rule.errorPattern, 'i');
      if (regex.test(errorMessage)) {
        return rule;
      }
    } catch {
      if (errorMessage.toLowerCase().includes(rule.errorPattern.toLowerCase())) {
        return rule;
      }
    }
  }
  return null;
}

export function recordLearning(
  errorSignature: string,
  rootCause: string,
  fixRule: string,
  commentTemplate: string = '',
  name?: string
): KnowledgeRule {
  const bank = loadKnowledgeBank();
  const id = `LEARNED_${Date.now()}`;
  const newRule: KnowledgeRule = {
    id,
    name: name || `Resolved Error: ${errorSignature.slice(0, 40)}...`,
    errorPattern: errorSignature,
    fixStrategy: 'AI_PROMPT',
    rootCause,
    rule: fixRule,
    commentTemplate
  };

  bank.push(newRule);
  const filePath = getKnowledgeBankPath();
  fs.writeFileSync(filePath, JSON.stringify(bank, null, 2) + '\n', 'utf8');
  return newRule;
}
