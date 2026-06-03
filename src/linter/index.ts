/*
 * UltraToolCallLinter v1.0
 * Main public API: composable 5-layer pipeline
 */

import type {
  CanonicalToolCall,
  ParserState,
  RawToolCandidate,
  ParseResult,
  ToolCallSource,
  SecurityViolation,
  ToolDefinition,
  ToolRegistry,
} from './types'

import { StreamingStateMachine } from './streaming-state-machine'
import { StructuralParser } from './structural-parser'
import { ToolExtractionEngine } from './extraction-engine'
import { GrammarRepairEngine, NormalizationEngine } from './repair-normalize'
import { SafetyGate } from './safety-gate'

export interface LinterConfig {
  registry?: ToolRegistry
  strictMode?: boolean
  enableSecurityGate?: boolean
  maxRecoveryAttempts?: number
  minConfidenceThreshold?: number
}

export class UltraToolCallLinter {
  private readonly streaming = new StreamingStateMachine()
  private readonly extractor = new ToolExtractionEngine()
  private readonly repairer = new GrammarRepairEngine()
  private readonly normalizer = new NormalizationEngine()
  private readonly gate = new SafetyGate()

  private registry: ToolRegistry = {}
  private strictMode: boolean = false
  private enableSecurityGate: boolean = true
  private maxRecoveryAttempts: number = 3
  private minConfidenceThreshold: number = 0.3

  constructor(config: LinterConfig = {}) {
    if (config.registry) this.registry = config.registry
    if (config.strictMode !== undefined) this.strictMode = config.strictMode
    if (config.enableSecurityGate !== undefined) this.enableSecurityGate = config.enableSecurityGate
    if (config.maxRecoveryAttempts !== undefined) this.maxRecoveryAttempts = config.maxRecoveryAttempts
    if (config.minConfidenceThreshold !== undefined) this.minConfidenceThreshold = config.minConfidenceThreshold

    if (this.registry) this.gate.registerRegistry(this.registry)
  }

  setRegistry(registry: ToolRegistry): void {
    this.registry = registry
    this.gate.registerRegistry(registry)
  }

  registerTool(name: string, def: ToolDefinition): void {
    this.gate.registerTool(name, def)
  }

  push(chunk: string): void {
    this.streaming.push(chunk)
  }

  parse(): ParseResult {
    const buffer = this.streaming.getBuffer()
    const errors: string[] = []

    const { candidates, extractionErrors } = this.extractor.extract(buffer)
    errors.push(...extractionErrors)

    const toolCalls: CanonicalToolCall[] = []
    let maxConfidence = 0

    for (const candidate of candidates) {
      const result = this.processCandidate(candidate, errors)
      const tc: CanonicalToolCall = {
        tool: result.tool,
        input: result.input,
        meta: result.meta ?? { source: candidate.source, confidence: 0, repaired: false },
      }
      if (tc.meta) {
        tc.meta.confidence = result.meta?.confidence ?? 0
        tc.meta.repaired = result.meta?.repaired ?? false
      } else {
        tc.meta = { source: candidate.source, confidence: result.meta?.confidence ?? 0, repaired: result.meta?.repaired ?? false }
      }
      toolCalls.push(tc)
      maxConfidence = Math.max(maxConfidence, tc.meta.confidence)
    }

    this.streaming.reset()

    return {
      text: buffer,
      toolCalls,
      errors,
      confidence: maxConfidence,
    }
  }

  parseText(text: string): ParseResult {
    this.streaming.reset()
    this.streaming.push(text)
    return this.parse()
  }

  parseObject(name: string, argumentsObj: Record<string, unknown>): ParseResult {
    const candidate: RawToolCandidate = {
      source: 'openai',
      raw: { name, arguments: argumentsObj },
      rawString: JSON.stringify({ name, arguments: argumentsObj }),
      confidence: 1,
    }

    const errors: string[] = []
    const processingResult = this.processCandidate(candidate, errors)

    return {
      text: '',
      toolCalls: [processingResult],
      errors,
      confidence: processingResult.meta?.confidence ?? 0,
    }
  }

  repair(input: string): string {
    const result = this.repairer.repair(input)
    if (!result.repaired) {
      const structural = new StructuralParser()
      const parsed = structural.parse(input, 'unknown')
      if (parsed.ast?.value) return JSON.stringify(parsed.ast.value, null, 0)
    }
    return JSON.stringify(result.value ?? {}, null, 0)
  }

  extract(input: string): RawToolCandidate[] {
    this.streaming.reset()
    const { candidates } = this.extractor.extract(input)
    return candidates
  }

  reset(): void {
    this.streaming.reset()
  }

  getState(): ParserState {
    return this.streaming.getState()
  }

  public processCandidate(
    candidate: RawToolCandidate,
    errors: string[]
  ): CanonicalToolCall {
    let confidence = candidate.confidence
    let repaired = false
    let currentRaw = { ...candidate.raw } as Record<string, unknown>

    const args = currentRaw.arguments ?? currentRaw.input ?? currentRaw.args

    if (typeof args === 'string' && args.trim().length > 0) {
      const repairResult = this.repairer.repair(args)
      if (repairResult.repaired) {
        currentRaw = { ...currentRaw, arguments: repairResult.value }
        repaired = true
        confidence = Math.min(confidence + repairResult.confidence * 0.1, 0.95)
        this.recoveryLog('string-args-repaired', candidate, repairResult.strategy)
      }
    }

    if (!currentRaw.tool && !currentRaw.name && !currentRaw.functionCall && !currentRaw.type) {
      const repairResult = this.repairer.repair(candidate.rawString)
      if (repairResult.repaired) {
        currentRaw = repairResult.value as Record<string, unknown>
        repaired = true
        confidence = Math.min(confidence + 0.05, 0.9)
        this.recoveryLog('synthetic-construction', candidate, repairResult.strategy)
      }
    }

    const { toolCall, warnings } = this.normalizer.normalize(
      { source: candidate.source, raw: currentRaw, rawString: candidate.rawString, confidence },
      repaired
    )

    if (warnings.length > 0) errors.push(...warnings)

    if (!toolCall.meta) {
      toolCall.meta = { source: candidate.source, confidence, repaired }
    } else {
      toolCall.meta.confidence = confidence
      toolCall.meta.repaired = repaired
    }

    if (this.enableSecurityGate) {
      const report = this.gate.validate(toolCall, candidate.source)
      toolCall.meta.confidence = Math.min(toolCall.meta.confidence, report.confidence)

      if (!report.isValid && !this.strictMode) {
        const recoveryResult = this.attemptRecovery(candidate, report.violations, toolCall, errors)
        if (recoveryResult) return recoveryResult
      }

      errors.push(...report.warnings)
    }

    return toolCall
  }

  private attemptRecovery(
    candidate: RawToolCandidate,
    violations: SecurityViolation[],
    failedCall: CanonicalToolCall,
    errors: string[]
  ): CanonicalToolCall | null {
    let attempt = 0
    const currentCall: CanonicalToolCall = {
      tool: failedCall.tool,
      input: { ...failedCall.input },
      meta: failedCall.meta ? { ...failedCall.meta } : undefined,
    }

    while (attempt < this.maxRecoveryAttempts) {
      for (const v of violations) {
        if (v.field === 'input') {
          currentCall.input = {}
          errors.push(`Recovered: cleared entire input`)
          break
        }
        if (v.field in currentCall.input) {
          delete currentCall.input[v.field]
          errors.push(`Recovered: removed invalid field "${v.field}"`)
        }
      }

      const report = this.gate.validate(currentCall, candidate.source)
      if (report.isValid) {
        if (currentCall.meta) {
          currentCall.meta.repaired = true
          currentCall.meta.confidence = Math.max(0.3, report.confidence)
        }
        return currentCall
      }

      attempt++
    }

    return null
  }

  private recoveryLog(event: string, candidate: RawToolCandidate, strategy: string): void {
    if (process.env.DEBUG_ULTRA_LINTER === 'true') {
      console.debug(`[UltraToolCallLinter] recovery ${event}: strategy=${strategy}, source=${candidate.source}`)
    }
  }
}
