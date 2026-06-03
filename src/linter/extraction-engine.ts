/*
 * Layer 3: Tool Extraction Engine (Multi-Format)
 */

import type { ToolCallSource, RawToolCandidate, SecurityViolation } from './types'
import { StructuralParser } from './structural-parser'

export interface ExtractionResult {
  candidates: RawToolCandidate[]
  sourceHint: ToolCallSource
  extractionErrors: string[]
}

export class ToolExtractionEngine {
  private parser: StructuralParser

  constructor() {
    this.parser = new StructuralParser()
  }

  extract(input: string): ExtractionResult {
    const candidates: RawToolCandidate[] = []
    const errors: string[] = []
    let sourceHint: ToolCallSource = this.detectSourceHint(input)

    const jsonCandidates = this.extractJsonObjects(input)
    for (const candidate of jsonCandidates) {
      const parsed = this.tryParseJson(candidate.raw)
      if (parsed) {
        candidates.push({
          source: candidate.sourceHint,
          raw: parsed,
          rawString: candidate.raw,
          confidence: this.calculateJsonConfidence(parsed, candidate.sourceHint),
        })
      }
    }

    if (candidates.length === 0) {
      const reactCandidates = this.extractReAct(input)
      candidates.push(
        ...reactCandidates.map(c => ({
          source: 'react' as ToolCallSource,
          raw: c.raw,
          rawString: c.rawString,
          confidence: 0.8,
        }))
      )
    }

    if (candidates.length === 0) {
      const gemini = this.extractGemini(input)
      if (gemini) {
        candidates.push({
          source: 'gemini' as ToolCallSource,
          raw: gemini,
          rawString: JSON.stringify(gemini),
          confidence: 0.85,
        })
      }
    }

    return { candidates, sourceHint, extractionErrors: errors }
  }

  private extractJsonObjects(text: string): Array<{ raw: string; sourceHint: ToolCallSource }> {
    const results: Array<{ raw: string; sourceHint: ToolCallSource }> = []
    const markupCleaned = this.stripMarkup(text)
    const jsonSpans = StructuralParser.extractJsonFromText(markupCleaned)

    for (const span of jsonSpans) {
      const sourceHint = this.detectSourceHint(span)
      results.push({ raw: span, sourceHint })
    }

    if (results.length === 0) {
      const funcMatch = markupCleaned.match(/call_function\s*\(\s*'(\w+)'\s*,\s*(\{[\s\S]*\})\s*\)/i)
      if (funcMatch) {
        results.push({ raw: `{"name":"${funcMatch[1]}","arguments":${funcMatch[2]}}`, sourceHint: 'openai' })
      }
    }

    return results
  }

  private extractReAct(text: string): Array<{ raw: Record<string, unknown>; rawString: string }> {
    const results: Array<{ raw: Record<string, unknown>; rawString: string }> = []
    const patterns = [
      /Action:\s*(\w+)\s*\n?\s*Action Input:\s*(\{[\s\S]*?)(?=\n\s*\n|\n\s*Observation|\n\s*Final Answer|$)/i,
      /Action:\s*(\w+)\s+Action Input:\s*(\{[\s\S]*)/i,
      /\*\*Action\*\*:\s*(\w+)\s*\n?\s*\*\*Action Input\*\*:\s*(\{[\s\S]*?)(?=\n\s*\n|\n\s*Observation|\n\s*Final Answer|$)/i,
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) {
        let actionInputStr = match[2].trim()
        actionInputStr = actionInputStr.replace(/\n\s*Observation.*$/is, '').trim()
        results.push({
          raw: { name: match[1], arguments: this.safeParse(actionInputStr) || {} },
          rawString: match[0],
        })
        break
      }
    }

    return results
  }

  private extractGemini(text: string): Record<string, unknown> | null {
    const patterns = [
      /functionCall\s*[:=]\s*\{\s*name\s*[:=]\s*['"]([^'"]+)['"]\s*,\s*args\s*[:=]\s*(\{[\s\S]*\})\s*\}/i,
      /"functionCall"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/i,
    ]
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) return { name: match[1], arguments: this.safeParse(match[2]) || {} }
    }
    return null
  }

  private stripMarkup(text: string): string {
    return text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .replace(/<function_calls>/gi, '')
      .replace(/<\/function_calls>/gi, '')
      .trim()
  }

  private detectSourceHint(text: string): ToolCallSource {
    const t = this.stripMarkup(text)
    if (/\btool_use\b/.test(t) || /type:\s*['"]?tool_use/i.test(t)) return 'claude'
    if (/\bfunctionCall\b/.test(t) || /"functionCall"/.test(t)) return 'gemini'
    if (/\barguments\b/.test(t) && /\bname\b/.test(t)) return 'openai'
    if (/Action:\s*\w+\s*\n?Action Input:/i.test(t)) return 'react'
    return 'unknown'
  }

  private tryParseJson(raw: string): Record<string, unknown> | null {
    try { return JSON.parse(raw) } catch {
      const result = this.parser.parse(raw, 'unknown')
      return (result.ast?.value as Record<string, unknown>) ?? null
    }
  }

  private safeParse(str: string): Record<string, unknown> | null {
    try { return JSON.parse(str) } catch {
      const result = this.parser.parse(str, 'unknown')
      return (result.ast?.value as Record<string, unknown>) ?? null
    }
  }

  private calculateJsonConfidence(parsed: Record<string, unknown>, source: ToolCallSource): number {
    let conf = 0.5
    if (parsed.name) conf += 0.15
    if (parsed.arguments && typeof parsed.arguments === 'object') conf += 0.15
    if (parsed.input && typeof parsed.input === 'object') conf += 0.1
    if (parsed.tool) conf += 0.1
    if (parsed.args && typeof parsed.args === 'object') conf += 0.1
    if (typeof parsed.arguments === 'string') conf -= 0.2
    if (typeof parsed.input === 'string') conf -= 0.2
    return Math.min(0.95, Math.max(0.3, conf))
  }
}
