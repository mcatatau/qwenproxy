/*
 * Layer 5: Validation + Safety Gate
 */

import type { CanonicalToolCall, ToolCallSource, SecurityViolation, ToolDefinition } from './types'

export interface ValidationReport {
  isValid: boolean
  violations: SecurityViolation[]
  confidence: number
  warnings: string[]
  canExecute: boolean
}

export class SafetyGate {
  private registry: Record<string, ToolDefinition> = {}

  private readonly dangerousPatterns = [
    /\$\(/g, /\$\{/g, /`/g,
    /;\s*(rm|cat|ls|whoami|id|curl|wget|nc|ncat)\b/gi,
    /\|\s*(sh|bash|zsh|csh|python|node|perl)\b/gi,
    /&&\s*(rm|cat|whoami)/gi,
    /exec\s*\(/gi, /eval\s*\(/gi, /\beval\s*\(/gi,
    /system\s*\(/gi, /passthru\s*\(/gi, /shell_exec\s*\(/gi,
    /proc\s*\(/gi, /subprocess\s*\./gi, /spawn\s*\(/gi,
    /execSync\s*\(/gi, /child_process/gi,
  ]

  private readonly ssrfPatterns = [
    /http[s]?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|localhost|169\.254\.\d+\.\d+|metadata\.google)/i,
    /gopher:\/\//i, /file:\/\//i, /ftp:\/\//i,
    /\b7777\b|\b9090\b|\b3389\b|\b22\b/,
  ]

  private readonly promptInjectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/i, /disregard\s+(all\s+)?previous/i,
    /jailbreak/i, /you\s+are\s+now\s+DAN/i, /pretend\s+you\s+are/i,
    /act\s+as\s+if/i, /your\s+new\s+instructions/i, /developer\s+mode/i,
    /list\s+all\s+files/i, /cat\s+\/etc/i,
  ]

  private readonly encodedPatterns = [
    /%3Cscript/i, /javascript:/i, /\\x[0-9a-fA-F]{2}/, /\\u[0-9a-fA-F]{4}/,
    /&#[0-9]+;/i, /data:text\/html/i,
  ]

  registerTool(name: string, definition: Partial<ToolDefinition>): void {
    this.registry[name] = {
      name,
      description: definition.description ?? '',
      parameters: definition.parameters ?? {},
      required: definition.required ?? [],
      strict: definition.strict ?? false,
    }
  }

  registerRegistry(registry: Record<string, ToolDefinition>): void {
    this.registry = registry
  }

  validate(call: CanonicalToolCall, sourceHint: ToolCallSource): ValidationReport {
    const violations: SecurityViolation[] = []
    const warnings: string[] = []
    let confidence = call.meta?.confidence ?? 0.5

    const semanticResult = this.validateSemantics(call)
    violations.push(...semanticResult.violations)
    warnings.push(...semanticResult.warnings)
    confidence = Math.min(confidence, semanticResult.confidence)

    const securityResult = this.validateSecurity(call)
    violations.push(...securityResult.violations)
    warnings.push(...securityResult.warnings)

    warnings.push(...this.validateTypes(call).warnings)

    const registryResult = this.validateRegistry(call)
    warnings.push(...registryResult.warnings)
    confidence = Math.min(confidence, registryResult.confidence)

    const hasBlockingViolations = violations.some(v =>
      v.type === 'shell_injection' || v.type === 'filesystem_access' || v.type === 'prompt_injection'
    )

    confidence = Math.max(0.1, Math.min(1.0, confidence))

    return {
      isValid: !hasBlockingViolations && violations.length === 0,
      violations,
      confidence,
      warnings,
      canExecute: !hasBlockingViolations,
    }
  }

  private validateSemantics(call: CanonicalToolCall): { violations: SecurityViolation[]; warnings: string[]; confidence: number } {
    const violations: SecurityViolation[] = []
    const warnings: string[] = []
    let confidence = 1.0

    if (!call.tool || call.tool.trim().length === 0) {
      violations.push({ type: 'shell_injection', field: 'tool', value: String(call.tool), detail: 'Tool name is empty' })
      confidence -= 0.5
    }
    if (typeof call.tool !== 'string') {
      violations.push({ type: 'shell_injection', field: 'tool', value: String(call.tool), detail: 'Tool name is not a string' })
      confidence -= 0.4
    }
    if (call.tool && /[ /\\]/.test(call.tool)) {
      warnings.push(`Suspicious tool name: "${call.tool}"`)
      confidence -= 0.1
    }
    if (typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
      violations.push({ type: 'shell_injection', field: 'input', value: String(call.input), detail: 'Input is not a valid object' })
      confidence -= 0.4
    }
    for (const [key, value] of Object.entries(call.input)) {
      if (typeof value === 'string' && value.trim().length === 0) {
        warnings.push(`Empty string parameter: "${key}"`)
        confidence -= 0.05
      }
    }

    return { violations, warnings, confidence: Math.max(0, confidence) }
  }

  private validateSecurity(call: CanonicalToolCall): { violations: SecurityViolation[]; warnings: string[] } {
    const violations: SecurityViolation[] = []
    const warnings: string[] = []
    const inputString = JSON.stringify(call.input)

    for (const pattern of this.dangerousPatterns) {
      pattern.lastIndex = 0
      if (pattern.test(inputString)) {
        violations.push({ type: 'shell_injection', field: 'input', value: inputString.slice(0, 100), detail: `Potential shell injection pattern detected` })
        break
      }
    }

    for (const field of Object.values(call.input)) {
      const str = String(field ?? '')
      for (const pattern of this.ssrfPatterns) {
        pattern.lastIndex = 0
        if (pattern.test(str)) {
          violations.push({ type: 'ssrf', field: 'input', value: str.slice(0, 200), detail: `SSRF pattern detected` })
          break
        }
      }
    }

    const combinedInput = Object.values(call.input)
      .map(v => typeof v === 'string' ? v : JSON.stringify(v))
      .join(' ')

    for (const pattern of this.promptInjectionPatterns) {
      pattern.lastIndex = 0
      if (pattern.test(combinedInput)) {
        violations.push({ type: 'prompt_injection', field: 'input', value: combinedInput.slice(0, 200), detail: `Prompt injection pattern detected` })
        break
      }
    }

    for (const pattern of this.encodedPatterns) {
      pattern.lastIndex = 0
      if (pattern.test(combinedInput)) {
        violations.push({ type: 'encoded_payload', field: 'input', value: combinedInput.slice(0, 200), detail: `Encoded payload detected` })
        break
      }
    }

    return { violations, warnings }
  }

  private validateTypes(call: CanonicalToolCall): { warnings: string[] } {
    const warnings: string[] = []
    for (const [key, value] of Object.entries(call.input)) {
      const type = typeof value
      if (value !== null && typeof value !== 'undefined' && typeof value !== 'function' && typeof value !== 'symbol' && typeof value !== 'bigint' && typeof value !== 'object') {
        warnings.push(`Unexpected type for parameter "${key}": ${type}`)
      }
    }
    return { warnings }
  }

  private validateRegistry(call: CanonicalToolCall): { warnings: string[]; confidence: number } {
    const warnings: string[] = []
    let confidence = 1.0

    const toolDef = this.registry[call.tool]
    if (!toolDef) {
      warnings.push(`Tool "${call.tool}" not found in registry`)
      confidence -= 0.3
      return { warnings, confidence: Math.max(0.1, confidence) }
    }

    if (toolDef.required && Array.isArray(toolDef.required)) {
      for (const requiredField of toolDef.required) {
        if (!(requiredField in call.input) || call.input[requiredField] === undefined) {
          warnings.push(`Missing required field: "${requiredField}" for tool "${call.tool}"`)
          confidence -= 0.2
        }
      }
    }

    if (toolDef.strict && toolDef.parameters) {
      for (const [param, expectedType] of Object.entries(toolDef.parameters)) {
        if (param in call.input && call.input[param] !== undefined) {
          const actualType = typeof call.input[param]
          if (actualType !== String(expectedType).toLowerCase()) {
            warnings.push(`Type mismatch for "${param}": expected ${String(expectedType)}, got ${actualType}`)
            confidence -= 0.1
          }
        }
      }
    }

    return { warnings, confidence: Math.max(0.1, confidence) }
  }
}
