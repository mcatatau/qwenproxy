/*
 * Layer 4: Normalization + Repair Engine
 */

import type { CanonicalToolCall, ToolCallSource, RawToolCandidate } from './types'
import { StructuralParser } from './structural-parser'

export interface RepairResult {
  repaired: boolean
  value: unknown
  confidence: number
  strategy: string
}

export interface NormalizationResult {
  toolCall: CanonicalToolCall
  warnings: string[]
}

export class GrammarRepairEngine {
  private parser: StructuralParser = new StructuralParser()

  repair(input: string): RepairResult {
    const strategies: Array<{ name: string; attempt: () => unknown | undefined }> = [
      { name: 'json_strip_repair', attempt: () => this.tryStripRepair(input) },
      { name: 'quote_fix', attempt: () => this.tryQuoteFix(input) },
      { name: 'trailing_comma_fix', attempt: () => this.tryTrailingCommaFix(input) },
      { name: 'braces_balance', attempt: () => this.tryBraceBalance(input) },
      { name: 'key_unquote', attempt: () => this.tryKeyUnquote(input) },
      { name: 'parser_resync', attempt: () => this.tryParserResync(input) },
      { name: 'synthetic_construction', attempt: () => this.trySyntheticConstruction(input) },
      { name: 'json_parse_last_resort', attempt: () => this.tryJsonParseLastResort(input) },
    ]

    for (const strategy of strategies) {
      try {
        const result = strategy.attempt()
        if (result !== undefined && result !== null) {
          return { repaired: true, value: result, confidence: this.inferConfidence(strategy.name), strategy: strategy.name }
        }
      } catch { continue }
    }

    return { repaired: false, value: null, confidence: 0, strategy: 'failed' }
  }

  private tryStripRepair(input: string): Record<string, unknown> | undefined {
    const stripped = input
      .replace(/```json\s*/gi, '')
      .replace(/```\s*$/gm, '')
      .replace(/```\s*/gi, '')
      .replace(/^\s*[\[\{]\s*$/, '')
      .replace(/[\u0000-\u001F]+/g, ' ')
      .trim()

    if (stripped === input) return undefined

    try {
      const parsed = JSON.parse(stripped)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch { /* not parseable */ }

    return undefined
  }

  private tryQuoteFix(input: string): Record<string, unknown> | undefined {
    let fixed = input
    const quoteCount = (fixed.match(/"/g) ?? []).length
    if (quoteCount % 2 !== 0) fixed += '"'

    if (/['"]/.test(fixed) && /(^|[,:{\s])'[a-z]/i.test(fixed)) {
      fixed = fixed.replace(/'/g, '"')
    }

    try {
      const parsed = JSON.parse(fixed)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch { /* not parseable */ }

    return undefined
  }

  private tryTrailingCommaFix(input: string): Record<string, unknown> | undefined {
    let fixed = input.replace(/,(\s*[}\]])/g, '$1')
    if (fixed === input) return undefined
    try {
      const parsed = JSON.parse(fixed)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch { /* not parseable */ }
    return undefined
  }

  private tryBraceBalance(input: string): Record<string, unknown> | undefined {
    let depth = 0, start = -1
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '{') { if (depth === 0) start = i; depth++ }
      else if (input[i] === '}') {
        depth--
        if (depth === 0 && start !== -1) {
          try { const parsed = JSON.parse(input.slice(start, i + 1)); if (typeof parsed === 'object' && parsed !== null) return parsed }
          catch { /* not parseable */ }
        }
      }
    }
    return undefined
  }

  private tryKeyUnquote(input: string): Record<string, unknown> | undefined {
    if (!/^\{[\s]*[a-zA-Z_]/m.test(input)) return undefined
    let fixed = input.replace(/([,{]\s*)([a-zA-Z_][a-zA-Z0-9_\-]*)(\s*:)/g, '$1"$2"$3')
    try {
      const parsed = JSON.parse(fixed)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch { /* not parseable */ }
    return undefined
  }

  private tryParserResync(input: string): Record<string, unknown> | undefined {
    const result = this.parser.parse(input, 'unknown')
    if (result.ast && result.confidence >= 0.5 && result.ast.type === 'object') {
      return result.ast.value as Record<string, unknown>
    }
    return undefined
  }

  private trySyntheticConstruction(input: string): Record<string, unknown> | undefined {
    const nameMatch = input.match(/"name"\s*:\s*"([^"]+)"|name\s*[:=]\s*['"]?(\w+)['"]?/i)
    const toolMatch = input.match(/"tool"\s*:\s*"([^"]+)"|tool\s*[:=]\s*['"]?(\w+)['"]?/i)
    const funcNameMatch = input.match(/"functionCall"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/)
    const toolUseMatch = input.match(/"type"\s*:\s*"tool_use"[\s\S]*?"name"\s*:\s*"([^"]+)"/)

    if (nameMatch || funcNameMatch || toolUseMatch || toolMatch) {
      const toolName = nameMatch?.[1] ?? nameMatch?.[2] ?? funcNameMatch?.[1] ?? toolUseMatch?.[1] ?? toolMatch?.[1] ?? toolMatch?.[2] ?? 'unknown'
      const inputBlock = this.extractInputBlock(input)
      return { tool: toolName, input: inputBlock ?? {} }
    }

    return undefined
  }

  private tryJsonParseLastResort(input: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch { /* last resort failed */ }
    return undefined
  }

  private extractInputBlock(input: string): Record<string, unknown> | undefined {
    const argsMatch = input.match(new RegExp('"arguments"\\s*:\\s*(\\{[\\s\\S]*\\})', 'i'))
    const inputMatch = input.match(new RegExp('"input"\\s*:\\s*(\\{[\\s\\S]*\\})', 'i'))
    const argsMatch2 = input.match(new RegExp('"args"\\s*:\\s*(\\{[\\s\\S]*\\})', 'i'))
    const funcArgsMatch = input.match(/"functionCall"\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/)
    const toolInputMatch = input.match(/"type"\s*:\s*"tool_use"[\s\S]*?"input"\s*:\s*(\{[\s\S]*?\})\s*\}/)

    const target = argsMatch?.[1] ?? inputMatch?.[1] ?? argsMatch2?.[1] ?? funcArgsMatch?.[1] ?? toolInputMatch?.[1]
    if (target) {
      try { return JSON.parse(target) } catch { return undefined }
    }
    return undefined
  }

  private inferConfidence(strategy: string): number {
    const map: Record<string, number> = {
      json_strip_repair: 0.95, json_parse_last_resort: 0.9, quote_fix: 0.85,
      trailing_comma_fix: 0.85, braces_balance: 0.8, key_unquote: 0.8,
      parser_resync: 0.7, synthetic_construction: 0.6,
    }
    return map[strategy] ?? 0.5
  }
}

export class NormalizationEngine {
  normalize(candidate: RawToolCandidate, repaired = false): NormalizationResult {
    const raw = candidate.raw
    const warnings: string[] = []
    let toolName = 'unknown'
    let inputData: Record<string, unknown> = {}

    const asRecord = raw as Record<string, unknown>

    if (asRecord.tool) {
      toolName = String(asRecord.tool)
      inputData = this.normalizeInput(asRecord.arguments ?? asRecord.input ?? asRecord.args ?? {}, warnings)
    } else if (asRecord.name) {
      toolName = String(asRecord.name)
      if (asRecord.functionCall && typeof asRecord.functionCall === 'object') {
        const fc = asRecord.functionCall as Record<string, unknown>
        toolName = String(fc.name ?? toolName)
        inputData = this.normalizeInput(fc.args ?? fc.input ?? {}, warnings)
      } else if (asRecord.type === 'tool_use') {
        inputData = this.normalizeInput(asRecord.input ?? asRecord.args ?? {}, warnings)
      } else if (asRecord.arguments !== undefined) {
        inputData = this.normalizeInput(asRecord.arguments, warnings)
      } else if (asRecord.input !== undefined) {
        inputData = this.normalizeInput(asRecord.input, warnings)
      } else if (asRecord.args !== undefined) {
        inputData = this.normalizeInput(asRecord.args, warnings)
      } else if (asRecord.action) {
        toolName = String(asRecord.action)
        inputData = this.normalizeInput(asRecord.input ?? asRecord.arguments ?? {}, warnings)
      } else {
        warnings.push('No tool name found in candidate')
      }
    } else {
      const keys = Object.keys(asRecord)
      warnings.push('No tool name found in candidate')
      if (keys.length === 1 && typeof asRecord[keys[0]] === 'object' && asRecord[keys[0]] !== null && !Array.isArray(asRecord[keys[0]])) {
        toolName = String(keys[0])
        inputData = this.normalizeInput(asRecord[keys[0]], warnings)
      }
    }

    const toolCall: CanonicalToolCall = {
      tool: toolName,
      input: inputData,
      meta: { source: candidate.source, confidence: candidate.confidence, repaired },
    }

    return { toolCall, warnings }
  }

  private normalizeInput(input: unknown, warnings: string[]): Record<string, unknown> {
    if (typeof input === 'string') {
      return this.parseInputString(input, warnings)
    }
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      return input as Record<string, unknown>
    }
    warnings.push(`Input was not a valid object: ${typeof input}`)
    return {}
  }

  private parseInputString(input: string, warnings: string[]): Record<string, unknown> {
    if (!input || input.trim().length === 0) { warnings.push('Empty input string'); return {} }
    try {
      const parsed = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* not parseable */ }
    warnings.push('Input string was not valid JSON, wrapping')
    return { raw_input: input }
  }
}
