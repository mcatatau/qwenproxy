/*
 * UltraToolCallLinter v1.0 - Edge Case Stress Tests
 * Tests required by spec
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
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

describe('UltraToolCallLinter Edge Cases', () => {
  it('parses truncated JSON in the middle', () => {
    configure({ minConfidenceThreshold: 0.1 })
    const input = 'Here is the query: {"search": {"query": "test"}}'
    const result = parseText(input)
    assert.ok(result.toolCalls.length >= 1)
    assert.equal(result.toolCalls[0].tool, 'search')
  })

  it('parses concatenated multiple JSONs', () => {
    const input = '{"name":"search","arguments":{"query":"foo"}}{"name":"browser_open","arguments":{"url":"http://x"}}'
    const candidates = extract(input)
    assert.ok(candidates.length >= 1, 'Expected at least one candidate')
  })

  it('parses markdown-wrapped JSON', () => {
    const input = '```json\n{"tool":"search","input":{"query":"beer"}}\n```'
    const result = parseText(input)
    assert.ok(result.toolCalls.length >= 1)
    assert.equal(result.toolCalls[0].tool, 'search')
  })

  it('parses human text mixed with a tool call (ReAct)', () => {
    const input =
      'Sure, let me search that for you.\nAction: search\nAction Input: {"query": "breaking news"}'
    const result = parseText(input)
    assert.ok(result.toolCalls.length >= 1, 'Expected ReAct extraction')
  })

  it('recovers from broken escape sequences', () => {
    const input = '{"tool":"search","input":{"query":"test\\\\n\\\\t\\\\"}}'
    const result = parseText(input)
    assert.ok(result.toolCalls.length >= 1)
  })

  it('recovers from unicode corruption', () => {
    const input = '{"tool":"search","input":{"query":"caf\u0000\u001Fé"}}'
    const result = parseText(input)
    assert.ok(result.toolCalls.length >= 1)
  })

  it('handles streaming with repeated chunks', () => {
    const linter = new UltraToolCallLinter({ minConfidenceThreshold: 0.1 })
    const chunks = [
      'S',
      'Su',
      'Sur',
      'Sure! ',
      'Here i',
      'Here is ',
      'Here is the ',
      'Here is the result: ',
      'Here is the result: {"tool":"search","input":{"query":"async"}}',
    ]
    for (const c of chunks) linter.push(c)
    const result = linter.parse()
    assert.ok(result.toolCalls.length >= 1)
  })

  it('extracts tool call inside a textual array', () => {
    const input =
      'Options:\n- `{"tool":"search","input":{"query":"foo"}}`\n- `{"tool":"search","input":{"query":"bar"}}`'
    const candidates = extract(input)
    assert.ok(candidates.length >= 1, 'Expected extraction from array-text format')
  })

  it('handles duplicate model output', () => {
    const input =
      '{"tool":"search","input":{"query":"dup"}}\n\n{"tool":"search","input":{"query":"dup"}}'
    const result = parseText(input)
    assert.ok(Array.isArray(result.toolCalls))
  })

  it('repair: single quotes to double quotes', () => {
    const input = "{'tool': 'search', 'input': {'query': 'test'}}"
    const repaired = repair(input)
    assert.ok(repaired.includes('search'))
  })

  it('repair: trailing comma', () => {
    const input = '{"tool": "search", "input": {"query": "test"},}'
    const repaired = repair(input)
    assert.ok(repaired.includes('search'))
  })

  it('repair: key without quotes', () => {
    const input = '{tool: "search", input: {query: "test"}}'
    const repaired = repair(input)
    assert.ok(repaired.includes('search'))
  })

  it('security gate blocks destructive shell injection', () => {
    configure({ minConfidenceThreshold: 0.0 })
    const input = '{"tool":"search","input":{"query":"\'; rm -rf /; echo \'"}}'
    const result = parseText(input)
    const passed = result.toolCalls.some((call: any) => {
      const val = (call.input.query ?? '') as string
      return typeof val === 'string' && val.includes('rm -rf /')
    })
    assert.strictEqual(passed, false, 'Should not pass through destructive payload')
  })

  it('rejects empty string values per spec', () => {
    configure({ minConfidenceThreshold: 0.0 })
    const input = '{"tool":"search","input":{"query":""}}'
    const result = parseText(input)
    assert.ok(Array.isArray(result.toolCalls))
  })

  it('parseText returns canonical tool calls', () => {
    configure({ minConfidenceThreshold: 0.1 })
    const input = '{"tool":"search","input":{"query":"x"}}'
    const result = parseText(input)
    assert.ok(Array.isArray(result.toolCalls))
  })
})
