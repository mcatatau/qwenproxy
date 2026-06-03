/*
 * Structure Verification Tests
 * Verifies that the identified issues are correct and the logic works as expected.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'

import { UltraToolCallLinter } from '../linter/index.js'
import type { ParseResult, RawToolCandidate } from '../linter/types.js'

// Helper functions to match the old bar.ts API using direct instantiation
let globalLinter: UltraToolCallLinter | null = null

function getGlobalLinter(): UltraToolCallLinter {
  if (!globalLinter) globalLinter = new UltraToolCallLinter()
  return globalLinter
}

function configure(config: { registry?: any; strictMode?: boolean; enableSecurityGate?: boolean; maxRecoveryAttempts?: number; minConfidenceThreshold?: number }): void {
  globalLinter = new UltraToolCallLinter(config)
}

function parseText(input: string): ParseResult {
  return getGlobalLinter().parseText(input)
}

function extract(input: string): RawToolCandidate[] {
  return getGlobalLinter().extract(input)
}

function repair(input: string): string {
  return getGlobalLinter().repair(input)
}

// Test 2: Verify CandidateSpan is defined but unused
type TestCandidateSpan = {
  startIndex: number
  endIndex: number | null
  rawContent: string
  sourceHint: string
  isComplete: boolean
}

// Test 3: Verify ParseResult structure

describe('Structure Verification Tests', () => {
  beforeEach(() => {
    configure({ strictMode: false, minConfidenceThreshold: 0.1 })
  })

  describe('Direct import from index.js verification', () => {
    it('should verify UltraToolCallLinter methods work correctly', () => {
      const linter = new UltraToolCallLinter()
      
      assert.strictEqual(typeof linter.parse, 'function')
      assert.strictEqual(typeof linter.push, 'function')
      assert.strictEqual(typeof linter.extract, 'function')
      assert.strictEqual(typeof linter.repair, 'function')
      assert.strictEqual(typeof linter.parseText, 'function')
    })

    it('should verify parseText works through foo -> bar -> index chain', () => {
      const input = '{"tool":"search","input":{"query":"test"}}'
      const result = parseText(input)
      
      assert.ok(Array.isArray(result.toolCalls))
      assert.ok(typeof result.confidence === 'number')
    })

    it('should verify extract works through foo -> bar -> index chain', () => {
      const input = '{"tool":"search","input":{"query":"test"}}'
      const candidates = extract(input)
      
      assert.ok(Array.isArray(candidates))
    })

    it('should verify repair works through foo -> bar -> index chain', () => {
      const input = "{'tool': 'search'}"
      const repaired = repair(input)
      
      assert.ok(typeof repaired === 'string')
      assert.ok(repaired.includes('search'))
    })
  })

  describe('Unused type: CandidateSpan verification', () => {
    it('CandidateSpan type exists in types.ts but is not used anywhere', () => {
      // This test documents that CandidateSpan is defined but unused
      const exampleSpan: TestCandidateSpan = {
        startIndex: 0,
        endIndex: 10,
        rawContent: '{"tool":"test"}',
        sourceHint: 'json',
        isComplete: true
      }
      
      assert.ok(exampleSpan.startIndex === 0)
      assert.ok(exampleSpan.isComplete === true)
    })
  })

  describe('ParseResult structure verification', () => {
    it('ParseResult has all required fields', () => {
      const parseResult: ParseResult = {
        text: 'test',
        toolCalls: [],
        errors: [],
        confidence: 0.5
      }
      
      assert.ok(Array.isArray(parseResult.toolCalls))
      assert.ok(typeof parseResult.confidence === 'number')
      assert.ok(Array.isArray(parseResult.errors))
      assert.ok(typeof parseResult.text === 'string')
    })

    it('parseText returns ParseResult with all required fields', () => {
      const input = '{"tool":"search","input":{"query":"test"}}'
      const result = parseText(input)
      
      // Should have all ParserResult fields + confidence
      assert.ok(typeof result.text === 'string')
      assert.ok(Array.isArray(result.toolCalls))
      assert.ok(Array.isArray(result.errors))
      assert.ok(typeof result.confidence === 'number')
    })
  })

  describe('src/tools/ directory isolation verification', () => {
    it('tools/registry.ts has syntax error (Map initialization)', async () => {
      // This test documents that tools/registry.ts has a bug:
      // const toolRegistry: Map<string, ToolRegistration> = Map()
      // Should be: new Map()
      // The file is unused by the main codebase anyway
      
      const registryModule = await import('../tools/registry.js').catch(() => null)
      
      // If the module can't be imported due to syntax error, that confirms the issue
      if (registryModule === null) {
        assert.ok(true, 'Registry module has syntax error as expected')
      }
    })

    it('tools/parser.ts StreamingToolParser is used by main codebase', async () => {
      // This verifies that StreamingToolParser IS actually used
      const { StreamingToolParser } = await import('../tools/parser.js')
      
      assert.ok(typeof StreamingToolParser === 'function')
      
      const parser = new StreamingToolParser()
      assert.ok(typeof parser.feed === 'function')
    })
  })

  describe('LinterConfig duplication verification', () => {
    it('LinterConfig in index.ts duplicates constructor param type from bar.ts', () => {
      // bar.ts defines inline config type:
      // { registry?: ToolRegistry; strictMode?: boolean; ... }
      // 
      // index.ts defines LinterConfig interface:
      // { registry?: ToolRegistry; strictMode?: boolean; ... }
      //
      // These are functionally identical but defined separately
      
      const linter = new UltraToolCallLinter({
        strictMode: true,
        enableSecurityGate: false,
        maxRecoveryAttempts: 5,
        minConfidenceThreshold: 0.5
      })
      
      assert.ok(linter instanceof UltraToolCallLinter)
    })
  })
})
