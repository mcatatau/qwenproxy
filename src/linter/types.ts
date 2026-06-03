/*
 * File: types.ts
 * Project: qwenproxy
 * UltraToolCallLinter - Core type definitions
 */

export type ToolCallSource = 'openai' | 'claude' | 'gemini' | 'react' | 'unknown'

export interface CanonicalToolCall {
  tool: string
  input: Record<string, unknown>
  meta?: {
    source: ToolCallSource
    confidence: number
    repaired: boolean
  }
}

export interface ParserState {
  buffer: string
  insideCodeBlock: boolean
  braceDepth: number
  bracketDepth: number
  inString: boolean
  escapeNext: boolean
  potentialToolStart: boolean
}

export interface PartialASTNode {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown'
  value?: unknown
  raw: string
  confidence: number
  children?: PartialASTNode[]
}

export interface RawToolCandidate {
  source: ToolCallSource
  raw: Record<string, unknown>
  rawString: string
  confidence: number
}

export interface ParseResult {
  text: string
  toolCalls: CanonicalToolCall[]
  errors: string[]
  confidence: number
}

export interface SecurityViolation {
  type: 'shell_injection' | 'filesystem_access' | 'ssrf' | 'prompt_injection' | 'encoded_payload'
  field: string
  value: string
  detail: string
}

export interface ToolRegistry {
  [name: string]: {
    name: string
    description: string
    parameters: Record<string, unknown>
    required?: string[]
    strict?: boolean
  }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  required?: string[]
  strict?: boolean
}
